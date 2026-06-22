import { cn } from "@sealant/ui/lib/utils";
import { Link, linkOptions } from "@tanstack/react-router";
import { ScrollText, Layers, BarChart2, Settings2 } from "lucide-react";

interface NavItem {
  label: string;
  to: "/sandboxes" | "/registry" | "/issues" | "/profiles";
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { label: "Logs", to: "/sandboxes", icon: ScrollText },
  { label: "Registry", to: "/registry", icon: Layers },
  { label: "Stats", to: "/issues", icon: BarChart2 },
  { label: "Config", to: "/profiles", icon: Settings2 },
];

interface BottomNavBarProps {
  className?: string;
}

export function BottomNavBar({ className }: BottomNavBarProps) {
  return (
    <nav
      className={cn(
        "fixed bottom-0 left-0 right-0 z-50 flex h-16 items-stretch border-t border-border bg-card",
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
            className="flex flex-1 flex-col items-center justify-center gap-1 border-r border-border text-muted-foreground no-underline transition-colors duration-200 last:border-r-0 hover:bg-muted/40 hover:text-foreground"
            activeProps={{
              className:
                "flex flex-1 flex-col items-center justify-center gap-1 border-r border-border bg-accent text-primary no-underline last:border-r-0",
            }}
            aria-label={label}
          >
            {() => (
              <>
                <Icon className="size-5" />
                <span className="text-[11px]">{label}</span>
              </>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
