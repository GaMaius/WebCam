import type { AppIconKey } from "@/lib/apps";

/** Renders an app's glyph by its registry icon key. Adding a new icon = add a
 * case here and reference the key from lib/apps.ts. */
export function AppIcon({ name, size = 26 }: { name: AppIconKey; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "pulse":
      return (
        <svg {...common}>
          <path d="M3 12h4l2-6 4 12 2-6h6" />
        </svg>
      );
    case "palette":
      return (
        <svg {...common}>
          <circle cx="13.5" cy="6.5" r="1.3" fill="currentColor" />
          <circle cx="17.5" cy="10.5" r="1.3" fill="currentColor" />
          <circle cx="8.5" cy="7.5" r="1.3" fill="currentColor" />
          <circle cx="6.5" cy="12.5" r="1.3" fill="currentColor" />
          <path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1.1.9-2 2-2h2.4A4.6 4.6 0 0 0 22 10.4C22 5.7 17.5 2 12 2z" />
        </svg>
      );
    case "pokeball":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h6M15 12h6" />
          <circle cx="12" cy="12" r="2.6" fill="currentColor" />
        </svg>
      );
    case "vrm":
      return (
        <svg {...common}>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <path d="M3.27 6.96L12 12.01l8.73-5.05" />
          <path d="M12 22.08V12" />
        </svg>
      );
    case "synth":
      // A hand over a waveform: gestures shaping sound.
      return (
        <svg {...common}>
          <path d="M2 17c1.2 0 1.8-4 3-4s1.8 4 3 4" />
          <path d="M11.5 21v-4.5" />
          <path d="M11.5 16.5V5.5a1.4 1.4 0 0 1 2.8 0v6" />
          <path d="M14.3 12v-1.2a1.4 1.4 0 0 1 2.8 0V12" />
          <path d="M17.1 12.4v-.8a1.4 1.4 0 0 1 2.8 0V15a6 6 0 0 1-6 6h-1.4" />
        </svg>
      );
    default:
      return null;
  }
}
