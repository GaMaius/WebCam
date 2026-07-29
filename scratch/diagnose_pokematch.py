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
CHAR_SHAPE_BOOST = {
    "humanoid": 0.22,
    "upright": 0.16,
    "heads": 0.08,
    "arms": 0.06,
    "legs": 0.04,
    "blob": -0.05,
    "ball": -0.12,
    "quadruped": -0.10,
    "fish": -0.25,
    "bug-wings": -0.20,
    "tentacles": -0.20,
    "armor": -0.18,
    "squiggle": -0.25,
}

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

def match_ts_exact(emb, species, proto_vecs, mu_raw, sd_raw, human_mean, pokedex, k=5, face_aspect=1.15):
    n = len(species)
    dim = len(emb)
    
    if len(human_mean) == dim:
        diff = emb - human_mean
        diff_norm = np.linalg.norm(diff)
        unique_emb = diff / (diff_norm if diff_norm > 0 else 1.0)
    else:
        unique_emb = emb

    dots = np.dot(proto_vecs, emb)
    unique_dots = np.dot(proto_vecs, unique_emb)

    cos_mean = np.mean(dots)
    cos_std = np.std(dots) or 1e-6
    unique_mean = np.mean(unique_dots)
    unique_std = np.std(unique_dots) or 1e-6

    scores = []
    for i in range(n):
        slug = species[i]
        shape = pokedex.get(slug, {}).get("shape", "")
        if shape in NON_HUMAN_EXCLUDE_SHAPES or slug in EXCLUDE_SLUGS:
            scores.append((slug, -999.0))
            continue

        unique_norm = (unique_dots[i] - unique_mean) / unique_std
        cos_norm = (dots[i] - cos_mean) / cos_std
        sd_eff = max(sd_raw[i], 0.055)
        z_raw = (dots[i] - mu_raw[i]) / sd_eff

        boost = CHAR_SHAPE_BOOST.get(shape, 0.0)
        if face_aspect > 1.15 and shape in ("humanoid", "upright"):
            boost += 0.08

        # 65% unique norm + 25% zRaw + 10% cosNorm + boost
        score = 0.65 * unique_norm + 0.25 * z_raw + 0.10 * cos_norm + boost
        scores.append((slug, score))

    scores.sort(key=lambda x: x[1], reverse=True)
    return scores[:k]

def main():
    meta, species, proto_vecs, mu_raw, sd_raw, human_mean, pokedex = load_data()
    session = ort.InferenceSession(MODEL_ONNX)

    all_face_paths = sorted(glob.glob(os.path.join(TEST_FACES_DIR, "**", "*.jpg"), recursive=True))
    print(f"Total test faces found: {len(all_face_paths)}")

    # Sample up to 100 faces
    sampled_faces = all_face_paths[:100]
    
    top1_list = []
    top5_list = []

    for path in sampled_faces:
        emb = embed_image(session, path)
        res = match_ts_exact(emb, species, proto_vecs, mu_raw, sd_raw, human_mean, pokedex, k=5)
        top1_list.append(res[0][0])
        top5_list.extend([r[0] for r in res])

    top1_counts = Counter(top1_list)
    top5_counts = Counter(top5_list)

    print("\n--- TOP 1 FREQUENCY OVER 100 FACES ---")
    for slug, cnt in top1_counts.most_common(10):
        name_ko = pokedex.get(slug, {}).get("nameKo") or slug
        print(f"  {slug} ({name_ko}): {cnt} times ({cnt/len(sampled_faces)*100:.1f}%)")

    print("\n--- TOP 5 FREQUENCY OVER 100 FACES ---")
    for slug, cnt in top5_counts.most_common(15):
        name_ko = pokedex.get(slug, {}).get("nameKo") or slug
        print(f"  {slug} ({name_ko}): {cnt} times ({cnt/(len(sampled_faces)*5)*100:.1f}% of all slots)")

    print(f"\nUnique Top-1 species: {len(top1_counts)} / {len(sampled_faces)}")
    print(f"Unique Top-5 species: {len(set(top5_list))} / {len(sampled_faces)*5}")

if __name__ == "__main__":
    main()
