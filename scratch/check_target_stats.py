import os
import json

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
GALLERY_JSON = os.path.join(REPO_ROOT, "public", "pokemon", "gallery.json")

with open(GALLERY_JSON, "r", encoding="utf-8") as f:
    meta = json.load(f)

species = meta["species"]
mu = meta["mu"]
sd = meta["sd"]
mu_raw = meta.get("muRaw", mu)
sd_raw = meta.get("sdRaw", sd)
mu_u = meta.get("muUnique", [])
sd_u = meta.get("sdUnique", [])

targets = ["hydrapple", "charmander", "exeggcute", "exeggutor", "lickitung", "appletun", "dipplin", "exeggutor_alola", "gothitelle", "meloetta_aria"]

print("SPECIES | mu | sd | muRaw | sdRaw | muUnique | sdUnique")
print("-" * 75)
for t in targets:
    if t in species:
        idx = species.index(t)
        print(f"{t:15} | {mu[idx]:.4f} | {sd[idx]:.4f} | {mu_raw[idx]:.4f} | {sd_raw[idx]:.4f} | {mu_u[idx]:.4f} | {sd_u[idx]:.4f}")
