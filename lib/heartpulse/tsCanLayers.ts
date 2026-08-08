// The two custom Keras layers TS-CAN is built from, ported for tfjs.
//
// Both come from ubicomplab/rppg-web (UW Ubicomp Lab), the official web demo for
// "Multi-Task Temporal Shift Attention Networks for On-Device Contactless Vitals
// Measurement" (Liu et al., NeurIPS 2020) — the same lab whose rPPG-Toolbox our
// POS fallback was ported from. The vendored model is the pulse-only TS-CAN
// variant: two [None,36,36,3] inputs (motion + appearance), one scalar output per
// frame.
//
// ⚠️ THE REGISTERED NAME IS NOT THE NAME IN THE MODEL FILE, AND THAT'S CORRECT.
// public/models/tscan/model.json declares the layer as `Attention_mask`, but tfjs
// converts a snake_case Keras `class_name` to PascalCase before looking it up, so
// it asks its registry for `AttentionMask`. Registering the JSON's literal
// spelling fails with "Unknown layer: AttentionMask" — verified, not assumed:
// that is exactly what tests/tsCan.test.ts reported when this file was first
// written the other way round. `TSM` is unaffected, being all caps already.
// The test loads the real model file, so getting this wrong fails there rather
// than in a user's browser.

import type * as tfTypes from "@tensorflow/tfjs";

type Tf = typeof tfTypes;

let registered = false;

/**
 * Defines and registers TSM + Attention_mask against a tfjs instance.
 *
 * Takes `tf` as an argument rather than importing it, because tfjs is loaded
 * dynamically (it's ~1MB and only this route needs it) and because the tests
 * hand in the same instance they later load the model with — registration is
 * global to a tfjs instance, so it has to be the same object.
 */
export function registerTsCanLayers(tf: Tf): void {
  if (registered) return;

  /**
   * Temporal Shift Module: shifts a third of the channels one frame forward and
   * another third one frame back, so a plain 2D convolution can see across time.
   * This is what makes TS-CAN temporal without the cost of 3D convolutions.
   *
   * The batch dimension IS the time dimension here — a batch of N frames is one
   * window of N consecutive frames, and the shift moves data between them. So the
   * batch handed to predict() must be exactly the window, in order.
   */
  class TSM extends tf.layers.Layer {
    static className = "TSM";

    call(inputs: tfTypes.Tensor | tfTypes.Tensor[]): tfTypes.Tensor {
      return tf.tidy(() => {
        const input = (Array.isArray(inputs) ? inputs[0] : inputs) as tfTypes.Tensor4D;
        const [nt, h, w, c] = input.shape;

        const foldDiv = 3;
        const fold = Math.floor(c / foldDiv);
        const lastFold = c - (foldDiv - 1) * fold;

        const framed = tf.reshape(input, [-1, nt, h, w, c]);
        const [part1, part2, part3] = tf.split(framed, [fold, fold, lastFold], -1);

        // Shift left: drop the first frame, pad a zero frame at the end.
        const [, tail] = tf.split(part1, [1, nt - 1], 1);
        const shiftedLeft = tf.concat(
          [tail, tf.zeros([part1.shape[0], 1, h, w, fold])],
          1
        );

        // Shift right: drop the last frame, pad a zero frame at the front.
        const [head] = tf.split(part2, [nt - 1, 1], 1);
        const shiftedRight = tf.concat(
          [tf.zeros([part2.shape[0], 1, h, w, fold]), head],
          1
        );

        // The remaining channels stay put.
        const out = tf.concat([shiftedLeft, shiftedRight, part3], -1);
        return tf.reshape(out, [-1, h, w, c]);
      });
    }

    computeOutputShape(inputShape: tfTypes.Shape | tfTypes.Shape[]): tfTypes.Shape {
      return (Array.isArray(inputShape[0]) ? inputShape[0] : inputShape) as tfTypes.Shape;
    }

    getConfig() {
      return super.getConfig();
    }
  }

  /**
   * Soft attention mask: normalizes a single-channel map so it sums to
   * h*w/2 — i.e. it redistributes a fixed total weight over the frame rather
   * than scaling it. This is how the network learns to weight the skin regions
   * that actually carry the pulse and ignore the rest of the crop.
   */
  class AttentionMask extends tf.layers.Layer {
    // PascalCase, matching what tfjs derives from the model file's
    // `Attention_mask`. See the warning at the top of this file.
    static className = "AttentionMask";

    call(inputs: tfTypes.Tensor | tfTypes.Tensor[]): tfTypes.Tensor {
      return tf.tidy(() => {
        const input = (Array.isArray(inputs) ? inputs[0] : inputs) as tfTypes.Tensor4D;
        const spatialSum = tf.sum(tf.sum(input, 1, true), 2, true);
        return tf
          .div(input, spatialSum)
          .mul(input.shape[1])
          .mul(input.shape[2])
          .mul(0.5);
      });
    }

    computeOutputShape(inputShape: tfTypes.Shape | tfTypes.Shape[]): tfTypes.Shape {
      return (Array.isArray(inputShape[0]) ? inputShape[0] : inputShape) as tfTypes.Shape;
    }

    getConfig() {
      return super.getConfig();
    }
  }

  tf.serialization.registerClass(TSM as never);
  tf.serialization.registerClass(AttentionMask as never);
  registered = true;
}

/** Test hook: lets a fresh test process register again. */
export function _resetLayerRegistrationForTests(): void {
  registered = false;
}
