import { type UserTheme, useTheme } from "../lib/ThemeProvider";
import { Button } from "./ui/button";

const themeConfig: Record<UserTheme, { icon: string; label: string; next: UserTheme }> = {
  light: { icon: "☀️", label: "Light", next: "dark" },
  dark: { icon: "🌙", label: "Dark", next: "system" },
  system: { icon: "💻", label: "System", next: "light" },
};

export const ThemeToggle = () => {
  const { userTheme, setTheme } = useTheme();

  return (
    <Button onClick={() => setTheme(themeConfig[userTheme].next)} className="w-28">
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
