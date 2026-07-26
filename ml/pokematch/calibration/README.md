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

3. **"이제 전혀 안 닮은 포켓몬이 나온다" (λ=0.7) — MITIGATED by λ=0.4 (2026-07-26).**
   Diagnosis (analysis over the 4 faces):
   - **Domain-gap ceiling is the root cause, now quantified:** the 4 faces'
     FULLCOS profiles have **mean pairwise cosine 0.9985** — the encoder sees
     all human faces as ~identical relative to pokémon, so real person-specific
     signal is ~0.15% of the vector. Any strong debias (high λ) amplifies that
     tiny residual = **noise → random species (onix/spidops)**.
   - **What each regime gives:** raw cosine → same hub for everyone
     (paras/kabuto). LFW-z (λ=0) → *plausible* cute/round species
     (jigglypuff/diancie/gothitelle/vulpix…) but a shared `mew` hub. λ=0.7 →
     hub gone but random.
   - **Fix applied:** lower **λ 0.7 → 0.4**. Keeps the plausible face-like pool,
     demotes `mew` out of #1 (now appears lower in ~3/4 lists, never #1), and
     each person's #1 differs (jigglypuff / diancie / gothitelle / diancie).
     Best plausible-vs-unique balance reachable at this encoder ceiling.
     Re-baked via `recalibrate.mjs write` (LAMBDA default now 0.4).
   - **Honest limitation:** with 0.9985 face-similarity, "true" resemblance
     discrimination is not achievable with this encoder — results are
     *plausible + loosely varied*, which is right for a fun app. Materially
     better would need a stronger/face-aware encoder or a curated candidate
     subset (see next).

## Current state (2026-07-26)

Deployed calibration = **λ=0.4**, σ-floor p30 (baked in `gallery.json`).
Results are plausible + loosely person-varied. Good enough for the fun app;
the encoder ceiling (0.9985) is the hard limit.

## What to try next (only if better resemblance is still wanted)

1. **Collect more faces** (needs real devices — sandbox has no camera): open
   `/pokematch?debug=1`, scan, "전체 복사", paste the `FULLCOS:` line as
   `faces/faceNN.txt`. More faces → stabler webcamMean. Then re-tune λ:
   `LAMBDA=0.4 node ml/pokematch/calibration/recalibrate.mjs` (dry-run) /
   `... recalibrate.mjs write` (bake). `validate_loo.mjs` for held-out check.
   (Note: more faces mainly stabilizes the hub estimate; it can't beat the
   0.9985 separability ceiling.)
2. **Curated candidate subset (biggest quality lever without a new encoder):**
   restrict ranking to face-plausible species (round/cute/humanoid — derivable
   from `pokedex.json` `shape`, or the species that score high in LFW-z) so the
   result is *always* a plausible pokémon; z only picks within that pool.
3. **Stronger/face-aware encoder** (bigger CLIP / a face-tuned model) — the
   only thing that actually raises the 0.15% person signal. Heavy.
4. Soften UX wording ("오늘의 닮은 포켓몬", 재미 강조) to match the real
   confidence level.

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
