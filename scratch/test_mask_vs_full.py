import os
import json
import glob
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

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
    img = Image.open(img_path).convert("RGB")
    w, h = img.size
    s = min(w, h)
    crop = img.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2)).resize((256, 256))
    arr = np.array(crop, dtype=np.float32) / 255.0
    tensor = np.transpose(arr, (2, 0, 1))[np.newaxis, ...]
    out = session.run([session.get_outputs()[0].name], {session.get_inputs()[0].name: tensor})[0][0]
    norm = np.linalg.norm(out)
    return out / (norm if norm > 0 else 1.0)

def embed_oval_gray(session, img_path):
    img = Image.open(img_path).convert("RGB")
    w, h = img.size
    s = min(w, h)
    crop = img.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2)).resize((256, 256))
    
    # Apply oval gray mask like usePokematchScan.ts
    canvas = Image.new("RGB", (256, 256), (128, 128, 128))
    mask = Image.new("L", (256, 256), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((10, 5, 246, 251), fill=255)
    canvas.paste(crop, (0, 0), mask)
    
    arr = np.array(canvas, dtype=np.float32) / 255.0
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

    emb_sq = {s: embed_square(session, imgs[s]) for s in subjs}
    emb_ov = {s: embed_oval_gray(session, imgs[s]) for s in subjs}

    print("=== PAIRWISE EMBEDDING SIMILARITY AMONG SUBJECTS ===")
    sims_sq = []
    sims_ov = []
    for i in range(len(subjs)):
        for j in range(i+1, len(subjs)):
            s1, s2 = subjs[i], subjs[j]
            dot_sq = np.dot(emb_sq[s1], emb_sq[s2])
            dot_ov = np.dot(emb_ov[s1], emb_ov[s2])
            sims_sq.append(dot_sq)
            sims_ov.append(dot_ov)
            print(f"{s1} vs {s2} | Square: {dot_sq:.4f} | Oval Gray Mask: {dot_ov:.4f}")

    print(f"\nMean Inter-Subject Cosine Similarity (Lower is MORE DISTINCT):")
    print(f"  Clean Square Crop (Hair + Face Shape + Colors): {np.mean(sims_sq):.4f}")
    print(f"  Oval Gray Mask: {np.mean(sims_ov):.4f}")

if __name__ == "__main__":
    main()
