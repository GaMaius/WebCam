import os
import json
import glob
import numpy as np
import onnxruntime as ort
from PIL import Image

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
GALLERY_JSON = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.json")
MODEL_ONNX = os.path.join(REPO_ROOT, "public", "models", "pokemon_encoder.onnx")
TEST_FACES_DIR = os.path.join(REPO_ROOT, "ml", "pokematch", "calibration", "test_faces")

def main():
    print("[*] Loading ONNX Encoder & Face Images...")
    session = ort.InferenceSession(MODEL_ONNX)
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
    human_mean = (mean_vec / (norm if norm > 0 else 1.0)).tolist()

    round_fn = lambda x: float(np.round(x, 5))
    human_mean_rounded = [round_fn(v) for v in human_mean]

    with open(GALLERY_JSON, "r", encoding="utf-8") as f:
        meta = json.load(f)

    meta["humanMean"] = human_mean_rounded

    with open(GALLERY_JSON, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"[SUCCESS] Computed humanMean (512D) and baked into {GALLERY_JSON}")

if __name__ == "__main__":
    main()
