import { cn } from "@sealant/ui";
import { Monitor, Moon, Sun } from "lucide-react";

import { type UserTheme, useTheme } from "@/lib/theme/theme-provider";

interface ThemeSwitcherProps {
  readonly className?: string;
}

const themeOptions: ReadonlyArray<{
  value: UserTheme;
  label: string;
  icon: typeof Sun;
}> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

function getNextTheme(theme: UserTheme): UserTheme {
  const currentIndex = themeOptions.findIndex((option) => option.value === theme);
  const nextIndex = (currentIndex + 1) % themeOptions.length;

  return themeOptions[nextIndex]?.value ?? "light";
}

export function ThemeSwitcher({ className }: ThemeSwitcherProps) {
  const { userTheme, setTheme } = useTheme();
  const currentOption =
    themeOptions.find((option) => option.value === userTheme) ?? themeOptions[0]!;
  const Icon = currentOption.icon;

  return (
    <button
      type="button"
      onClick={() => {
        setTheme(getNextTheme(userTheme));
      }}
      className={cn(
        "inline-flex h-8 items-center gap-2 border border-border bg-background px-2.5 text-[0.62rem] font-semibold tracking-[0.12em] text-foreground transition-colors duration-200 hover:border-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
        className,
      )}
      aria-label={`Theme: ${currentOption.label}`}
      title={`Theme: ${currentOption.label}`}
    >
      <span className="font-mono text-[0.58rem] tracking-[0.16em] text-muted-foreground">
        Theme
      </span>
      <span
        className="inline-flex items-center gap-1.5 text-[0.62rem] font-semibold tracking-[0.12em] text-foreground"
        aria-hidden="true"
      >
        <Icon className="size-3.5" />
        {currentOption.label}
      </span>
    </button>
  );
}
