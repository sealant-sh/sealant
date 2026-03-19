import {
  SUPPORTED_DEPENDENCIES,
  SUPPORTED_DISTROS,
  buildDistroImage,
  type BuildDistroImageOptions,
  type SupportedDependency,
  type TargetDistro,
} from "./build-image.ts";

interface CliArgs {
  help: boolean;
  distro?: TargetDistro;
  dependencies: SupportedDependency[];
  extraPackages: string[];
  imageName?: string;
  imageTag?: string;
  runSmokeTest: boolean;
  playbookPath?: string;
  cwd?: string;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.distro) {
    throw new Error(`Missing required --distro flag. Supported: ${SUPPORTED_DISTROS.join(", ")}`);
  }

  const options: BuildDistroImageOptions = {
    targetDistro: args.distro,
    dependencies: args.dependencies,
    runSmokeTest: args.runSmokeTest,
    ...(args.extraPackages.length > 0 ? { extraPackages: args.extraPackages } : {}),
    ...(args.imageName ? { imageName: args.imageName } : {}),
    ...(args.imageTag ? { imageTag: args.imageTag } : {}),
    ...(args.playbookPath ? { playbookPath: args.playbookPath } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
  };

  const result = await buildDistroImage(options);

  process.stdout.write(`Built image ${result.imageRef}\n`);
  process.stdout.write(`Dependencies: ${result.effectiveDependencies.join(", ") || "(none)"}\n`);
  process.stdout.write(`Extra packages: ${result.extraPackages.join(", ") || "(none)"}\n`);
}

function parseCliArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    help: false,
    dependencies: [],
    extraPackages: [],
    runSmokeTest: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--") {
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }

    if (argument === "--distro") {
      const value = requiredValue(argv, index, argument);
      parsed.distro = parseDistro(value);
      index += 1;
      continue;
    }

    if (argument === "--deps") {
      const value = requiredValue(argv, index, argument);
      const dependencies = splitCsvList(value).map(parseDependency);
      parsed.dependencies = unique([...parsed.dependencies, ...dependencies]);
      index += 1;
      continue;
    }

    if (argument === "--dep") {
      const value = requiredValue(argv, index, argument);
      parsed.dependencies = unique([...parsed.dependencies, parseDependency(value)]);
      index += 1;
      continue;
    }

    if (argument === "--extra-packages") {
      const value = requiredValue(argv, index, argument);
      const extraPackages = splitCsvList(value);
      parsed.extraPackages = unique([...parsed.extraPackages, ...extraPackages]);
      index += 1;
      continue;
    }

    if (argument === "--extra-package") {
      const value = requiredValue(argv, index, argument);
      parsed.extraPackages = unique([...parsed.extraPackages, value]);
      index += 1;
      continue;
    }

    if (argument === "--image") {
      parsed.imageName = requiredValue(argv, index, argument);
      index += 1;
      continue;
    }

    if (argument === "--tag") {
      parsed.imageTag = requiredValue(argv, index, argument);
      index += 1;
      continue;
    }

    if (argument === "--smoke-test") {
      parsed.runSmokeTest = true;
      continue;
    }

    if (argument === "--no-smoke-test") {
      parsed.runSmokeTest = false;
      continue;
    }

    if (argument === "--playbook") {
      parsed.playbookPath = requiredValue(argv, index, argument);
      index += 1;
      continue;
    }

    if (argument === "--cwd") {
      parsed.cwd = requiredValue(argv, index, argument);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument '${argument}'. Use --help for usage.`);
  }

  return parsed;
}

function parseDistro(value: string): TargetDistro {
  const normalized = value.toLowerCase();
  if (!SUPPORTED_DISTROS.includes(normalized as TargetDistro)) {
    throw new Error(`Unsupported distro '${value}'. Supported: ${SUPPORTED_DISTROS.join(", ")}`);
  }

  return normalized as TargetDistro;
}

function parseDependency(value: string): SupportedDependency {
  const normalized = value.toLowerCase();
  if (!SUPPORTED_DEPENDENCIES.includes(normalized as SupportedDependency)) {
    throw new Error(
      `Unsupported dependency '${value}'. Supported: ${SUPPORTED_DEPENDENCIES.join(", ")}`,
    );
  }

  return normalized as SupportedDependency;
}

function splitCsvList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function unique<T>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Expected a value after ${flag}`);
  }

  return value;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  node --experimental-strip-types ./src/cli.ts --distro <arch|fedora> [options]",
      "",
      "Options:",
      "  --distro <name>         Target distro (required)",
      "  --deps <a,b,c>          Comma-separated dependency list",
      "  --dep <name>            Repeated dependency flag",
      "  --extra-packages <a,b>  Comma-separated distro package list",
      "  --extra-package <name>  Repeated distro package flag",
      "  --image <name>          Docker image name (default: sealant-distro-composition)",
      "  --tag <tag>             Docker image tag (default: distro)",
      "  --smoke-test            Run dependency checks after build",
      "  --no-smoke-test         Disable smoke test",
      "  --playbook <path>       Override playbook path",
      "  --cwd <path>            Run ansible-playbook in this directory",
      "  -h, --help              Show help",
      "",
      `Supported distros: ${SUPPORTED_DISTROS.join(", ")}`,
      `Supported dependencies: ${SUPPORTED_DEPENDENCIES.join(", ")}`,
    ].join("\n") + "\n",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
