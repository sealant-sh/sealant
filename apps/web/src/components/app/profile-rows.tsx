import { Link } from "@tanstack/react-router";

import type { ProfileRecord } from "@/lib/navigation/workspace-data";

interface ProfileRowsProps {
  readonly profiles: readonly ProfileRecord[];
}

export function ProfileRows({ profiles }: ProfileRowsProps) {
  return (
    <div className="border border-border">
      {profiles.map((profile) => (
        <Link
          key={profile.id}
          to={`/profiles/${encodeURIComponent(profile.id)}` as never}
          className="grid gap-3 border-b border-border px-4 py-3 no-underline transition-colors duration-200 last:border-b-0 hover:bg-muted/40 lg:grid-cols-[1fr_auto_auto_auto] lg:items-center"
        >
          <div>
            <p className="font-mono text-[0.62rem] uppercase tracking-[0.13em] text-muted-foreground">Profile</p>
            <p className="mt-1 text-sm font-semibold text-foreground">{profile.name}</p>
          </div>
          <p className="font-mono text-[0.62rem] uppercase tracking-[0.13em] text-muted-foreground">{profile.environment}</p>
          <p className="font-mono text-[0.62rem] uppercase tracking-[0.13em] text-muted-foreground">{profile.packageCount} packages</p>
          <p className="font-mono text-[0.62rem] uppercase tracking-[0.13em] text-muted-foreground">{profile.secretCount} secrets</p>
        </Link>
      ))}
    </div>
  );
}
