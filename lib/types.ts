// Shared result types across VisionLab AI modules.
// Persisted to sessionStorage so the Integrated Summary can read both reports.

export type FacingMode = "user" | "environment";

export interface HeartPulseResult {
  bpm: number;
  /** 0-100, higher = more stressed (derived from HRV) */
  stressIndex: number;
  /** Heart-rate variability metrics (ms) */
  sdnn: number;
  rmssd: number;
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
  faceShape: FaceShape;
  metrics: {
    /** upper : mid : lower facial-third ratios (normalised, sum ~= 3) */
    thirds: [number, number, number];
    /** face length / cheekbone width */
    lengthToWidth: number;
    /** jaw angle in degrees */
    jawAngle: number;
  };
  measuredAt: string;
}

export const SESSION_KEYS = {
  heartPulse: "visionlab:heartpulse",
  personalFrame: "visionlab:personalframe",
} as const;
