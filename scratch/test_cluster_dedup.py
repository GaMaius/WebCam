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

def rank_with_diversity(scored_list, proto_vecs, k=5, max_sim_threshold=0.75):
    # scored_list is array of (index, slug, score)
    selected = []
    selected_indices = []

    for item in scored_list:
        if len(selected) >= k:
            break
        idx, slug, sc = item
        
        # Check similarity with already selected species
        too_similar = False
        for s_idx in selected_indices:
            sim = float(np.dot(proto_vecs[idx], proto_vecs[s_idx]))
            if sim > max_sim_threshold:
                too_similar = True
                break

        if not too_similar:
            selected.append(item)
            selected_indices.append(idx)

    return selected

def main():
    meta, species, proto_vecs, mu_raw, sd_raw, human_mean, mu_unique, sd_unique, pokedex = load_data()
    session = ort.InferenceSession(MODEL_ONNX)

    subjs = ["S001", "S002", "S003", "S004", "S005", "S006"]
    
    print("=== BEFORE DIVERSITY DEDUP (CURRENT ENGINE) ===")
    for s in subjs:
        imgs = sorted(glob.glob(os.path.join(TEST_FACES_DIR, s, "**", "*.jpg"), recursive=True))
        if not imgs: continue
        emb = embed_image(session, imgs[0])
        diff = emb - human_mean
        diff_norm = np.linalg.norm(diff)
        u_emb = diff / (diff_norm if diff_norm > 0 else 1.0)

        dots = np.dot(proto_vecs, emb)
        u_dots = np.dot(proto_vecs, u_emb)

        scored = []
        for i, slug in enumerate(species):
            shape = pokedex.get(slug, {}).get("shape", "")
            if shape in NON_HUMAN_EXCLUDE_SHAPES or slug in EXCLUDE_SLUGS:
                continue
            z_u = (u_dots[i] - mu_unique[i]) / max(sd_unique[i], 0.035)
            z_r = (dots[i] - mu_raw[i]) / max(sd_raw[i], 0.055)
            sc = 0.60 * z_u + 0.40 * z_r + (0.02 if shape in ("humanoid", "upright") else 0.0)
            scored.append((i, slug, sc))

        scored.sort(key=lambda x: x[2], reverse=True)
        top5_raw = [f"{x[1]} ({pokedex.get(x[1], {}).get('nameKo') or x[1]})" for x in scored[:5]]
        print(f"{s}: {', '.join(top5_raw)}")

    print("\n=== AFTER DIVERSITY DEDUP (MAX PAIRWISE SIM = 0.72) ===")
    for s in subjs:
        imgs = sorted(glob.glob(os.path.join(TEST_FACES_DIR, s, "**", "*.jpg"), recursive=True))
        if not imgs: continue
        emb = embed_image(session, imgs[0])
        diff = emb - human_mean
        diff_norm = np.linalg.norm(diff)
        u_emb = diff / (diff_norm if diff_norm > 0 else 1.0)

        dots = np.dot(proto_vecs, emb)
        u_dots = np.dot(proto_vecs, u_emb)

        scored = []
        for i, slug in enumerate(species):
            shape = pokedex.get(slug, {}).get("shape", "")
            if shape in NON_HUMAN_EXCLUDE_SHAPES or slug in EXCLUDE_SLUGS:
                continue
            z_u = (u_dots[i] - mu_unique[i]) / max(sd_unique[i], 0.035)
            z_r = (dots[i] - mu_raw[i]) / max(sd_raw[i], 0.055)
            sc = 0.60 * z_u + 0.40 * z_r + (0.02 if shape in ("humanoid", "upright") else 0.0)
            scored.append((i, slug, sc))

        scored.sort(key=lambda x: x[2], reverse=True)
        dedup_top5 = rank_with_diversity(scored, proto_vecs, k=5, max_sim_threshold=0.72)
        top5_dedup_names = [f"{x[1]} ({pokedex.get(x[1], {}).get('nameKo') or x[1]})" for x in dedup_top5]
        print(f"{s}: {', '.join(top5_dedup_names)}")

if __name__ == "__main__":
    main()
