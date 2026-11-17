import os
import json
import glob
import numpy as np
import onnxruntime as ort

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
GALLERY_JSON = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.json")
GALLERY_BIN = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.bin")
POKEDEX_JSON = os.path.join(REPO_ROOT, "public", "pokemon", "pokedex.json")
MODEL_ONNX = os.path.join(REPO_ROOT, "public", "models", "pokemon_encoder.onnx")
TEST_FACES_DIR = os.path.join(REPO_ROOT, "ml", "pokematch", "calibration", "test_faces")

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

def main():
    meta, species, proto_vecs, mu_raw, sd_raw, human_mean, mu_unique, sd_unique, pokedex = load_data()
    session = ort.InferenceSession(MODEL_ONNX)

    target_slugs = ["hydrapple", "charmander", "exeggcute", "exeggutor", "lickitung", "appletun", "dipplin", "exeggutor_alola"]
    print("=== TARGET SPECIES PARAMS IN GALLERY.JSON ===")
    for slug in target_slugs:
        if slug in species:
            idx = species.index(slug)
            name_ko = pokedex.get(slug, {}).get("nameKo") or slug
            shape = pokedex.get(slug, {}).get("shape") or "N/A"
            print(f"  {slug} ({name_ko}) [shape={shape}]:")
            print(f"    mu_raw = {mu_raw[idx]:.5f}, sd_raw = {sd_raw[idx]:.5f}")
            print(f"    mu_unique = {mu_unique[idx]:.5f}, sd_unique = {sd_unique[idx]:.5f}")

    all_face_paths = sorted(glob.glob(os.path.join(TEST_FACES_DIR, "**", "*.jpg"), recursive=True))
    sampled_faces = all_face_paths[:100]

    top_ranks = {slug: [] for slug in target_slugs if slug in species}
    scores_dict = {slug: [] for slug in target_slugs if slug in species}

    for path in sampled_faces:
        emb = embed_image(session, path)
        diff = emb - human_mean
        diff_norm = np.linalg.norm(diff)
        u_emb = diff / (diff_norm if diff_norm > 0 else 1.0)

        dots = np.dot(proto_vecs, emb)
        u_dots = np.dot(proto_vecs, u_emb)

        scored = []
        for i, slug in enumerate(species):
            shape = pokedex.get(slug, {}).get("shape", "")
            sd_u_eff = max(sd_unique[i], 0.035)
            z_u = (u_dots[i] - mu_unique[i]) / sd_u_eff
            sd_r_eff = max(sd_raw[i], 0.055)
            z_r = (dots[i] - mu_raw[i]) / sd_r_eff
            sc = 0.60 * z_u + 0.40 * z_r + (0.05 if shape == "humanoid" else 0.0)
            scored.append((slug, sc, z_u, z_r))

        scored.sort(key=lambda x: x[1], reverse=True)
        ranked_slugs = [x[0] for x in scored]

        for slug in top_ranks:
            rank = ranked_slugs.index(slug) + 1
            top_ranks[slug].append(rank)

    print("\n=== RANK DISTRIBUTION FOR TARGET SPECIES OVER 100 FACES ===")
    for slug, ranks in top_ranks.items():
        name_ko = pokedex.get(slug, {}).get("nameKo") or slug
        top5_cnt = sum(1 for r in ranks if r <= 5)
        top10_cnt = sum(1 for r in ranks if r <= 10)
        avg_rank = np.mean(ranks)
        min_rank = min(ranks)
        print(f"  {slug} ({name_ko}): Avg Rank={avg_rank:.1f}, Min Rank={min_rank}, Top5 Count={top5_cnt}, Top10 Count={top10_cnt}")

if __name__ == "__main__":
    main()
