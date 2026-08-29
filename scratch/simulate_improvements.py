import os
import json
import glob
import numpy as np
import onnxruntime as ort
from collections import Counter

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
GALLERY_JSON = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.json")
GALLERY_BIN = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.bin")
POKEDEX_JSON = os.path.join(REPO_ROOT, "public", "pokemon", "pokedex.json")
MODEL_ONNX = os.path.join(REPO_ROOT, "public", "models", "pokemon_encoder.onnx")
TEST_FACES_DIR = os.path.join(REPO_ROOT, "ml", "pokematch", "calibration", "test_faces")

NON_HUMAN_EXCLUDE_SHAPES = set([
    "fish", "bug-wings", "tentacles", "armor", "squiggle", "ball", "blob", "quadruped", "wings"
])
EXCLUDE_SLUGS = set([
    "muk", "grimer", "muk_alola", "grimer_alola", "amoonguss", "foongus", "shiinotic", "morelull",
    "weezing", "koffing", "weezing_galar", "slugma", "magcargo", "gulpin", "swalot",
    "garbodor", "trubbish", "pincurchin", "pyukumuku", "stunfisk", "stunfisk_galar", "spiritomb",
    "wooper", "quagsire", "jigglypuff", "igglybuff", "wigglytuff", "electrode", "voltorb",
    "chi_yu", "goldeen", "seaking"
])

def load_data():
    with open(GALLERY_JSON, "r", encoding="utf-8") as f:
        meta = json.load(f)
    species = meta["species"]
    dim = meta["dim"]
    scale = meta["scale"]
    mu_raw = np.array(meta.get("muRaw", meta["mu"]), dtype=np.float32)
    sd_raw = np.array(meta.get("sdRaw", meta["sd"]), dtype=np.float32)
    human_mean = np.array(meta.get("humanMean", []), dtype=np.float32)

    with open(GALLERY_BIN, "rb") as f:
        bin_data = np.frombuffer(f.read(), dtype=np.int8)

    count = len(species)
    q_vecs = bin_data.reshape(count, dim).astype(np.float32) / scale
    norms = np.linalg.norm(q_vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    proto_vecs = q_vecs / norms

    with open(POKEDEX_JSON, "r", encoding="utf-8") as f:
        pokedex = json.load(f)

    return meta, species, proto_vecs, mu_raw, sd_raw, human_mean, pokedex

def embed_image(session, img_path):
    from PIL import Image
    img = Image.open(img_path).convert("RGB")
    w, h = img.size
    s = min(w, h)
    crop = img.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2)).resize((256, 256))
    arr = np.array(crop, dtype=np.float32) / 255.0
    tensor = np.transpose(arr, (2, 0, 1))[np.newaxis, ...]
    out = session.run([session.get_outputs()[0].name], {session.get_inputs()[0].name: tensor})[0][0]
    norm = np.linalg.norm(out)
    return out / (norm if norm > 0 else 1.0)

