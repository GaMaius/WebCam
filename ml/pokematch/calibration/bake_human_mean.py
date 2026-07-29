import os
import json
import glob
import numpy as np
import onnxruntime as ort
from PIL import Image

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
GALLERY_JSON = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.json")
GALLERY_BIN = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.bin")
MODEL_ONNX = os.path.join(REPO_ROOT, "public", "models", "pokemon_encoder.onnx")
TEST_FACES_DIR = os.path.join(REPO_ROOT, "ml", "pokematch", "calibration", "test_faces")

def main():
    print("[*] Loading ONNX Encoder & Gallery Meta/Bin...")
    session = ort.InferenceSession(MODEL_ONNX)

    with open(GALLERY_JSON, "r", encoding="utf-8") as f:
        meta = json.load(f)

    species = meta["species"]
    dim = meta["dim"]
    scale = meta["scale"]

    with open(GALLERY_BIN, "rb") as f:
        bin_data = np.frombuffer(f.read(), dtype=np.int8)

    count = len(species)
    q_vecs = bin_data.reshape(count, dim).astype(np.float32) / scale
    norms = np.linalg.norm(q_vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    proto_vecs = q_vecs / norms

    img_paths = sorted(glob.glob(os.path.join(TEST_FACES_DIR, "**", "*.jpg"), recursive=True))
    if not img_paths:
        print("[!] No face images found!")
        return

    # Sample up to 360 images across all subjects
    sampled_paths = img_paths[::max(1, len(img_paths) // 360)]
    print(f"[*] Extracting 512D embeddings for {len(sampled_paths)} human face images...")

    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    embeddings = []

    for i, path in enumerate(sampled_paths):
        img = Image.open(path).convert("RGB")
        w, h = img.size
        s = min(w, h)
        crop = img.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2)).resize((256, 256))
        arr = np.array(crop, dtype=np.float32) / 255.0
        tensor = np.transpose(arr, (2, 0, 1))[np.newaxis, ...]
        out = session.run([output_name], {input_name: tensor})[0][0]
        norm = np.linalg.norm(out)
        embeddings.append(out / (norm if norm > 0 else 1.0))

    emb_matrix = np.array(embeddings)
    mean_vec = np.mean(emb_matrix, axis=0)
    norm = np.linalg.norm(mean_vec)
    human_mean = mean_vec / (norm if norm > 0 else 1.0)

    # Compute unique embeddings for each human face: diff = emb - human_mean, normalized
    diffs = emb_matrix - human_mean
    diff_norms = np.linalg.norm(diffs, axis=1, keepdims=True)
    diff_norms[diff_norms == 0] = 1.0
    unique_embs = diffs / diff_norms

    # Compute dot products of all human unique embeddings against all pokemon species vectors
    # Matrix shape: [num_faces, num_species]
    unique_dots = np.dot(unique_embs, proto_vecs.T)

    # Per-species mean and std across human faces
    mu_unique = np.mean(unique_dots, axis=0)
    sd_unique = np.std(unique_dots, axis=0)

    round_fn = lambda x: float(np.round(x, 5))
    human_mean_rounded = [round_fn(v) for v in human_mean]
    mu_unique_rounded = [round_fn(v) for v in mu_unique]
    sd_unique_rounded = [round_fn(v) for v in sd_unique]

    meta["humanMean"] = human_mean_rounded
    meta["muUnique"] = mu_unique_rounded
    meta["sdUnique"] = sd_unique_rounded

    with open(GALLERY_JSON, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"[SUCCESS] Computed humanMean (512D), muUnique ({len(mu_unique_rounded)}), sdUnique ({len(sd_unique_rounded)}) and baked into {GALLERY_JSON}")

if __name__ == "__main__":
    main()
