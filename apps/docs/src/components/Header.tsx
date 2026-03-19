import { Link } from "@tanstack/react-router";

import { LogoBlob, LogoText } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { Button } from "./ui/button";

function TopLevelNavItem({
  to,
  href,
  children,
}: {
  to?: string;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    <li>
      {to ? (
        <Link
          to={to}
          target="_blank"
          className="text-sm text-zinc-600 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
        >
          {children}
        </Link>
      ) : (
        href && (
          <a
            href={href}
            {...(href.startsWith("http") ? { target: "_blank", rel: "noopener" } : {})}
            className="text-sm  text-zinc-600 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
          >
            {children}
          </a>
        )
      )}
    </li>
  );
}
export default function Header() {
  return (
    <header className="inset-x-0 top-0 z-50 flex h-14 items-center justify-between border-b border-zinc-900/10 px-4 transition dark:border-white/10">
      <div className="flex">
        <Link to="/" aria-label="Home" className="flex items-center justify-start gap-1">
          <LogoBlob className="size-8" />
          <LogoText className="h-8" />
        </Link>
      </div>

      <div className="flex items-center gap-5">
        <nav className="flex items-center">
          <ul role="list" className="flex items-center gap-8">
            <TopLevelNavItem to="/">Documenation</TopLevelNavItem>
            <TopLevelNavItem to="/blog">Blog</TopLevelNavItem>
            <TopLevelNavItem href="https://discord.gg">Community</TopLevelNavItem>
          </ul>
        </nav>
      </div>
      <div className="hidden md:h-5 md:w-px md:bg-zinc-900/10 md:dark:bg-white/15" />
      <div className="flex gap-4">
        <ThemeToggle />
      </div>
      <div className="hidden min-[450px]:contents">
        <Button>Dashboard</Button>
      </div>
    </header>
  );
}
