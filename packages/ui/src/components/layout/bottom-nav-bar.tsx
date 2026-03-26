import { cn } from "@sealant/ui/lib/utils";
import { Link, linkOptions } from "@tanstack/react-router";
import { ScrollText, Layers, BarChart2, Settings2 } from "lucide-react";

interface NavItem {
  label: string;
  to: "/sandboxes" | "/registry" | "/issues" | "/profiles";
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { label: "LOGS", to: "/sandboxes", icon: ScrollText },
  { label: "REGISTRY", to: "/registry", icon: Layers },
  { label: "STATS", to: "/issues", icon: BarChart2 },
  { label: "CONFIG", to: "/profiles", icon: Settings2 },
];

interface BottomNavBarProps {
  className?: string;
}

export function BottomNavBar({ className }: BottomNavBarProps) {
  return (
    <nav
      className={cn(
        "fixed bottom-0 left-0 right-0 z-50 flex h-16 items-stretch border-t-2 border-foreground bg-card",
        className,
      )}
      aria-label="Bottom navigation"
    >
      {NAV_ITEMS.map(({ label, to, icon: Icon }) => {
        const options = linkOptions({ to });

        return (
          <Link
            key={label}
            {...options}
            className="flex flex-1 flex-col items-center justify-center gap-1 border-r border-border text-foreground/40 no-underline transition-colors duration-200 last:border-r-0 hover:bg-muted/40 hover:text-foreground/70"
            activeProps={{
              className:
                "flex flex-1 flex-col items-center justify-center gap-1 border-r border-border bg-primary text-primary-foreground no-underline last:border-r-0",
            }}
            aria-label={label}
          >
            {({ isActive }) => (
              <>
                <Icon
                  className={cn("size-5", isActive ? "text-primary-foreground" : "text-current")}
                />
                <span className="text-[9px] font-semibold tracking-[0.12em] uppercase">
                  {label}
                </span>
              </>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
