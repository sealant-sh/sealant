import { type UserTheme, useTheme } from "../lib/ThemeProvider";
import { Button } from "./ui/button";

const themeConfig: Record<UserTheme, { icon: string; label: string }> = {
  light: { icon: "☀️", label: "Light" },
  dark: { icon: "🌙", label: "Dark" },
  system: { icon: "💻", label: "System" },
};

export const ThemeToggle = () => {
  const { userTheme, setTheme } = useTheme();

  const getNextTheme = () => {
    const themes = Object.keys(themeConfig) as UserTheme[];
    const currentIndex = themes.indexOf(userTheme);
    const nextIndex = (currentIndex + 1) % themes.length;
    return themes[nextIndex];
  };

  return (
    <Button onClick={() => setTheme(getNextTheme())} className="w-28">
      <span className="not-system:light:inline hidden">
        {themeConfig.light.label}
        <span className="ml-1">{themeConfig.light.icon}</span>
      </span>
      <span className="not-system:dark:inline hidden">
        {themeConfig.dark.label}
        <span className="ml-1">{themeConfig.dark.icon}</span>
      </span>
      <span className="system:inline hidden">
        {themeConfig.system.label}
        <span className="ml-1">{themeConfig.system.icon}</span>
      </span>
    </Button>
  );
};
