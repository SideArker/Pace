import type { SessionKind } from "./types.js";

export type ThemePalette = {
  primary: string;
  secondary: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  dim: string;
  muted: string;
  border: string;
  badgeBg?: string;
  badgeText?: string;
};

export const GlobalColors = {
  default: {
    primary: "#38BDF8",     // sky blue
    secondary: "#59E6A7",   // emerald / mint
    accent: "#818CF8",      // indigo
    success: "#34D399",     // green
    warning: "#FBBF24",     // amber
    error: "#F87171",       // red
    dim: "#64748B",         // slate 500
    muted: "#94A3B8",       // slate 400
    border: "#334155",      // slate 700
    badgeBg: "#0369A1",
    badgeText: "#E0F2FE",
  } satisfies ThemePalette,

  planning: {
    primary: "#C084FC",     // purple 400
    secondary: "#E879F9",   // fuchsia 400
    accent: "#A855F7",      // purple 500
    success: "#34D399",     // green
    warning: "#FBBF24",     // amber
    error: "#F87171",       // red
    dim: "#7E22CE",         // purple 700
    muted: "#D8B4FE",       // purple 300
    border: "#6B21A8",      // purple 800
    badgeBg: "#581C87",     // purple 900
    badgeText: "#F3E8FF",   // purple 100
  } satisfies ThemePalette,
};

export function getTheme(kind?: SessionKind): ThemePalette {
  if (kind === "planning") return GlobalColors.planning;
  return GlobalColors.default;
}
