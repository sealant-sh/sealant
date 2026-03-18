import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_DISTROS = ["arch", "fedora"] as const;
export const SUPPORTED_DEPENDENCIES = ["nodejs", "pnpm", "neovim", "postgresql"] as const;

export type TargetDistro = (typeof SUPPORTED_DISTROS)[number];
export type SupportedDependency = (typeof SUPPORTED_DEPENDENCIES)[number];

export interface BuildDistroImageOptions {
  targetDistro: TargetDistro;
  dependencies?: readonly SupportedDependency[];
  extraPackages?: readonly string[];
  imageName?: string;
  imageTag?: string;
  runSmokeTest?: boolean;
  playbookPath?: string;
  cwd?: string;
}

export interface BuildDistroImageResult {
  imageRef: string;
  playbookPath: string;
  effectiveDependencies: SupportedDependency[];
  extraPackages: string[];
}

export async function buildDistroImage(
  options: BuildDistroImageOptions,
): Promise<BuildDistroImageResult> {
  const targetDistro = options.targetDistro.toLowerCase() as TargetDistro;
  if (!SUPPORTED_DISTROS.includes(targetDistro)) {
    throw new Error(
      `Unsupported distro '${options.targetDistro}'. Supported: ${SUPPORTED_DISTROS.join(", ")}`,
    );
  }

  const selectedDependencies = normalizeDependencies(options.dependencies ?? []);
  const effectiveDependencies = withImpliedDependencies(selectedDependencies);
  const extraPackages = normalizeExtraPackages(options.extraPackages ?? []);

  const imageName = options.imageName ?? "zweit-distro-composition";
  const imageTag = options.imageTag ?? targetDistro;
  const playbookPath = options.playbookPath ?? defaultPlaybookPath();

  const extraVars = {
    target_distro: targetDistro,
    selected_dependencies: selectedDependencies,
    extra_packages: extraPackages,
    image_name: imageName,
    image_tag: imageTag,
    run_smoke_test: options.runSmokeTest ?? false,
  };

  const args = [playbookPath, "-e", JSON.stringify(extraVars)];

  await runCommand("ansible-playbook", args, options.cwd);

  return {
    imageRef: `${imageName}:${imageTag}`,
    playbookPath,
    effectiveDependencies,
    extraPackages,
  };
}

function normalizeDependencies(input: readonly SupportedDependency[]): SupportedDependency[] {
  const normalized = input
    .map((dependency) => dependency.toLowerCase())
    .filter((value, index, allValues) => {
      return allValues.indexOf(value) === index;
    });

  const invalidDependencies = normalized.filter((dependency) => {
    return !SUPPORTED_DEPENDENCIES.includes(dependency as SupportedDependency);
  });

  if (invalidDependencies.length > 0) {
    throw new Error(
      `Unsupported dependencies: ${invalidDependencies.join(", ")}. Supported: ${SUPPORTED_DEPENDENCIES.join(", ")}`,
    );
  }

  return normalized as SupportedDependency[];
}

function withImpliedDependencies(dependencies: SupportedDependency[]): SupportedDependency[] {
  if (!dependencies.includes("pnpm") || dependencies.includes("nodejs")) {
    return dependencies;
  }

  return [...dependencies, "nodejs"];
}

function normalizeExtraPackages(input: readonly string[]): string[] {
  const normalized = input.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const deduped = normalized.filter(
    (value, index, allValues) => allValues.indexOf(value) === index,
  );

  const packageNamePattern = /^@?[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
  const invalidPackages = deduped.filter((packageName) => !packageNamePattern.test(packageName));

  if (invalidPackages.length > 0) {
    throw new Error(
      `Invalid extra package names: ${invalidPackages.join(", ")}. Allowed pattern: ${packageNamePattern.source}`,
    );
  }

  return deduped;
}

function defaultPlaybookPath(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  return resolve(dirname(currentFilePath), "../playbooks/site.yml");
}

function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...(cwd ? { cwd } : {}),
    });

    child.on("error", (error: unknown) => {
      const errorCode =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";

      if (errorCode === "ENOENT") {
        rejectPromise(new Error(`'${command}' was not found in PATH.`));
        return;
      }

      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    });

    child.on("close", (code: number | null, signal: string | null) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      if (signal !== null) {
        rejectPromise(new Error(`'${command}' exited via signal ${signal}.`));
        return;
      }

      rejectPromise(new Error(`'${command}' exited with code ${code ?? "unknown"}.`));
    });
  });
}
