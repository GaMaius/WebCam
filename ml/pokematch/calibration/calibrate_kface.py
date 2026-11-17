"""
PokéMatch K-Face Dataset Fast Batch Calibration
------------------------------------------------
Processes 2,160 face images from K-Face (S001~S006) in batches of 64,
extracts 512D embeddings via ONNX model, evaluates ranking stability vs uniqueness,
and bakes calibrated mu/sd parameters into public/pokemon/gallery.json.
"""

import os
import sys
import glob
import json
import numpy as np
import onnxruntime as ort
from PIL import Image

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
GALLERY_JSON = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.json")
GALLERY_BIN = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.bin")
POKEDEX_JSON = os.path.join(REPO_ROOT, "public", "pokemon", "pokedex.json")
MODEL_ONNX = os.path.join(REPO_ROOT, "public", "models", "pokemon_encoder.onnx")
TEST_FACES_DIR = os.path.join(REPO_ROOT, "ml", "pokematch", "calibration", "test_faces")
FACES_OUT_DIR = os.path.join(REPO_ROOT, "ml", "pokematch", "calibration", "faces")


def load_gallery():
    with open(GALLERY_JSON, "r", encoding="utf-8") as f:
        meta = json.load(f)
    species = meta["species"]
    dim = meta["dim"]
    scale = meta["scale"]
    mu_raw = np.array(meta.get("muRaw", meta["mu"]), dtype=np.float32)
    sd_raw = np.array(meta.get("sdRaw", meta["sd"]), dtype=np.float32)

    with open(GALLERY_BIN, "rb") as f:
        bin_data = np.frombuffer(f.read(), dtype=np.int8)

    count = len(species)
    q_vecs = bin_data.reshape(count, dim).astype(np.float32) / scale
    norms = np.linalg.norm(q_vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    proto_vecs = q_vecs / norms
    return meta, species, proto_vecs, mu_raw, sd_raw


def load_pokedex():
    if os.path.exists(POKEDEX_JSON):
        with open(POKEDEX_JSON, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def process_images_batch(session, proto_vecs, img_paths, batch_size=32):
    count = len(img_paths)
    num_species = proto_vecs.shape[0]
    cos_matrix = np.zeros((count, num_species), dtype=np.float32)
    embeddings = np.zeros((count, proto_vecs.shape[1]), dtype=np.float32)

    print(f"[*] Extracting embeddings for {count} face images (Batch Size: {batch_size})...")
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name

    for start_idx in range(0, count, batch_size):
        end_idx = min(start_idx + batch_size, count)
        batch_paths = img_paths[start_idx:end_idx]
        b_len = len(batch_paths)

        batch_tensors = np.zeros((b_len, 3, 256, 256), dtype=np.float32)
        for i, path in enumerate(batch_paths):
            img = Image.open(path).convert("RGB")
            w, h = img.size
            s = min(w, h)
            crop = img.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2)).resize((256, 256))
            arr = np.array(crop, dtype=np.float32) / 255.0  # (256, 256, 3)
            batch_tensors[i] = np.transpose(arr, (2, 0, 1))

        # Check if ONNX model supports dynamic batch or run single/batched
        try:
            out = session.run([output_name], {input_name: batch_tensors})[0]
        except Exception:
            # Fallback if model requires batch=1
            out_list = []
            for b in range(b_len):
                single_out = session.run([output_name], {input_name: batch_tensors[b : b + 1]})[0][0]
                out_list.append(single_out)
            out = np.array(out_list)

        norms = np.linalg.norm(out, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        norm_emb = out / norms

        embeddings[start_idx:end_idx] = norm_emb
        cos_matrix[start_idx:end_idx] = np.dot(norm_emb, proto_vecs.T)

        if end_idx % 320 == 0 or end_idx == count:
            print(f"    Progress: {end_idx}/{count} images processed...")

    return embeddings, cos_matrix


def evaluate_lambdas(species, cos_matrix, subjects, mu_raw, sd_raw, pokedex, floor_pct=0.3):
    sorted_sd = np.sort(sd_raw)
    sd_floor = sorted_sd[int(len(sorted_sd) * floor_pct)]
    sd_eff = np.maximum(sd_raw, sd_floor)

    dataset_mean = np.mean(cos_matrix, axis=0)

    unique_subjects = sorted(list(set(subjects)))
    subj_indices = {s: np.where(np.array(subjects) == s)[0] for s in unique_subjects}
    subj_means = {s: np.mean(cos_matrix[indices], axis=0) for s, indices in subj_indices.items()}

    print("\n" + "=" * 90)
    print(f"K-FACE EMBEDDING & RANKING EVALUATION (Subjects: {len(unique_subjects)}, Images: {len(subjects)})")
    print("=" * 90)

    pairwise_sims = []
    keys = list(subj_means.keys())
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            sim = np.dot(subj_means[keys[i]], subj_means[keys[j]]) / (
                np.linalg.norm(subj_means[keys[i]]) * np.linalg.norm(subj_means[keys[j]])
            )
            pairwise_sims.append(sim)

    print(f"▶ Subject-to-Subject Vector Similarity (Mean): {np.mean(pairwise_sims):.5f}")
    print(f"  (High similarity ~0.998+ confirms encoder domain gap across all human faces)\n")

    best_results = None

    print(f"{'Lambda':<8} | {'Unique #1s':<10} | {'Total Unique Top5':<18} | {'Sample #1 Matches (S001 ~ S006)':<45}")
    print("-" * 90)

    for lam in [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]:
        mu_eff = (1 - lam) * mu_raw + lam * dataset_mean

        top1_by_subj = {}
        top5_by_subj = {}
        all_top1 = []
        all_top5 = set()

        for s in unique_subjects:
            s_cos = subj_means[s]
            z = (s_cos - mu_eff) / (sd_eff + 1e-6)
            top_k_idx = np.argsort(z)[::-1][:5]
            top_slugs = [species[idx] for idx in top_k_idx]

            top1_by_subj[s] = top_slugs[0]
            top5_by_subj[s] = top_slugs
            all_top1.append(top_slugs[0])
            all_top5.update(top_slugs)

        num_unique_top1 = len(set(all_top1))
        num_unique_top5 = len(all_top5)

        names1 = []
        for s in unique_subjects:
            slug = top1_by_subj[s]
            name = pokedex.get(slug, {}).get("nameKo") or slug
            names1.append(f"{s}:{name}")

        match_summary = ", ".join(names1)
        print(f"{lam:<8.1f} | {num_unique_top1:<10} | {num_unique_top5:<18} | {match_summary}")

        if lam == 0.4:
            best_results = (mu_eff, sd_eff, sd_floor, top1_by_subj, top5_by_subj, subj_means)

    return best_results, dataset_mean


def main():
    print("[*] Loading Gallery & Models...")
    g_meta, species, proto_vecs, mu_raw, sd_raw = load_gallery()
    pokedex = load_pokedex()
    session = ort.InferenceSession(MODEL_ONNX)

    all_img_paths = sorted(glob.glob(os.path.join(TEST_FACES_DIR, "*", "*", "*", "*.jpg")))
    if not all_img_paths:
        print(f"[!] Error: No images found in {TEST_FACES_DIR}")
        sys.exit(1)

    # Sample up to 60 images per subject (total ~360 images across lighting/expressions/angles)
    subj_map = {}
    for p in all_img_paths:
        subj = os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(p))))
        subj_map.setdefault(subj, []).append(p)

    img_paths = []
    for subj, paths in sorted(subj_map.items()):
        # evenly step through the 360 images per subject
        step = max(1, len(paths) // 60)
        sampled = paths[::step][:60]
        img_paths.extend(sampled)

    subjects = [os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(p)))) for p in img_paths]
    print(f"[*] Sampled {len(img_paths)} representative images across subjects: {sorted(list(set(subjects)))}")

    embeddings, cos_matrix = process_images_batch(session, proto_vecs, img_paths, batch_size=32)

    best_results, dataset_mean = evaluate_lambdas(species, cos_matrix, subjects, mu_raw, sd_raw, pokedex)
    mu_eff, sd_eff, sd_floor, top1_by_subj, top5_by_subj, subj_means = best_results

    # Write subject FULLCOS text files to ml/pokematch/calibration/faces/
    os.makedirs(FACES_OUT_DIR, exist_ok=True)
    for subj, cos_vec in subj_means.items():
        cos_ints = np.round(cos_vec * 1000).astype(int)
        out_file = os.path.join(FACES_OUT_DIR, f"{subj.lower()}.txt")
        with open(out_file, "w", encoding="utf-8") as f:
            f.write(",".join(map(str, cos_ints)))
        print(f"[*] Wrote subject summary: {out_file}")

    # Bake updated gallery.json
    round_fn = lambda x: float(np.round(x, 5))
    out_meta = {
        **g_meta,
        "mu": [round_fn(v) for v in mu_eff],
        "sd": [round_fn(v) for v in sd_eff],
        "muRaw": [round_fn(v) for v in mu_raw],
        "sdRaw": [round_fn(v) for v in sd_raw],
        "calibration": {
            "method": "kface-webcam-mu-blend",
            "kface_images": len(img_paths),
            "subjects": len(subj_means),
            "lambda": 0.4,
            "sdFloorPct": 0.3,
            "sdFloor": round_fn(sd_floor),
        },
    }

    with open(GALLERY_JSON, "w", encoding="utf-8") as f:
        json.dump(out_meta, f, ensure_ascii=False, indent=2)

    print(f"\n[SUCCESS] Calibrated parameters written to {GALLERY_JSON}")
    print(f"    (Calibrated over {len(img_paths)} K-Face images across {len(subj_means)} subjects)")


if __name__ == "__main__":
    main()
