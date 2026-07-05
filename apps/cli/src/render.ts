import type { ConnectedAccountSummary } from "./schemas.js";

/*
 * Terminal rendering helpers: a tiny ANSI palette that degrades to plain text when stdout is not a
 * TTY (or NO_COLOR is set), aligned tables, and shared formatting for connected-account rows.
 */

export interface Palette {
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly red: (text: string) => string;
  readonly green: (text: string) => string;
  readonly yellow: (text: string) => string;
  readonly cyan: (text: string) => string;
}

const style =
  (enabled: boolean, open: number, close: number) =>
  (text: string): string =>
    enabled ? `\u001B[${open}m${text}\u001B[${close}m` : text;

export const makePalette = (enabled: boolean): Palette => ({
  bold: style(enabled, 1, 22),
  dim: style(enabled, 2, 22),
  red: style(enabled, 31, 39),
  green: style(enabled, 32, 39),
  yellow: style(enabled, 33, 39),
  cyan: style(enabled, 36, 39),
});

export const isColorEnabled = (): boolean =>
  Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;

// Intentional control character: it strips the ANSI SGR sequences the palette itself emits.
// oxlint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

/** Printable width of a cell, ignoring ANSI styling. */
export const visibleWidth = (text: string): number => text.replace(ANSI_PATTERN, "").length;

/** Render rows as aligned columns (two-space gutter); cells may contain ANSI styling. */
export const renderTable = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  palette: Palette,
): string => {
  const headerCells = headers.map((header) => palette.bold(header));
  const allRows = [headerCells, ...rows];
  const widths = headers.map((_, column) =>
    Math.max(...allRows.map((row) => visibleWidth(row[column] ?? ""))),
  );
  const renderRow = (row: ReadonlyArray<string>): string =>
    row
      .map((cell, column) =>
        column === row.length - 1
          ? cell
          : cell + " ".repeat(Math.max(0, (widths[column] ?? 0) - visibleWidth(cell))),
      )
      .join("  ")
      .trimEnd();
  return allRows.map(renderRow).join("\n");
};

/** "2026-07-05T12:00:00Z" -> "2026-07-05" (defensive against non-ISO strings). */
export const formatDate = (isoTimestamp: string): string =>
  isoTimestamp.length >= 10 ? isoTimestamp.slice(0, 10) : isoTimestamp;

const metadataString = (
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = metadata[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

const metadataStringArray = (
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): ReadonlyArray<string> => {
  const value = metadata[key];
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
};

/** Human details column for an account, derived from its NON-secret metadata. */
export const accountDetails = (account: ConnectedAccountSummary): string => {
  switch (account.provider) {
    case "claude": {
      const suffix = metadataString(account.metadata, "tokenSuffix");
      return suffix !== undefined ? `token …${suffix}` : "";
    }
    case "codex": {
      return (
        metadataString(account.metadata, "email") ??
        metadataString(account.metadata, "accountId") ??
        ""
      );
    }
    case "github": {
      const login = metadataString(account.metadata, "login");
      const scopes = metadataStringArray(account.metadata, "scopes");
      const parts: Array<string> = [];
      if (login !== undefined) {
        parts.push(login);
      }
      if (scopes.length > 0) {
        parts.push(`(${scopes.join(", ")})`);
      }
      return parts.join(" ");
    }
  }
};

/** Status cell with conventional coloring: active green, invalid red, archived dim. */
export const statusCell = (status: string, palette: Palette): string => {
  switch (status) {
    case "active":
      return palette.green(status);
    case "invalid":
      return palette.red(status);
    case "archived":
      return palette.dim(status);
    default:
      return status;
  }
};
