# PokéMatch webcam μ recalibration — debugging handoff

Live status of the **"which pokémon do I look like"** ranking calibration.
Read this before touching PokéMatch ranking; it's where the current open bug
lives (CLAUDE.md "알려진 문제" #2).

## The story so far

1. **Original bug ("everyone gets 파라스/Mew")** — raw cosine nearest-neighbor
   is dominated by a few pokémon that are close to *all* faces. Fixed by
   z-score debias in the Colab notebook: `z = (cos − μ_s) / σ_s`, with μ_s/σ_s
   = per-species mean/std of cosine vs a general face set (LFW), stored in
   `public/pokemon/gallery.json`.

2. **Second bug ("everyone gets Mew")** — the LFW μ/σ don't match the real
   *webcam-selfie* distribution: round, big-eyed "face-like" species (mew,
   jigglypuff, diancie, gothitelle…) resemble real webcam faces far more than
   LFW faces, so the same cluster won for everyone (hubness). Confirmed with
   real `?debug` FULLCOS from 4 testers — see `faces/`.
   **Fix applied (commit `9ab3bab`):** blend μ toward the webcam mean and
   floor σ:
   - `mu_eff = (1−λ)·muRaw + λ·webcamMean`, λ = 0.7
   - `sd_eff = max(sdRaw, p30(sdRaw))`  (σ-floor stops a small-σ species
     becoming the *new* hub)
   - `public/pokemon/gallery.json` now stores the calibrated `mu`/`sd`, keeps
     the originals as `muRaw`/`sdRaw`, and records params under `calibration`.
   - The matcher (`lib/pokematch/matcher.ts`) reads stats only → **no ranking
     code changed**. It also standardizes the *displayed* percent per-face
     (capture-brightness independent).
   - LOO over the 4 faces: **0 species shared** across held-out top-lists.

3. **CURRENT OPEN BUG (#2): "이제 전혀 안 닮은 포켓몬이 나온다."** After the
   λ=0.7 recal, Mew-domination is gone but results look *random/unrelated*
   (e.g. spidops, onix, blastoise). Likely causes:
   - **Overfit / noise:** webcamMean is from only **4 faces** → noisy per
     species; λ=0.7 leans hard on it and over-subtracts personal signal.
   - **σ-floor side effects** pushing odd species up.
   - Or a fundamental **domain-gap ceiling** — a pokémon-image CLIP encoder
     barely separates real faces (all z compressed), so once the shared bias
     is removed there isn't much *real* signal left to rank on.

## What to try next (in order)

1. **Collect more faces.** Have several people open `/pokematch?debug=1`,
   scan, hit "전체 복사" on the result panel, and paste the `FULLCOS:` line.
   Save each as `faces/faceNN.txt` (just the comma-separated integers).
   More faces → stabler webcamMean → less overfit.
2. **Re-run + re-validate:**
   ```
   node ml/pokematch/calibration/validate_loo.mjs      # check λ=0.5/0.7/1.0, want "shared: none" AND sensible species
   node ml/pokematch/calibration/recalibrate.mjs       # dry-run rankings
   node ml/pokematch/calibration/recalibrate.mjs write # bake into gallery.json
   ```
3. **Lower λ** (edit `recalibrate.mjs`): λ=0.5 keeps more LFW prior and looked
   less extreme in LOO (jigglypuff/wigglytuff partially return but still
   varied). Sweep λ ∈ {0.4, 0.5, 0.6} and eyeball plausibility.
4. **If still bad → accept the encoder ceiling** and change strategy: blend
   z-rank with raw-cosine rank, or restrict candidates to a curated
   face-plausible subset, or show top-K with lower confidence wording.

## Files

- `faces/faceNN.txt` — anonymous per-face cosine profiles (1003 ints ×1000, in
  `gallery.species` order). Not identity-reversible; ML calibration reference.
- `recalibrate.mjs` — builds `mu_eff`/`sd_eff` and (with `write`) bakes them
  into `public/pokemon/gallery.json`. Always recomputes from `muRaw`/`sdRaw`.
- `validate_loo.mjs` — leave-one-out generalization check.

## ⚠️ Important

- The Colab notebook `ml/pokematch/prepare_pokematch.ipynb` regenerates
  `gallery.json` from scratch and will **wipe this calibration** (mu/sd revert
  to LFW). After any regen, re-run `recalibrate.mjs write`.
- `matchTopK` ranks by raw z (calibrated μ/σ); the shown "닮은 정도 %" is a
  per-face-standardized cosmetic mapping — changing it does not change ranking.
