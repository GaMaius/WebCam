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

EXCLUDE_SLUGS = set([
    "muk", "grimer", "muk_alola", "grimer_alola", "amoonguss", "foongus", "shiinotic", "morelull",
    "weezing", "koffing", "weezing_galar", "slugma", "magcargo", "gulpin", "swalot",
    "garbodor", "trubbish", "pincurchin", "pyukumuku", "stunfisk", "stunfisk_galar", "spiritomb",
    "wooper", "quagsire", "jigglypuff", "igglybuff", "wigglytuff", "electrode", "voltorb",
    "chi_yu", "goldeen", "seaking"
])

NON_HUMAN_EXCLUDE_SHAPES = set([
    "fish", "bug-wings", "tentacles", "armor", "squiggle", "ball", "blob", "quadruped", "wings"
])

def load_data():
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

    with open(POKEDEX_JSON, "r", encoding="utf-8") as f:
        pokedex = json.load(f)

    return species, proto_vecs, mu_raw, sd_raw, pokedex

def embed_square(session, img_path):
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
    species, proto_vecs, mu_raw, sd_raw, pokedex = load_data()
    session = ort.InferenceSession(MODEL_ONNX)
    
    subjs = ["S001", "S002", "S003", "S004", "S005", "S006"]
    imgs = {}
    for s in subjs:
        fl = sorted(glob.glob(os.path.join(TEST_FACES_DIR, s, "**", "*.jpg"), recursive=True))
        if fl: imgs[s] = fl[0]

    embs = {s: embed_square(session, imgs[s]) for s in subjs}
    
    # Calculate average human face vector across subjects
    all_emb_matrix = np.array(list(embs.values()))
    human_mean = np.mean(all_emb_matrix, axis=0)
    human_mean = human_mean / np.linalg.norm(human_mean)

    print("=== METHOD 1: CURRENT HYBRID SCORE ===")
    m1_results = {}
    for s in subjs:
        emb = embs[s]
        dots = np.dot(proto_vecs, emb)
        cos_norm = (dots - np.mean(dots)) / (np.std(dots) or 1e-6)
        sd_eff = np.maximum(sd_raw, 0.055)
        z_raw = (dots - mu_raw) / sd_eff
        
        scores = []
        for i, slug in enumerate(species):
            if slug in EXCLUDE_SLUGS: continue
            shape = pokedex.get(slug, {}).get("shape", "")
            if shape in NON_HUMAN_EXCLUDE_SHAPES: continue
            sc = 0.6 * cos_norm[i] + 0.3 * z_raw[i]
            scores.append((slug, sc))
        scores.sort(key=lambda x: x[1], reverse=True)
        m1_results[s] = [x[0] for x in scores[:5]]
        names = [f"{slug}({pokedex.get(slug, {}).get('nameKo') or slug})" for slug in m1_results[s]]
        print(f"{s}: {', '.join(names)}")

    m1_all = []
    for r in m1_results.values(): m1_all.extend(r)
    print(f"Method 1 Total Unique Top-5 Species: {len(set(m1_all))} out of {len(subjs)*5}")

    print("\n=== METHOD 2: PERSON-SPECIFIC DEVIATION + SPECIFICITY WEIGHTING ===")
    m2_results = {}
    for s in subjs:
        emb = embs[s]
        diff_emb = emb - human_mean
        diff_norm = np.linalg.norm(diff_emb)
        diff_unit = diff_emb / (diff_norm if diff_norm > 0 else 1.0)
        unique_dots = np.dot(proto_vecs, diff_unit)
        raw_dots = np.dot(proto_vecs, emb)
        
        scores = []
        for i, slug in enumerate(species):
            if slug in EXCLUDE_SLUGS: continue
            shape = pokedex.get(slug, {}).get("shape", "")
            if shape in NON_HUMAN_EXCLUDE_SHAPES: continue
            sc = 0.60 * unique_dots[i] + 0.40 * (raw_dots[i] - mu_raw[i])
            scores.append((slug, sc))
            
        scores.sort(key=lambda x: x[1], reverse=True)
        m2_results[s] = [x[0] for x in scores[:5]]
        names = [f"{slug}({pokedex.get(slug, {}).get('nameKo') or slug})" for slug in m2_results[s]]
        print(f"{s}: {', '.join(names)}")

    m2_all = []
    for r in m2_results.values(): m2_all.extend(r)
    print(f"Method 2 Total Unique Top-5 Species: {len(set(m2_all))} out of {len(subjs)*5}")

if __name__ == "__main__":
    main()
