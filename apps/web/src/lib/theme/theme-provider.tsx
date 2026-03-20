import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

export type UserTheme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const themeStorageKey = "ui-theme";

const userThemes: readonly UserTheme[] = ["light", "dark", "system"] as const;

function isUserTheme(value: string): value is UserTheme {
  return userThemes.includes(value as UserTheme);
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
  setTheme: (theme: UserTheme) => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [userTheme, setUserTheme] = useState<UserTheme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");

  useEffect(() => {
    const storedTheme = localStorage.getItem(themeStorageKey);
    const initialTheme = storedTheme !== null && isUserTheme(storedTheme) ? storedTheme : "system";

    setUserTheme(initialTheme);
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

  const contextValue = useMemo(
    () => ({ userTheme, resolvedTheme, setTheme }),
    [resolvedTheme, setTheme, userTheme],
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