def main():
    meta, species, proto_vecs, mu_raw, sd_raw, human_mean, pokedex = load_data()
    session = ort.InferenceSession(MODEL_ONNX)

    all_face_paths = sorted(glob.glob(os.path.join(TEST_FACES_DIR, "**", "*.jpg"), recursive=True))
    sampled_faces = all_face_paths[:200]

    embs = np.array([embed_image(session, p) for p in sampled_faces])
    
    # 1. Compute per-face unique embeddings
    diffs = embs - human_mean
    diff_norms = np.linalg.norm(diffs, axis=1, keepdims=True)
    diff_norms[diff_norms == 0] = 1.0
    unique_embs = diffs / diff_norms

    # 2. Compute uniqueDots matrix [n_faces, n_species]
    unique_dots_matrix = np.dot(unique_embs, proto_vecs.T)
    
    # Per-species mean and std of unique_dots across faces
    mu_unique = np.mean(unique_dots_matrix, axis=0)
    sd_unique = np.std(unique_dots_matrix, axis=0)
    sd_unique_eff = np.maximum(sd_unique, 0.035)

    test_faces = all_face_paths[200:300]
    test_embs = np.array([embed_image(session, p) for p in test_faces])

    def evaluate_strategy(name, score_fn):
        top1_list, top5_list = [], []
        for emb in test_embs:
            dots = np.dot(proto_vecs, emb)
            diff = emb - human_mean
            diff_norm = np.linalg.norm(diff)
            u_emb = diff / (diff_norm if diff_norm > 0 else 1.0)
            u_dots = np.dot(proto_vecs, u_emb)

            scores = []
            for i, slug in enumerate(species):
                shape = pokedex.get(slug, {}).get("shape", "")
                if shape in NON_HUMAN_EXCLUDE_SHAPES or slug in EXCLUDE_SLUGS:
                    scores.append((slug, -999.0))
                    continue
                sc = score_fn(i, dots[i], u_dots[i], shape)
                scores.append((slug, sc))

            scores.sort(key=lambda x: x[1], reverse=True)
            top1_list.append(scores[0][0])
            top5_list.extend([x[0] for x in scores[:5]])

        top1_counts = Counter(top1_list)
        top5_counts = Counter(top5_list)
        max_top1 = top1_counts.most_common(1)[0]
        max_top5 = top5_counts.most_common(1)[0]
        print(f"\n=== STRATEGY: {name} ===")
        print(f"  Unique Top-1 Species: {len(top1_counts)} / 100 (Max single: {max_top1[0]}={max_top1[1]}%)")
        print(f"  Unique Top-5 Species: {len(set(top5_list))} / 500 (Max single in Top5: {max_top5[0]}={max_top5[1]} times, {max_top5[1]/500*100:.1f}%)")
        print("  Top 5 Most Frequent Pokemon in Top5:")
        for s, c in top5_counts.most_common(5):
            name_ko = pokedex.get(s, {}).get("nameKo") or s
            print(f"    - {s} ({name_ko}): {c} times")

    # Strategy A: Current matcher.ts
    evaluate_strategy("A (Current matcher.ts)", lambda i, d, ud, sh: 
        0.65 * ((ud - np.mean(ud)) / (np.std(ud) or 1e-6)) + 0.25 * ((d - mu_raw[i]) / max(sd_raw[i], 0.055)) + 0.10 * ((d - np.mean(d)) / (np.std(d) or 1e-6)) + (0.22 if sh == "humanoid" else (0.16 if sh == "upright" else 0.0))
    )

    # Strategy B: Per-Species Unique Debiasing (z_unique) + Per-Species Raw Debiasing (z_raw), Moderate Shape Boost (+0.05)
    evaluate_strategy("B (Per-Species z_unique + z_raw + Soft Boost)", lambda i, d, ud, sh:
        0.65 * ((ud - mu_unique[i]) / sd_unique_eff[i]) + 0.35 * ((d - mu_raw[i]) / max(sd_raw[i], 0.055)) + (0.05 if sh == "humanoid" else (0.02 if sh == "upright" else 0.0))
    )

    # Strategy C: 50% z_unique + 50% z_raw, Pure Feature Debiasing (No shape boost)
    evaluate_strategy("C (50% z_unique + 50% z_raw, Pure Feature)", lambda i, d, ud, sh:
        0.50 * ((ud - mu_unique[i]) / sd_unique_eff[i]) + 0.50 * ((d - mu_raw[i]) / max(sd_raw[i], 0.055))
    )

    # Strategy D: 60% z_unique + 40% z_raw, Pure Feature
    evaluate_strategy("D (60% z_unique + 40% z_raw, Pure Feature)", lambda i, d, ud, sh:
        0.60 * ((ud - mu_unique[i]) / sd_unique_eff[i]) + 0.40 * ((d - mu_raw[i]) / max(sd_raw[i], 0.055))
    )

if __name__ == "__main__":
    main()
