import { Link } from "@tanstack/react-router";

import type { ProfileRecord } from "@/lib/navigation/sandbox-data";

interface ProfileRowsProps {
  readonly profiles: readonly ProfileRecord[];
}

export function ProfileRows({ profiles }: ProfileRowsProps) {
  return (
    <div className="border border-border rounded-md">
      {profiles.map((profile) => (
        <Link
          key={profile.id}
          to="/profiles/$profileId"
          params={{ profileId: profile.id }}
          className="grid gap-3 border-b border-rule-faint px-4 py-3 no-underline transition-colors duration-200 last:border-b-0 hover:bg-muted/40 lg:grid-cols-[1fr_auto_auto_auto] lg:items-center"
        >
          <div>
            <p className="ev-eyebrow">Profile</p>
            <p className="mt-1 text-sm font-medium text-foreground">{profile.name}</p>
          </div>
          <p className="font-mono text-xs text-faint">{profile.environment}</p>
          <p className="font-mono text-xs text-faint">{profile.packageCount} packages</p>
          <p className="font-mono text-xs text-faint">{profile.secretCount} secrets</p>
        </Link>
      ))}
    </div>
  );
}
