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

export function ThemeSwitcher({ className }: ThemeSwitcherProps) {
  const { userTheme, setTheme } = useTheme();

  return (
    <div className={cn("inline-flex items-center gap-2", className)}>
      <span className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-muted-foreground">Theme</span>
      <div className="inline-flex overflow-hidden border border-border bg-background" role="group" aria-label="Theme selection">
        {themeOptions.map((option) => {
          const Icon = option.icon;
          const isActive = userTheme === option.value;

          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={isActive}
              onClick={() => {
                setTheme(option.value);
              }}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 border-r border-border px-2.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors duration-200 last:border-r-0 hover:bg-muted hover:text-foreground focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
                isActive && "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
