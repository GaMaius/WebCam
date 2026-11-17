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
    
    diffs = embs - human_mean
    diff_norms = np.linalg.norm(diffs, axis=1, keepdims=True)
    diff_norms[diff_norms == 0] = 1.0
    unique_embs = diffs / diff_norms

    unique_dots_matrix = np.dot(unique_embs, proto_vecs.T)
    mu_unique = np.mean(unique_dots_matrix, axis=0)
    sd_unique = np.std(unique_dots_matrix, axis=0)
    sd_unique_eff = np.maximum(sd_unique, 0.035)

    subjs = ["S001", "S002", "S003", "S004", "S005", "S006"]
    print("=== SUBJECT MATCHES UNDER DEBIASED HYBRID ALGORITHM ===")
    
    all_s_matches = []
    for s in subjs:
        imgs = sorted(glob.glob(os.path.join(TEST_FACES_DIR, s, "**", "*.jpg"), recursive=True))
        if not imgs: continue
        emb = embed_image(session, imgs[0])
        diff = emb - human_mean
        diff_norm = np.linalg.norm(diff)
        u_emb = diff / (diff_norm if diff_norm > 0 else 1.0)
        
        dots = np.dot(proto_vecs, emb)
        u_dots = np.dot(proto_vecs, u_emb)

        scores = []
        for i, slug in enumerate(species):
            shape = pokedex.get(slug, {}).get("shape", "")
            if shape in NON_HUMAN_EXCLUDE_SHAPES or slug in EXCLUDE_SLUGS:
                scores.append((slug, -999.0))
                continue
            z_u = (u_dots[i] - mu_unique[i]) / sd_unique_eff[i]
            z_r = (dots[i] - mu_raw[i]) / max(sd_raw[i], 0.055)
            
            # 60% z_unique + 40% z_raw + soft shape boost
            sc = 0.60 * z_u + 0.40 * z_r + (0.05 if shape == "humanoid" else 0.0)
            scores.append((slug, sc))

        scores.sort(key=lambda x: x[1], reverse=True)
        top5 = scores[:5]
        all_s_matches.extend([x[0] for x in top5])
        names = [f"{slug} ({pokedex.get(slug, {}).get('nameKo') or slug})" for slug, sc in top5]
        print(f"{s}: {', '.join(names)}")

    print(f"\nUnique Top-5 species across 6 subjects: {len(set(all_s_matches))} / 30")

if __name__ == "__main__":
    main()
