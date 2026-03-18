declare module "node:child_process" {
  export interface SpawnOptions {
    cwd?: string;
    stdio?: "inherit" | "pipe";
  }

  export interface ChildProcessLike {
    on(event: "error", listener: (error: unknown) => void): void;
    on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
  }

  export function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcessLike;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare const process: {
  argv: string[];
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  exit(code?: number): never;
};
