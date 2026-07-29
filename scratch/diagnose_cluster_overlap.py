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

with open(GALLERY_BIN, "rb") as f:
    bin_data = np.frombuffer(f.read(), dtype=np.int8)

count = len(species)
q_vecs = bin_data.reshape(count, dim).astype(np.float32) / scale
norms = np.linalg.norm(q_vecs, axis=1, keepdims=True)
norms[norms == 0] = 1.0
proto_vecs = q_vecs / norms

targets = ["charmander", "lickitung", "exeggcute", "exeggutor", "hydrapple", "dipplin", "appletun"]

print("=== PAIRWISE COSINE SIMILARITY BETWEEN TARGET CLUSTER SPECIES ===")
target_indices = [species.index(t) for t in targets if t in species]
target_names = [t for t in targets if t in species]

vec_matrix = proto_vecs[target_indices]
sim_matrix = np.dot(vec_matrix, vec_matrix.T)

print(f"{'Species':15} | " + " | ".join([f"{t[:8]:8}" for t in target_names]))
print("-" * 80)
for i, name in enumerate(target_names):
    row_str = " | ".join([f"{sim_matrix[i, j]:8.4f}" for j in range(len(target_names))])
    print(f"{name:15} | {row_str}")
