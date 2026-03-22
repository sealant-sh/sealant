import { fileURLToPath } from "node:url";

import {
  normalizeUserWorkspaceSpec,
  parseOsExecutorCompileInput,
  parseOsExecutorCompileResult,
  type OsExecutor,
  type OsExecutorCompileInput,
  type OsExecutorCompileResult,
  type OsExecutorSupport,
} from "@sealant/workspace-composition";

import {
  getNixExecutorSupport,
  mapBlueprintToNixExecutorSpec,
} from "./map-blueprint-to-nix-executor-spec.js";
import { parseNixExecutorSpec, type NixExecutorSpec } from "./nix-executor-spec.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

type NixBuildJson = Array<{
  outputs: {
    out: string;
  };
}>;

export interface NixExecutorCommandResult {
  stdout: string;
  stderr: string;
}

export interface NixExecutorCommandOptions {
  cwd?: string;
}

export type NixExecutorCommandRunner = (
  command: string,
  args: string[],
  options?: NixExecutorCommandOptions,
) => Promise<NixExecutorCommandResult>;

export interface NixOsExecutorOptions {
  commandRunner: NixExecutorCommandRunner;
}

// The existing Nix backend is already exposed via flake legacyPackages.mkWorkspace.
// This helper renders the mapped Nix spec as JSON and lets Nix reconstruct the
// attrset through builtins.fromJSON so the TS wrapper can call the current code
// path without inventing a second Nix entrypoint first.
const createNixWorkspaceExpression = (
  spec: NixExecutorSpec,
  attribute: "image" | "env" | "specJson",
) => {
  const specJson = JSON.stringify(spec);

  return `let flake = builtins.getFlake ${JSON.stringify(`path:${packageDir}`)}; spec = builtins.fromJSON ${JSON.stringify(specJson)}; workspace = flake.legacyPackages.\${builtins.currentSystem}.mkWorkspace spec; in workspace.${attribute}`;
};

// Builds one existing workspace output and returns the realized store path.
const buildWorkspaceAttribute = async (
  spec: NixExecutorSpec,
  attribute: "image" | "env" | "specJson",
  commandRunner: NixExecutorCommandRunner,
): Promise<string> => {
  const expression = createNixWorkspaceExpression(spec, attribute);
  const { stdout } = await commandRunner(
    "nix",
    ["build", "--impure", "--json", "--no-link", "--expr", expression],
    { cwd: packageDir },
  );

  const parsed = JSON.parse(stdout) as NixBuildJson;
  const outputPath = parsed[0]?.outputs.out;

  if (outputPath === undefined) {
    throw new Error(`Nix build for workspace.${attribute} did not return an output path.`);
  }

  return outputPath;
};

// This wrapper is the bridge between the shared OsExecutor contract and the
// concrete Nix implementation already present in this package.
export class NixOsExecutor implements OsExecutor {
  public readonly id = "nix" as const;

  public readonly osFamily = "nix" as const;

  private readonly commandRunner: NixExecutorCommandRunner;

  public constructor(options: NixOsExecutorOptions) {
    this.commandRunner = options.commandRunner;
  }

  public supports(input: OsExecutorCompileInput): OsExecutorSupport {
    const parsed = parseOsExecutorCompileInput(input);
    return getNixExecutorSupport(parsed.blueprint);
  }

  public async compile(input: OsExecutorCompileInput): Promise<OsExecutorCompileResult> {
    const parsed = parseOsExecutorCompileInput(input);
    const support = this.supports(parsed);

    if (!support.supported) {
      throw new Error(support.message);
    }

    const spec = mapBlueprintToNixExecutorSpec(parsed.blueprint);
    const imagePath = await buildWorkspaceAttribute(spec, "image", this.commandRunner);
    const envPath = await buildWorkspaceAttribute(spec, "env", this.commandRunner);
    const specJsonDirectoryPath = await buildWorkspaceAttribute(
      spec,
      "specJson",
      this.commandRunner,
    );

    return parseOsExecutorCompileResult({
      executor: {
        id: this.id,
        osFamily: this.osFamily,
      },
      artifacts: [
        {
          kind: "oci-image",
          name: spec.imageName,
          path: imagePath,
          reference: `${spec.imageName}:${spec.harness}`,
          loader: "docker-load",
        },
        {
          kind: "filesystem-closure",
          name: `${spec.imageName}-env`,
          path: envPath,
        },
        {
          kind: "metadata",
          name: `${spec.imageName}-spec`,
          path: `${specJsonDirectoryPath}/etc/sealant/spec.json`,
          format: "json",
        },
      ],
      metadata: {
        defaultArtifactName: spec.imageName,
        notes: ["Compiled by the Nix OS executor wrapper."],
      },
    });
  }
}

// This helper is useful at the composition boundary: product-facing input goes
// through the shared validator/normalizer first, then lands in the concrete Nix
// executor spec the current backend already understands.
export const mapUserWorkspaceSpecToNixExecutorSpec = (input: unknown): NixExecutorSpec => {
  return mapBlueprintToNixExecutorSpec(normalizeUserWorkspaceSpec(input));
};

export const parseNixExecutorCompileInput = (input: unknown): OsExecutorCompileInput =>
  parseOsExecutorCompileInput(input);

export const parseMappedNixExecutorSpec = (input: unknown): NixExecutorSpec =>
  parseNixExecutorSpec(input);
