// Shared result types across VisionLab AI modules.
// Persisted to sessionStorage so the Integrated Summary can read both reports.

export type FacingMode = "user" | "environment";

export interface HeartPulseResult {
  bpm: number;
  /** 0-100, higher = more stressed (derived from HRV). Null when too few
   * clean beats were detected to compute a real HRV-based estimate — the UI
   * must show this as "measurement unavailable", never as a fabricated 0. */
  stressIndex: number | null;
  /** Heart-rate variability metrics (ms). Null under the same condition as stressIndex. */
  sdnn: number | null;
  rmssd: number | null;
  /** 0-100 measurement confidence (penalised by head motion / low signal) */
  confidence: number;
  measuredAt: string; // ISO timestamp
}

export type SeasonTone =
  | "spring-warm"
  | "summer-cool"
  | "autumn-warm"
  | "winter-cool";

export type FaceShape =
  | "oval"
  | "round"
  | "square"
  | "heart"
  | "oblong"
  | "diamond";

export interface PersonalFrameResult {
  /** Calibrated skin colour in CIELAB */
  lab: { L: number; a: number; b: number };
  /** Convenience sRGB of the calibrated skin swatch, e.g. "#d8b49a" */
  skinHex: string;
  undertone: "warm" | "cool" | "neutral";
  season: SeasonTone;
  /** Individual Typology Angle (degrees) — dermatology-standard skin-depth metric. */
  ita: number;
  /** ITA° category key (very-light … dark). */
  itaCategory: "very-light" | "light" | "intermediate" | "tan" | "brown" | "dark";
  faceShape: FaceShape;
  metrics: {
    /** upper : mid : lower facial-third ratios (normalised, sum ~= 3) */
    thirds: [number, number, number];
    /** face length / cheekbone width */
    lengthToWidth: number;
    /** jaw angle in degrees */
    jawAngle: number;
  };
  /** 0-100 measurement confidence, from front/back capture stability — real
   * signal quality, not a fixed number. */
  confidence: number;
  /** Whether the rear-camera ambient reading actually corrected the skin
   * color (false when the user had no second camera and skipped that step —
   * the result is then an uncorrected estimate, and the UI must say so). */
  ambientCorrected: boolean;
  measuredAt: string;
}

export const SESSION_KEYS = {
  heartPulse: "visionlab:heartpulse",
  personalFrame: "visionlab:personalframe",
} as const;
