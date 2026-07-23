# DeepPhys model — provenance & conversion notes

`public/models/deepphys-pure.onnx` is a converted copy of a pretrained checkpoint
from [ubicomplab/rPPG-Toolbox](https://github.com/ubicomplab/rPPG-Toolbox), the
same open-source toolbox referenced in the original product spec.

## Source

- Checkpoint: `final_model_release/PURE_DeepPhys.pth` (trained on the PURE
  dataset, evaluated cross-dataset on UBFC-rPPG in the toolbox's own
  benchmarks)
- Architecture: `neural_methods/model/DeepPhys.py` — a two-branch
  (motion + appearance) attention CNN, verbatim port used only to
  reconstruct the module for loading/exporting
- Inference config the checkpoint ships with:
  `configs/infer_configs/PURE_UBFC-rPPG_DEEPPHYS_BASIC.yaml`
  - `RESIZE: { H: 72, W: 72 }` — **not** the model class's own default of 36;
    this specific checkpoint was trained at 72x72
  - `CROP_FACE.LARGE_BOX_COEF: 1.5` — face bounding box enlarged 1.5x before
    resizing
  - `DATA_TYPE: ['DiffNormalized', 'Standardized']` — 6-channel input:
    channels 0-2 are frame-to-frame normalized differences (motion), 3-5 are
    whole-clip z-score-standardized raw pixels (appearance)
  - `FS: 30` — trained assuming ~30fps input

## Preprocessing (ported to `lib/deepPhys.ts`)

Line-for-line port of `dataset/data_loader/BaseLoader.py`'s
`diff_normalize_data` and `standardized_data`: both are **whole-clip**
normalizations (divide by the clip's own std/mean), not per-frame — this
matters because it's what the model was trained on. `diff_normalize_data`
also appends a trailing all-zero frame so the output length matches the
input (the reference implementation's own convention, not a bug on our
side — see the "leaves the very last sample at zero" behavior tested for
the analogous POS window in `tests/pos.test.ts`).

Face crop box math is in `lib/roi.ts`'s `computeFaceCropBox` (MediaPipe
face-landmark bounding box, enlarged 1.5x around its own center, matching
`LARGE_BOX_COEF`).

## Conversion

Converted with a one-off Python script (not checked into this repo — it's
a build-time artifact, not part of the shipped app):

1. Reconstruct `DeepPhys(img_size=72)` from the toolbox's model source.
2. Load the checkpoint's state dict, stripping the `module.` prefix (the
   checkpoint was saved from a `nn.DataParallel`-wrapped model).
3. `torch.onnx.export(model, dummy_input_shape_(1,6,72,72), ...)`, **fixed
   batch size of 1** — the app calls the model once per frame, and the
   newer dynamo-based exporter's handling of `.view(batch, -1)` does not
   generalize correctly to a dynamic batch axis for this architecture
   (confirmed by a failing dimension-mismatch test at batch>1; not needed
   for our actual usage, so left as a known, deliberate limitation rather
   than chased further).
4. Verified parity: PyTorch and ONNX Runtime outputs agree to within
   ~1e-6 across 20+ random inputs.
5. `torch.onnx.export`'s default output split the ~8.9MB of weights into a
   separate `.data` external-data file; merged back into a single
   self-contained `.onnx` file via `onnx.save_model(...,
   save_as_external_data=False)` for simpler static hosting, and
   re-verified parity on the merged file.

## Runtime behavior

- Loaded via `onnxruntime-web` with the WASM runtime fetched from jsdelivr's
  CDN (`ort.env.wasm.wasmPaths`), matching the same "fetch large runtime
  assets from a CDN rather than bundling them" pattern used for MediaPipe.
- Confirmed in-browser: the model loads from `/models/deepphys-pure.onnx`
  and produces distinct, finite outputs for distinct inputs; ~16ms per
  inference call in testing. At the full ~30fps capture rate that would be
  several seconds of sequential inference for a 15s clip, so
  `hooks/useHeartPulseScan.ts` subsamples frames (stride 2, still
  comfortably above the ~8Hz Nyquist floor the 0.7-4Hz target band needs)
  before running DeepPhys specifically.
- If the model fails to load within a few seconds (offline, slow
  connection) or inference throws, the hook falls back to the classical
  POS algorithm (`lib/pos.ts`) — both feed the same downstream
  bandpass-filter/BPM/HRV pipeline (`lib/signalProcessing.ts`), so the
  fallback is transparent apart from the "engine" tag shown in the result
  card.

## What's *not* verified

Everything above is verified against synthetic/random inputs and via
direct PyTorch/ONNX numerical parity. What is **not** verified in this
environment (no real webcam/face available) is real-world accuracy: does
a genuine face-with-blood-flow signal, captured on an arbitrary consumer
webcam, actually produce an accurate BPM through this exact preprocessing
pipeline. That needs testing on a real device with a real camera.
