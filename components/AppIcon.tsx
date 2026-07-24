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
    default:
      return null;
  }
}
