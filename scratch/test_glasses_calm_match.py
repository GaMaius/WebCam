import os
import json
import numpy as np

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
GALLERY_JSON = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.json")
GALLERY_BIN = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.bin")
POKEDEX_JSON = os.path.join(REPO_ROOT, "public", "pokemon", "pokedex.json")

with open(GALLERY_JSON, "r", encoding="utf-8") as f:
    meta = json.load(f)

species = meta["species"]
dim = meta["dim"]
scale = meta["scale"]
mu_raw = np.array(meta.get("muRaw", meta["mu"]), dtype=np.float32)
sd_raw = np.array(meta.get("sdRaw", meta["sd"]), dtype=np.float32)
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

# Monster / Beast / Spiky exclude list for clean human face matches
WILD_BEAST_EXCLUDE = set([
    "koraidon", "mankey", "primeape", "annihilape", "sandslash", "sandshrew",
    "rhydon", "rhyhorn", "rhyperior", "golemin", "golem", "graveler", "geodude",
    "tyranitar", "pupitar", "larvitar", "pinsir", "heracross", "scyther", "scizor"
])

print("=== CHECKING MONSTER DAMPENING & FEATURE FILTERING ===")

# Test species stats
for slug in ["koraidon", "inteleon", "kadabra", "decidueye", "mr_rime", "indeedee", "lucario"]:
    if slug in species:
        idx = species.index(slug)
        name_ko = pokedex.get(slug, {}).get("nameKo") or slug
        print(f"  {slug:12} ({name_ko:8}): muRaw={mu_raw[idx]:.4f}, muUnique={mu_unique[idx]:.4f}, sdUnique={sd_unique[idx]:.4f}")
