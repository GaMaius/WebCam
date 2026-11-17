import os
import json
import glob
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
GALLERY_JSON = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.json")
GALLERY_BIN = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.bin")
POKEDEX_JSON = os.path.join(REPO_ROOT, "public", "pokemon", "pokedex.json")
MODEL_ONNX = os.path.join(REPO_ROOT, "public", "models", "pokemon_encoder.onnx")
TEST_FACES_DIR = os.path.join(REPO_ROOT, "ml", "pokematch", "calibration", "test_faces")
IMG_DIR = os.path.join(REPO_ROOT, "public", "pokemon", "img")

NON_HUMAN_EXCLUDE_SHAPES = set([
    "fish", "bug-wings", "tentacles", "armor", "squiggle", "ball", "blob", "quadruped"
])
HUB_EXCLUDE_SLUGS = set([
    "jigglypuff", "igglybuff", "wigglytuff", "electrode", "voltorb", "chi_yu", "goldeen", "seaking"
])
OVERRIDE_BALL_SLUGS = set([
    "jigglypuff", "igglybuff", "wigglytuff", "clefairy", "cleffa", "clefable", "marill",
    "azumarill", "chansey", "blissey", "happiny", "spheal", "voltorb", "electrode",
    "gulpin", "swalot", "solosis", "duosion"
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
    mu = np.array(meta["mu"], dtype=np.float32)
    sd = np.array(meta["sd"], dtype=np.float32)
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

    return meta, species, proto_vecs, mu, sd, mu_raw, sd_raw, pokedex

def embed_image(session, img_path):
    img = Image.open(img_path).convert("RGB")
    w, h = img.size
    s = min(w, h)
    crop = img.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2)).resize((256, 256))
    arr = np.array(crop, dtype=np.float32) / 255.0
    tensor = np.transpose(arr, (2, 0, 1))[np.newaxis, ...]
    
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    out = session.run([output_name], {input_name: tensor})[0][0]
    norm = np.linalg.norm(out)
    return out / (norm if norm > 0 else 1.0)

def match_current(emb, species, proto_vecs, mu, sd, pokedex, k=5):
    cos = np.dot(proto_vecs, emb)
    sd_eff = np.maximum(sd, 0.038)
    raw_z = (cos - mu) / sd_eff
    
    scores = []
    for i, slug in enumerate(species):
        p_entry = pokedex.get(slug, {})
        raw_shape = p_entry.get("shape", "")
        shape = "ball" if slug in OVERRIDE_BALL_SLUGS else raw_shape
        
        if shape in NON_HUMAN_EXCLUDE_SHAPES or slug in HUB_EXCLUDE_SLUGS:
            scores.append((slug, -999.0, cos[i]))
            continue
            
        boost = CHAR_SHAPE_BOOST.get(shape, 0.0)
        boost += 0.15 # assuming faceAspect > 1.15
        
        z = raw_z[i] + boost
        scores.append((slug, z, cos[i]))
        
    scores.sort(key=lambda x: x[1], reverse=True)
    return scores[:k]

def main():
    meta, species, proto_vecs, mu, sd, mu_raw, sd_raw, pokedex = load_data()
    session = ort.InferenceSession(MODEL_ONNX)
    
    # Pick 1 image for each subject S001 ~ S006
    subjs = ["S001", "S002", "S003", "S004", "S005", "S006"]
    test_imgs = {}
    for s in subjs:
        imgs = glob.glob(os.path.join(TEST_FACES_DIR, s, "**", "*.jpg"), recursive=True)
        if imgs:
            test_imgs[s] = imgs[0]
            
    print("=== CURRENT ALGORITHM MATCHES ===")
    for s, path in test_imgs.items():
        emb = embed_image(session, path)
        top = match_current(emb, species, proto_vecs, mu, sd, pokedex, k=5)
        top_str = ", ".join([f"{slug} ({pokedex.get(slug, {}).get('nameKo') or slug}, z={z:.2f}, cos={c:.3f})" for slug, z, c in top])
        print(f"{s}: {top_str}")

if __name__ == "__main__":
    main()
