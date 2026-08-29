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
OUT_DIR = os.path.join(REPO_ROOT, "ml", "pokematch", "calibration", "visual_results")

# Non-humanoid or ugly blob/fungus shapes to filter out
NON_HUMAN_EXCLUDE_SHAPES = set([
    "fish", "bug-wings", "tentacles", "armor", "squiggle", "ball", "blob", "quadruped", "wings"
])

# Specific ugly or non-humanoid species whose pokedex shape might be missing or 'arms'
EXCLUDE_SLUGS = set([
    "muk", "grimer", "muk_alola", "grimer_alola",
    "amoonguss", "foongus", "shiinotic", "morelull",
    "weezing", "koffing", "weezing_galar",
    "slugma", "magcargo", "gulpin", "swalot",
    "garbodor", "trubbish", "pincurchin", "pyukumuku",
    "stunfisk", "stunfisk_galar", "spiritomb", "wooper", "quagsire",
    "jigglypuff", "igglybuff", "wigglytuff", "electrode", "voltorb",
    "chi_yu", "goldeen", "seaking"
])

CHAR_SHAPE_BOOST = {
    "humanoid": 0.12,
    "upright": 0.08,
    "heads": 0.04,
    "arms": 0.02,
    "legs": 0.02,
}

def load_data():
    with open(GALLERY_JSON, "r", encoding="utf-8") as f:
        meta = json.load(f)
    species = meta["species"]
    dim = meta["dim"]
    scale = meta["scale"]
    mu = np.array(meta.get("muRaw", meta["mu"]), dtype=np.float32)
    sd = np.array(meta.get("sdRaw", meta["sd"]), dtype=np.float32)
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

    return meta, species, proto_vecs, mu, sd, human_mean, pokedex

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

def match_hybrid(emb, species, proto_vecs, mu_raw, sd_raw, human_mean, pokedex, k=5, sd_floor=0.055):
    if len(human_mean) > 0:
        diff = emb - human_mean
        diff_norm = np.linalg.norm(diff)
        unique_emb = diff / (diff_norm if diff_norm > 0 else 1.0)
    else:
        unique_emb = emb

    unique_dots = np.dot(proto_vecs, unique_emb)
    u_mean = np.mean(unique_dots)
    u_std = np.std(unique_dots) if np.std(unique_dots) > 0 else 1e-6
    unique_norm = (unique_dots - u_mean) / u_std

    cos = np.dot(proto_vecs, emb)
    sd_eff = np.maximum(sd_raw, sd_floor)
    z_raw = (cos - mu_raw) / sd_eff
    
    cos_mean = np.mean(cos)
    cos_std = np.std(cos) if np.std(cos) > 0 else 1e-6
    cos_norm = (cos - cos_mean) / cos_std

    candidates = []
    for i, slug in enumerate(species):
        if slug in EXCLUDE_SLUGS:
            continue
        p_entry = pokedex.get(slug, {})
        shape = p_entry.get("shape", "")
        if shape in NON_HUMAN_EXCLUDE_SHAPES:
            continue

        shape_boost = CHAR_SHAPE_BOOST.get(shape, 0.0)
        
        # 65% unique trait deviation + 25% z-score + 10% raw cosine + shape boost
        hybrid_score = 0.65 * unique_norm[i] + 0.25 * z_raw[i] + 0.10 * cos_norm[i] + shape_boost
        candidates.append((slug, hybrid_score, cos[i], z_raw[i]))

    candidates.sort(key=lambda x: x[1], reverse=True)
    return candidates[:k]

def create_visual_grid(subj, face_path, matches, pokedex):
    os.makedirs(OUT_DIR, exist_ok=True)
    
    face_img = Image.open(face_path).convert("RGB")
    face_img = face_img.resize((240, 240))

    card_w, card_h = 160, 240
    padding = 20
    header_h = 60
    
    total_w = padding + 240 + padding + (card_w + padding) * len(matches) + padding
    total_h = header_h + 240 + padding * 2

    canvas = Image.new("RGB", (total_w, total_h), (24, 26, 32))
    draw = ImageDraw.Draw(canvas)

    # Title header
    draw.text((padding, 15), f"Subject {subj} - Visual Pokémon Match Comparison", fill=(255, 255, 255))

    # Paste human face
    canvas.paste(face_img, (padding, header_h))
    draw.rectangle([padding, header_h, padding + 240, header_h + 240], outline=(146, 169, 225), width=3)
    draw.text((padding + 10, header_h + 210), f"Face: {subj}", fill=(255, 255, 255))

    # Paste matched Pokémons
    x_offset = padding + 240 + padding * 2
    for rank, (slug, score, cos_val, z_val) in enumerate(matches, 1):
        p_entry = pokedex.get(slug, {})
        name_ko = p_entry.get("nameKo") or slug
        img_path = os.path.join(IMG_DIR, f"{slug}.webp")
        
        if os.path.exists(img_path):
            p_img = Image.open(img_path).convert("RGB").resize((140, 140))
        else:
            p_img = Image.new("RGB", (140, 140), (40, 44, 52))

        # Card container
        cx = x_offset
        cy = header_h
        draw.rectangle([cx, cy, cx + card_w, cy + card_h], fill=(34, 38, 48), outline=(80, 90, 110), width=1)
        canvas.paste(p_img, (cx + 10, cy + 10))

        # Details
        draw.text((cx + 10, cy + 155), f"#{rank} {name_ko}", fill=(255, 220, 100))
        draw.text((cx + 10, cy + 175), f"{slug}", fill=(180, 190, 210))
        draw.text((cx + 10, cy + 195), f"Cos: {cos_val:.3f}", fill=(146, 169, 225))
        draw.text((cx + 10, cy + 215), f"Z: {z_val:.2f}", fill=(180, 220, 180))

        x_offset += card_w + padding

    out_file = os.path.join(OUT_DIR, f"match_{subj}.png")
    canvas.save(out_file)
    print(f"[*] Visual grid saved to: {out_file}")

def main():
    meta, species, proto_vecs, mu_raw, sd_raw, human_mean, pokedex = load_data()
    session = ort.InferenceSession(MODEL_ONNX)

    subjs = ["S001", "S002", "S003", "S004", "S005", "S006"]
    for s in subjs:
        imgs = sorted(glob.glob(os.path.join(TEST_FACES_DIR, s, "**", "*.jpg"), recursive=True))
        if not imgs:
            continue
        face_path = imgs[0]
        emb = embed_image(session, face_path)
        top = match_hybrid(emb, species, proto_vecs, mu_raw, sd_raw, human_mean, pokedex, k=5)
        create_visual_grid(s, face_path, top, pokedex)

if __name__ == "__main__":
    main()
