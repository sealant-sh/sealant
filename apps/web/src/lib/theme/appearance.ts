export type UserTheme = "light" | "dark" | "system";

export interface AccentPreset {
  readonly label: string;
  readonly value: string;
}

export const themeStorageKey = "ui-theme";
export const accentStorageKey = "ui-accent";
export const defaultAccent = "#d924d8ff";

export const userThemes = ["light", "dark", "system"] as const satisfies readonly UserTheme[];

export const accentPresets: readonly AccentPreset[] = [
  { label: "Default", value: defaultAccent },
  { label: "Sealant Red", value: "#d92f24" },
  { label: "Signal Blue", value: "#2563eb" },
  { label: "Teal", value: "#0f766e" },
  { label: "Signal Green", value: "#15803d" },
  { label: "Amber", value: "#b45309" },
] as const;

export function isUserTheme(value: string): value is UserTheme {
  return userThemes.some((theme) => theme === value);
}

export function normalizeAccent(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const accent = value.trim().toLowerCase();
  if (/^#([0-9a-f]{3})$/i.test(accent)) {
    return accent.replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, "#$1$1$2$2$3$3");
  }

  return /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(accent) ? accent : null;
}

export function resolveAccent(value: string | null | undefined): string {
  return normalizeAccent(value) ?? defaultAccent;
}

export function getAccentForeground(accent: string): "#111111" | "#ffffff" {
  const resolvedAccent = resolveAccent(accent);
  const darkContrast = getContrastRatio(resolvedAccent, "#111111");
  const lightContrast = getContrastRatio(resolvedAccent, "#ffffff");

  return darkContrast >= lightContrast ? "#111111" : "#ffffff";
}

export function getAccentInputValue(accent: string): string {
  const resolvedAccent = resolveAccent(accent);

  return resolvedAccent.length === 9 ? resolvedAccent.slice(0, 7) : resolvedAccent;
}

export function getAccentLabel(accent: string): string {
  const resolvedAccent = resolveAccent(accent);
  const matchingPreset = accentPresets.find((preset) => preset.value === resolvedAccent);

  return matchingPreset?.label ?? "Custom";
}

function getContrastRatio(firstColor: string, secondColor: string): number {
  const firstLuminance = getRelativeLuminance(firstColor);
  const secondLuminance = getRelativeLuminance(secondColor);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

function getRelativeLuminance(color: string): number {
  const { blue, green, red } = getRgbChannels(color);
  const redLuminance = getLinearChannel(red / 255);
  const greenLuminance = getLinearChannel(green / 255);
  const blueLuminance = getLinearChannel(blue / 255);

  return redLuminance * 0.2126 + greenLuminance * 0.7152 + blueLuminance * 0.0722;
}

function getRgbChannels(color: string): {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
} {
  const resolvedColor = resolveAccent(color);
  const opaqueColor = resolvedColor.length === 9 ? resolvedColor.slice(0, 7) : resolvedColor;

  return {
    red: parseInt(opaqueColor.slice(1, 3), 16),
    green: parseInt(opaqueColor.slice(3, 5), 16),
    blue: parseInt(opaqueColor.slice(5, 7), 16),
  };
}

function getLinearChannel(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}
