import type { TextStyle, ViewStyle } from "react-native";

export const colors = {
  background: "#101413",
  surface: "#171d1c",
  surfaceAlt: "#202725",
  border: "#2e3734",
  text: "#eef2ec",
  muted: "#a8b4ad",
  dim: "#728078",
  accent: "#7ee7c5",
  cyan: "#79c7ff",
  amber: "#f2c166",
  red: "#ff817a",
  violet: "#c7a6ff",
  green: "#7ddc9a",
  black: "#050706",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
};

export const radii = {
  sm: 4,
  md: 6,
  lg: 8,
};

export const typography = {
  label: {
    fontSize: 11,
    color: colors.dim,
    textTransform: "uppercase",
  } satisfies TextStyle,
  body: {
    fontSize: 14,
    lineHeight: 21,
    color: colors.text,
  } satisfies TextStyle,
  mono: {
    fontFamily: "Courier",
  } satisfies TextStyle,
};

export const shadow = {
  border: {
    borderColor: colors.border,
    borderWidth: 1,
  } satisfies ViewStyle,
};
