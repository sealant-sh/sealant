export type UserTheme = "light" | "dark" | "system";

export const themeStorageKey = "ui-theme";

export const userThemes = ["light", "dark", "system"] as const satisfies readonly UserTheme[];

/**
 * Type guard for persisted user theme values.
 */
export function isUserTheme(value: string): value is UserTheme {
  return userThemes.some((theme) => theme === value);
}
