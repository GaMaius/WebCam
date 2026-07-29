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
    mu_unique = np.array(meta.get("muUnique", []), dtype=np.float32)
    sd_unique = np.array(meta.get("sdUnique", []), dtype=np.float32)

    with open(POKEDEX_JSON, "r", encoding="utf-8") as f:
        pokedex = json.load(f)

    with open(GALLERY_BIN, "rb") as f:
        bin_data = np.frombuffer(f.read(), dtype=np.int8)

    count = len(species)
    q_vecs = bin_data.reshape(count, dim).astype(np.float32) / scale
    norms = np.linalg.norm(q_vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    proto_vecs = q_vecs / norms

    return meta, species, proto_vecs, mu_raw, sd_raw, human_mean, mu_unique, sd_unique, pokedex

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

def match_with_nms(emb, species, proto_vecs, mu_raw, sd_raw, human_mean, mu_unique, sd_unique, pokedex, k=5, max_sim=0.72):
    n = len(species)
    dim = len(emb)

    diff = emb - human_mean
    diff_norm = np.linalg.norm(diff)
    u_emb = diff / (diff_norm if diff_norm > 0 else 1.0)

    dots = np.dot(proto_vecs, emb)
    u_dots = np.dot(proto_vecs, u_emb)

    scored = []
    for i in range(n):
        slug = species[i]
        shape = pokedex.get(slug, {}).get("shape", "")
        if shape in NON_HUMAN_EXCLUDE_SHAPES or slug in EXCLUDE_SLUGS:
            continue

        sd_u_eff = max(sd_unique[i] if len(sd_unique) > i else 0.05, 0.050)
        z_u = (u_dots[i] - mu_unique[i]) / sd_u_eff if len(mu_unique) > i else 0
        sd_r_eff = max(sd_raw[i], 0.055)
        z_r = (dots[i] - mu_raw[i]) / sd_r_eff

        boost = 0.02 if shape in ("humanoid", "upright") else 0.0
        sc = 0.60 * z_u + 0.40 * z_r + boost
        scored.append((i, slug, sc))

    scored.sort(key=lambda x: x[2], reverse=True)

    # NMS Selection
    selected = []
    selected_indices = []
    for idx, slug, sc in scored:
        if len(selected) >= k:
            break
        too_similar = False
        for sel_idx in selected_indices:
            sim = float(np.dot(proto_vecs[idx], proto_vecs[sel_idx]))
            if sim >= max_sim:
                too_similar = True
                break
        if not too_similar:
            selected.append((slug, sc))
            selected_indices.append(idx)

    return selected

def main():
    meta, species, proto_vecs, mu_raw, sd_raw, human_mean, mu_unique, sd_unique, pokedex = load_data()
    session = ort.InferenceSession(MODEL_ONNX)

    subj_dirs = sorted([d for d in glob.glob(os.path.join(TEST_FACES_DIR, "S*")) if os.path.isdir(d)])
    print(f"Total subjects found: {len(subj_dirs)}")

    subject_results = {}
    all_top5_species = []

    for s_dir in subj_dirs:
        s_name = os.path.basename(s_dir)
        imgs = sorted(glob.glob(os.path.join(s_dir, "**", "*.jpg"), recursive=True))
        if not imgs: continue
        emb = embed_image(session, imgs[0])
        top5 = match_with_nms(emb, species, proto_vecs, mu_raw, sd_raw, human_mean, mu_unique, sd_unique, pokedex, k=5, max_sim=0.72)
        top5_slugs = [x[0] for x in top5]
        subject_results[s_name] = top5_slugs
        all_top5_species.extend(top5_slugs)

    print("\n=== MATCH RESULTS PER SUBJECT (NMS DIVERSITY APPLIED) ===")
    for s_name, slugs in subject_results.items():
        names = [f"{slug} ({pokedex.get(slug, {}).get('nameKo') or slug})" for slug in slugs]
        print(f"  {s_name}: {', '.join(names)}")

    cnts = Counter(all_top5_species)
    total_slots = len(subject_results) * 5
    unique_species_count = len(cnts)

    print(f"\nTotal Unique Species across {len(subject_results)} subjects: {unique_species_count} / {total_slots}")
    print("Most Frequent Species across subjects:")
    for slug, count in cnts.most_common(10):
        name_ko = pokedex.get(slug, {}).get("nameKo") or slug
        print(f"  - {slug} ({name_ko}): {count} times ({count/len(subject_results)*100:.1f}% of subjects)")

if __name__ == "__main__":
    main()
