import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  accentStorageKey,
  defaultAccent,
  getAccentForeground,
  isUserTheme,
  resolveAccent,
  themeStorageKey,
  type UserTheme,
} from "@/lib/theme/appearance";

export type { UserTheme };
export type ResolvedTheme = "light" | "dark";

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyAccentToDocument(accent: string): string {
  const root = document.documentElement;
  const resolvedAccent = resolveAccent(accent);

  root.style.setProperty("--sw-accent", resolvedAccent);
  root.style.setProperty("--sw-accent-foreground", getAccentForeground(resolvedAccent));

  return resolvedAccent;
}

function applyThemeToDocument(theme: UserTheme): ResolvedTheme {
  const root = document.documentElement;
  const resolvedTheme = theme === "system" ? getSystemTheme() : theme;

  root.classList.remove("light", "dark", "system");
  root.classList.add(resolvedTheme);

  if (theme === "system") {
    root.classList.add("system");
  }

  root.style.colorScheme = resolvedTheme;

  return resolvedTheme;
}

type ThemeContextValue = {
  userTheme: UserTheme;
  resolvedTheme: ResolvedTheme;
  accent: string;
  setTheme: (theme: UserTheme) => void;
  setAccent: (accent: string) => void;
  resetAccent: () => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [userTheme, setUserTheme] = useState<UserTheme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");
  const [accent, setAccentState] = useState(defaultAccent);

  useEffect(() => {
    const storedTheme = localStorage.getItem(themeStorageKey);
    const initialTheme = storedTheme !== null && isUserTheme(storedTheme) ? storedTheme : "system";
    const initialAccent = resolveAccent(localStorage.getItem(accentStorageKey));

    setUserTheme(initialTheme);
    setAccentState(initialAccent);
    applyAccentToDocument(initialAccent);
    setResolvedTheme(applyThemeToDocument(initialTheme));
  }, []);

  useEffect(() => {
    if (userTheme !== "system") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      setResolvedTheme(applyThemeToDocument("system"));
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, [userTheme]);

  const setTheme = useCallback((theme: UserTheme) => {
    setUserTheme(theme);
    localStorage.setItem(themeStorageKey, theme);
    setResolvedTheme(applyThemeToDocument(theme));
  }, []);

  const setAccent = useCallback((accentValue: string) => {
    const nextAccent = resolveAccent(accentValue);

    setAccentState(nextAccent);
    localStorage.setItem(accentStorageKey, nextAccent);
    applyAccentToDocument(nextAccent);
  }, []);

  const resetAccent = useCallback(() => {
    setAccentState(defaultAccent);
    localStorage.removeItem(accentStorageKey);
    applyAccentToDocument(defaultAccent);
  }, []);

  const contextValue = useMemo(
    () => ({ accent, resetAccent, resolvedTheme, setAccent, setTheme, userTheme }),
    [accent, resetAccent, resolvedTheme, setAccent, setTheme, userTheme],
  );

  return <ThemeContext value={contextValue}>{children}</ThemeContext>;
}

export function useTheme() {
  const context = use(ThemeContext);

  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }

  return context;
}
