import os
import json

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
GALLERY_JSON = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.json")
POKEDEX_JSON = os.path.join(REPO_ROOT, "public", "pokedex.json") if os.path.exists(os.path.join(REPO_ROOT, "public", "pokedex.json")) else os.path.join(REPO_ROOT, "public", "pokemon", "pokedex.json")

with open(GALLERY_JSON, "r", encoding="utf-8") as f:
    meta = json.load(f)

with open(POKEDEX_JSON, "r", encoding="utf-8") as f:
    pokedex = json.load(f)

species = meta["species"]
mu = meta["mu"]
sd = meta["sd"]
mu_raw = meta.get("muRaw", mu)
sd_raw = meta.get("sdRaw", sd)
mu_u = meta.get("muUnique", [])
sd_u = meta.get("sdUnique", [])

user_results = ["koraidon", "hydrapple", "charmander", "mankey", "sandslash"]
intellectual_candidates = ["inteleon", "sobble", "drizzile", "kadabra", "alakazam", "mr_rime", "decidueye", "rotom", "honchkrow", "indeedee", "lucario", "elgyem", "beheeyem", "spinda"]

print("=== USER RESULT SPECIES ===")
print("SPECIES        | shape     | muRaw  | sdRaw  | muUnique | sdUnique")
print("-" * 65)
for s in user_results:
    if s in species:
        idx = species.index(s)
        shape = pokedex.get(s, {}).get("shape") or "N/A"
        print(f"{s:14} | {shape:9} | {mu_raw[idx]:.4f} | {sd_raw[idx]:.4f} | {mu_u[idx]:.4f} | {sd_u[idx]:.4f}")

print("\n=== INTELLECTUAL / GLASSES / CALM CANDIDATE SPECIES ===")
print("SPECIES        | shape     | muRaw  | sdRaw  | muUnique | sdUnique")
print("-" * 65)
for s in intellectual_candidates:
    if s in species:
        idx = species.index(s)
        shape = pokedex.get(s, {}).get("shape") or "N/A"
        print(f"{s:14} | {shape:9} | {mu_raw[idx]:.4f} | {sd_raw[idx]:.4f} | {mu_u[idx]:.4f} | {sd_u[idx]:.4f}")
