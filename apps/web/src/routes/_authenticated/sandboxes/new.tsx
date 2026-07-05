import { Button } from "@sealant/ui";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { useTRPC } from "@/lib/trpc/react";

type HarnessId = "opencode" | "codex" | "claude-code";
type SourceMode = "git" | "github";
type ConfigRepoMode = "none" | "git" | "github";
type LoginShell = "bash" | "zsh" | "fish";
type DotfilesManager = "auto" | "chezmoi" | "stow" | "copy";
type DotfilesTarget = "home" | "config";
type TargetOs = "fedora" | "arch" | "nix";
type OciRuntime = "runc" | "runsc";

interface NewSandboxFormState {
  readonly sourceMode: SourceMode;
  readonly sandboxSource: string;
  readonly branch: string;
  readonly githubInstallationId: string;
  readonly githubInstallationRepositoryId: string;
  readonly configRepoMode: ConfigRepoMode;
  readonly configRepoUrl: string;
  readonly configRepoRef: string;
  readonly configRepoGitHubInstallationId: string;
  readonly configRepoGitHubInstallationRepositoryId: string;
  readonly configRepoManager: DotfilesManager;
  readonly configRepoTarget: DotfilesTarget;
  readonly configRepoRunBootstrap: boolean;
  readonly configRepoBootstrapCommand: string;
  readonly harness: HarnessId;
  readonly defaultShell: LoginShell;
  readonly targetOs: TargetOs;
  readonly ociRuntime: OciRuntime;
  readonly registryId: string;
  readonly artifactRepository: string;
  readonly artifactTag: string;
  readonly packages: readonly string[];
  readonly setupSteps: readonly string[];
  readonly entrypoint: string;
  readonly sshEnabled: boolean;
}

interface PackageValidationState {
  readonly packageId: string;
  readonly state: "pending" | "valid" | "invalid";
  readonly message: string;
  readonly debugMessage?: string;
  readonly resolvedPackageName?: string;
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Unknown validation error.";
};

const HARNESS_OPTIONS: ReadonlyArray<{ readonly value: HarnessId; readonly label: string }> = [
  { value: "opencode", label: "OpenCode (Standard)" },
  { value: "codex", label: "Codex" },
  { value: "claude-code", label: "Claude Code" },
];

const TARGET_OS_OPTIONS: ReadonlyArray<{ readonly value: TargetOs; readonly label: string }> = [
  { value: "fedora", label: "Fedora" },
  { value: "arch", label: "Arch" },
  { value: "nix", label: "NixOS" },
];

const OCI_RUNTIME_OPTIONS: ReadonlyArray<{
  readonly value: OciRuntime;
  readonly label: string;
  readonly detail: string;
}> = [
  {
    value: "runc",
    label: "runc",
    detail: "Default Docker runtime for standard launches and widest compatibility.",
  },
  {
    value: "runsc",
    label: "runsc",
    detail: "gVisor-isolated Docker runtime for stronger sandbox boundaries.",
  },
];

const SHELL_OPTIONS: ReadonlyArray<{ readonly value: LoginShell; readonly label: string }> = [
  { value: "bash", label: "Bash" },
  { value: "zsh", label: "Zsh" },
  { value: "fish", label: "Fish" },
];

const DOTFILES_MANAGER_OPTIONS: ReadonlyArray<{
  readonly value: DotfilesManager;
  readonly label: string;
}> = [
  { value: "auto", label: "Auto" },
  { value: "chezmoi", label: "Chezmoi" },
  { value: "stow", label: "Stow" },
  { value: "copy", label: "Copy" },
];

const DOTFILES_TARGET_OPTIONS: ReadonlyArray<{
  readonly value: DotfilesTarget;
  readonly label: string;
}> = [
  { value: "home", label: "Home (~)" },
  { value: "config", label: "~/.config" },
];

export const Route = createFileRoute("/_authenticated/sandboxes/new")({
  component: NewSandboxPage,
});

function NewSandboxPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<NewSandboxFormState>(() => {
    return createInitialFormState("default");
  });
  const [isSourceGitHubExpanded, setIsSourceGitHubExpanded] = useState(false);
  const [isConfigRepoExpanded, setIsConfigRepoExpanded] = useState(false);
  const [githubRepositorySearch, setGitHubRepositorySearch] = useState("");
  const [configGitHubRepositorySearch, setConfigGitHubRepositorySearch] = useState("");
  const selectedRegistryId =
    normalizeRequiredValue(form.registryId).length > 0
      ? normalizeRequiredValue(form.registryId)
      : "default";
  const [packageInput, setPackageInput] = useState("");
  const [setupStepInput, setSetupStepInput] = useState("");
  const [formErrors, setFormErrors] = useState<readonly string[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const loggedPackageValidationErrorsRef = useRef<Set<string>>(new Set());

  const createSandboxMutation = useMutation(trpc.sandbox.create.mutationOptions());
  // Gateway SSH access authorizes by sandbox OWNER, so the create flow only needs to make sure
  // the user has at least one registered key — the key is account-level, not per-sandbox.
  const [sshKeyInput, setSshKeyInput] = useState("");
  const sshKeysQuery = useQuery({
    ...trpc.sshKey.list.queryOptions(),
    enabled: form.sshEnabled,
    staleTime: 1000 * 30,
  });
  const addSshKeyMutation = useMutation(
    trpc.sshKey.add.mutationOptions({
      onSuccess: async () => {
        setSshKeyInput("");
        await queryClient.invalidateQueries({ queryKey: trpc.sshKey.list.pathKey() });
      },
    }),
  );
  const registeredSshKeyCount = sshKeysQuery.data?.items.length ?? 0;
  const syncGitHubInstallationMutation = useMutation(
    trpc.github.syncInstallation.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.github.installations.pathKey() });
        await queryClient.invalidateQueries({
          queryKey: trpc.github.installationRepositories.pathKey(),
        });
      },
    }),
  );
  const githubInstallationsQuery = useQuery({
    ...trpc.github.installations.queryOptions(),
    staleTime: 1000 * 30,
  });
  const githubRepositoriesQuery = useQuery({
    ...trpc.github.installationRepositories.queryOptions({
      installationId: form.githubInstallationId,
    }),
    enabled:
      form.sourceMode === "github" && normalizeRequiredValue(form.githubInstallationId).length > 0,
    staleTime: 1000 * 30,
  });
  const configGithubRepositoriesQuery = useQuery({
    ...trpc.github.installationRepositories.queryOptions({
      installationId: form.configRepoGitHubInstallationId,
    }),
    enabled:
      form.configRepoMode === "github" &&
      normalizeRequiredValue(form.configRepoGitHubInstallationId).length > 0,
    staleTime: 1000 * 30,
  });
  const packageResolutionQueries = useQueries({
    queries: form.packages.map((pkg) => {
      return {
        ...trpc.package.resolve.queryOptions({
          query: pkg,
          targetOs: form.targetOs,
        }),
        staleTime: 1000 * 60 * 10,
      };
    }),
  });

  const packageValidationStates = useMemo<readonly PackageValidationState[]>(() => {
    return form.packages.map((pkg, index) => {
      const query = packageResolutionQueries[index];

      if (query === undefined || query.isPending) {
        return {
          packageId: pkg,
          state: "pending",
          message: `Validating '${pkg}' for ${form.targetOs}.`,
        };
      }

      if (query.isError || query.data === undefined) {
        const debugMessage = getErrorMessage(query.error);

        return {
          packageId: pkg,
          state: "invalid",
          message: `Unable to validate '${pkg}' right now (${debugMessage}).`,
          debugMessage,
        };
      }

      const osSupport = query.data.osSupport[form.targetOs];

      if (!osSupport.supported || osSupport.packageName === undefined) {
        return {
          packageId: pkg,
          state: "invalid",
          message: `Package '${pkg}' is not available for ${form.targetOs}.`,
        };
      }

      return {
        packageId: pkg,
        state: "valid",
        resolvedPackageName: osSupport.packageName,
        message:
          osSupport.packageName === pkg
            ? `Package '${pkg}' is valid for ${form.targetOs}.`
            : `Package '${pkg}' will install as '${osSupport.packageName}' on ${form.targetOs}.`,
      };
    });
  }, [form.packages, form.targetOs, packageResolutionQueries]);

  const packageValidationById = useMemo(() => {
    return new Map(packageValidationStates.map((entry) => [entry.packageId, entry]));
  }, [packageValidationStates]);

  const packageValidationIssues = useMemo(() => {
    return packageValidationStates
      .filter((entry) => entry.state === "invalid")
      .map((entry) => entry.message);
  }, [packageValidationStates]);

  const packageValidationPending = packageValidationStates.some(
    (entry) => entry.state === "pending",
  );

  const compatibilityIssues = [
    ...(packageValidationPending ? ["Package validation is still running."] : []),
    ...packageValidationIssues,
  ];

  useEffect(() => {
    for (const validationState of packageValidationStates) {
      if (validationState.state !== "invalid" || validationState.debugMessage === undefined) {
        continue;
      }

      const errorKey = `${validationState.packageId}:${validationState.debugMessage}`;

      if (loggedPackageValidationErrorsRef.current.has(errorKey)) {
        continue;
      }

      loggedPackageValidationErrorsRef.current.add(errorKey);
      console.error("[new-sandbox] package validation failed", {
        packageId: validationState.packageId,
        targetOs: form.targetOs,
        error: validationState.debugMessage,
      });
    }
  }, [form.targetOs, packageValidationStates]);

  const githubInstallations = githubInstallationsQuery.data?.items ?? [];
  const availableGitHubInstallations = useMemo(() => {
    return githubInstallations.filter((installation) => installation.status === "active");
  }, [githubInstallations]);
  const githubRepositories = githubRepositoriesQuery.data?.items ?? [];
  const configGithubRepositories = configGithubRepositoriesQuery.data?.items ?? [];
  const filteredGitHubRepositories = useMemo(() => {
    const search = normalizeRequiredValue(githubRepositorySearch).toLowerCase();

    if (search.length === 0) {
      return githubRepositories;
    }

    return githubRepositories.filter((repository) => {
      return (
        repository.fullName.toLowerCase().includes(search) ||
        repository.name.toLowerCase().includes(search)
      );
    });
  }, [githubRepositories, githubRepositorySearch]);
  const filteredConfigGitHubRepositories = useMemo(() => {
    const search = normalizeRequiredValue(configGitHubRepositorySearch).toLowerCase();

    if (search.length === 0) {
      return configGithubRepositories;
    }

    return configGithubRepositories.filter((repository) => {
      return (
        repository.fullName.toLowerCase().includes(search) ||
        repository.name.toLowerCase().includes(search)
      );
    });
  }, [configGithubRepositories, configGitHubRepositorySearch]);
  const selectedGitHubRepository = useMemo(() => {
    return githubRepositories.find(
      (repository) => repository.installationRepositoryId === form.githubInstallationRepositoryId,
    );
  }, [form.githubInstallationRepositoryId, githubRepositories]);
  const selectedConfigGitHubRepository = useMemo(() => {
    return configGithubRepositories.find(
      (repository) =>
        repository.installationRepositoryId === form.configRepoGitHubInstallationRepositoryId,
    );
  }, [form.configRepoGitHubInstallationRepositoryId, configGithubRepositories]);
  const effectiveSandboxSourceUrl =
    form.sourceMode === "github"
      ? selectedGitHubRepository === undefined
        ? "https://github.com/owner/repository.git"
        : buildGitHubRepositoryUrl(selectedGitHubRepository.fullName)
      : normalizeRepositoryUrl(form.sandboxSource);
  const effectiveSandboxRef =
    form.sourceMode === "github"
      ? normalizeOptionalValue(form.branch) || selectedGitHubRepository?.defaultBranch || "main"
      : normalizeRequiredValue(form.branch);
  const effectiveConfigRepoUrl =
    form.configRepoMode === "github"
      ? selectedConfigGitHubRepository === undefined
        ? "https://github.com/owner/dotfiles.git"
        : buildGitHubRepositoryUrl(selectedConfigGitHubRepository.fullName)
      : normalizeRepositoryUrl(form.configRepoUrl);
  const effectiveConfigRepoRef =
    form.configRepoMode === "github"
      ? normalizeOptionalValue(form.configRepoRef) ||
        selectedConfigGitHubRepository?.defaultBranch ||
        "main"
      : normalizeOptionalValue(form.configRepoRef) || "main";

  const previewManifest = useMemo(() => {
    const normalizedPackages = form.packages
      .map(normalizePackageIdentifier)
      .filter((value) => value.length > 0);
    const normalizedSetupSteps = form.setupSteps
      .map(normalizeCommandStep)
      .filter((value) => value.length > 0);
    const normalizedEntrypoint = normalizeRequiredValue(form.entrypoint);
    const normalizedConfigRepoInput =
      form.configRepoMode === "none"
        ? undefined
        : {
            id: "dotfiles",
            kind: "git" as const,
            purpose: "dotfiles" as const,
            provider: form.configRepoMode === "github" ? ("github" as const) : ("generic" as const),
            url: effectiveConfigRepoUrl,
            ref: effectiveConfigRepoRef,
          };

    return {
      registryId: selectedRegistryId,
      repository: normalizeRequiredValue(form.artifactRepository),
      tag: normalizeRequiredValue(form.artifactTag),
      ...(form.sourceMode === "github" && selectedGitHubRepository !== undefined
        ? {
            sourceSelection: {
              provider: "github",
              installationId: form.githubInstallationId,
              installationRepositoryId: selectedGitHubRepository.installationRepositoryId,
              ...(normalizeOptionalValue(form.branch).length === 0
                ? {}
                : { ref: normalizeOptionalValue(form.branch) }),
            },
          }
        : {}),
      ...(form.configRepoMode === "github" && selectedConfigGitHubRepository !== undefined
        ? {
            dotfilesSelection: {
              provider: "github",
              installationId: form.configRepoGitHubInstallationId,
              installationRepositoryId: selectedConfigGitHubRepository.installationRepositoryId,
              ...(normalizeOptionalValue(form.configRepoRef).length === 0
                ? {}
                : { ref: normalizeOptionalValue(form.configRepoRef) }),
            },
          }
        : {}),
      spec: {
        version: "1",
        sources: {
          sandbox: {
            kind: "git",
            provider: form.sourceMode === "github" ? "github" : "generic",
            url: effectiveSandboxSourceUrl,
            ref: effectiveSandboxRef,
          },
          inputs: normalizedConfigRepoInput === undefined ? [] : [normalizedConfigRepoInput],
        },
        harness: {
          id: form.harness,
        },
        access: {
          ssh: {
            enabled: form.sshEnabled,
            listenPort: 2222,
          },
        },
        tooling: {
          packages: normalizedPackages.map((id) => ({ id })),
        },
        customization: {
          defaultShell: form.defaultShell,
          dotfilesManager: form.configRepoManager,
          dotfilesTarget: form.configRepoTarget,
          applyDotfiles: form.configRepoMode !== "none",
          dotfilesBootstrap: form.configRepoRunBootstrap,
          ...(normalizeOptionalValue(form.configRepoBootstrapCommand).length === 0
            ? {}
            : {
                dotfilesBootstrapCommand: normalizeOptionalValue(form.configRepoBootstrapCommand),
              }),
        },
        lifecycle: {
          setup: normalizedSetupSteps.map((run, index) => ({
            id: `setup-${index + 1}`,
            run,
            shell: "bash" as const,
          })),
          startup: {
            steps: [],
            foreground:
              normalizedEntrypoint.length === 0
                ? {
                    kind: "harness" as const,
                  }
                : {
                    kind: "command" as const,
                    run: normalizedEntrypoint,
                    shell: "bash" as const,
                  },
          },
        },
        runtime: {
          env: {},
          sandboxRoot: "/sandbox",
          workingDirectory: "/sandbox/repo",
          persistence: "ephemeral" as const,
          ociRuntime: form.ociRuntime,
          network: {
            outbound: true,
          },
        },
        target: {
          os: {
            family: form.targetOs,
            mode: "prefer" as const,
          },
          runtime: {
            family: "auto" as const,
            mode: "prefer" as const,
          },
        },
      },
    };
  }, [
    effectiveConfigRepoRef,
    effectiveConfigRepoUrl,
    effectiveSandboxRef,
    effectiveSandboxSourceUrl,
    form,
    selectedConfigGitHubRepository,
    selectedGitHubRepository,
    selectedRegistryId,
  ]);

  const setField = <TField extends keyof NewSandboxFormState>(
    field: TField,
    value: NewSandboxFormState[TField],
  ) => {
    setForm((current) => {
      if (field === "githubInstallationId") {
        return {
          ...current,
          githubInstallationId: value as string,
          githubInstallationRepositoryId: "",
        };
      }

      if (
        field === "sourceMode" &&
        value === "github" &&
        availableGitHubInstallations.length === 1
      ) {
        return {
          ...current,
          sourceMode: value,
          githubInstallationId: availableGitHubInstallations[0]?.installationId ?? "",
          githubInstallationRepositoryId: "",
        };
      }

      if (
        field === "configRepoMode" &&
        value === "github" &&
        availableGitHubInstallations.length === 1
      ) {
        return {
          ...current,
          configRepoMode: value,
          configRepoGitHubInstallationId: availableGitHubInstallations[0]?.installationId ?? "",
          configRepoGitHubInstallationRepositoryId: "",
        };
      }

      if (field === "configRepoGitHubInstallationId") {
        return {
          ...current,
          configRepoGitHubInstallationId: value as string,
          configRepoGitHubInstallationRepositoryId: "",
        };
      }

      return {
        ...current,
        [field]: value,
      };
    });
    setFormErrors([]);
    setSubmitError(null);
    if (field === "sourceMode" || field === "githubInstallationId") {
      setGitHubRepositorySearch("");
    }
    if (field === "sourceMode") {
      setIsSourceGitHubExpanded((value as SourceMode) === "github");
    }
    if (field === "configRepoMode" || field === "configRepoGitHubInstallationId") {
      setConfigGitHubRepositorySearch("");
    }
    if (field === "configRepoMode") {
      setIsConfigRepoExpanded((value as ConfigRepoMode) !== "none");
    }
  };

  const appendPackage = () => {
    const candidate = normalizePackageIdentifier(packageInput);

    if (candidate.length === 0) {
      return;
    }

    setForm((current) => {
      if (current.packages.includes(candidate)) {
        return current;
      }

      return {
        ...current,
        packages: [...current.packages, candidate],
      };
    });
    setFormErrors([]);
    setSubmitError(null);
    setPackageInput("");
  };

  const appendSetupCommand = () => {
    const candidate = normalizeCommandStep(setupStepInput);

    if (candidate.length === 0) {
      return;
    }

    setForm((current) => {
      return {
        ...current,
        setupSteps: [...current.setupSteps, candidate],
      };
    });
    setFormErrors([]);
    setSubmitError(null);
    setSetupStepInput("");
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();

    setSubmitError(null);

    const validationErrors = validateForm(form, selectedRegistryId, compatibilityIssues);
    setFormErrors(validationErrors);

    if (validationErrors.length > 0) {
      return;
    }

    const packages = form.packages
      .map(normalizePackageIdentifier)
      .filter((value) => value.length > 0);
    const setup = form.setupSteps.map(normalizeCommandStep).filter((value) => value.length > 0);
    const startup = normalizeRequiredValue(form.entrypoint);
    const normalizedConfigRepoInput =
      form.configRepoMode === "none"
        ? undefined
        : {
            id: "dotfiles",
            kind: "git" as const,
            purpose: "dotfiles" as const,
            provider: form.configRepoMode === "github" ? ("github" as const) : ("generic" as const),
            url: effectiveConfigRepoUrl,
            ref: effectiveConfigRepoRef,
          };

    try {
      const response = await createSandboxMutation.mutateAsync({
        registryId: selectedRegistryId,
        repository: normalizeRequiredValue(form.artifactRepository),
        tag: normalizeRequiredValue(form.artifactTag),
        ...(form.sourceMode === "github" && selectedGitHubRepository !== undefined
          ? {
              sourceSelection: {
                provider: "github" as const,
                installationId: form.githubInstallationId,
                installationRepositoryId: selectedGitHubRepository.installationRepositoryId,
                ...(normalizeOptionalValue(form.branch).length === 0
                  ? {}
                  : { ref: normalizeOptionalValue(form.branch) }),
              },
            }
          : {}),
        ...(form.configRepoMode === "github" && selectedConfigGitHubRepository !== undefined
          ? {
              dotfilesSelection: {
                provider: "github" as const,
                installationId: form.configRepoGitHubInstallationId,
                installationRepositoryId: selectedConfigGitHubRepository.installationRepositoryId,
                ...(normalizeOptionalValue(form.configRepoRef).length === 0
                  ? {}
                  : { ref: normalizeOptionalValue(form.configRepoRef) }),
              },
            }
          : {}),
        spec: {
          version: "1",
          sources: {
            sandbox: {
              kind: "git",
              provider: form.sourceMode === "github" ? "github" : "generic",
              url: effectiveSandboxSourceUrl,
              ref: effectiveSandboxRef,
            },
            inputs: normalizedConfigRepoInput === undefined ? [] : [normalizedConfigRepoInput],
          },
          harness: {
            id: form.harness,
          },
          access: {
            ssh: {
              enabled: form.sshEnabled,
              listenPort: 2222,
            },
          },
          tooling: {
            packages: packages.map((id) => ({ id })),
          },
          customization: {
            defaultShell: form.defaultShell,
            dotfilesManager: form.configRepoManager,
            dotfilesTarget: form.configRepoTarget,
            applyDotfiles: form.configRepoMode !== "none",
            dotfilesBootstrap: form.configRepoRunBootstrap,
            ...(normalizeOptionalValue(form.configRepoBootstrapCommand).length === 0
              ? {}
              : {
                  dotfilesBootstrapCommand: normalizeOptionalValue(form.configRepoBootstrapCommand),
                }),
          },
          lifecycle: {
            setup: setup.map((run, index) => ({
              id: `setup-${index + 1}`,
              run,
              shell: "bash" as const,
            })),
            startup: {
              steps: [],
              foreground:
                startup.length === 0
                  ? {
                      kind: "harness" as const,
                    }
                  : {
                      kind: "command" as const,
                      run: startup,
                      shell: "bash" as const,
                    },
            },
          },
          runtime: {
            env: {},
            sandboxRoot: "/sandbox",
            workingDirectory: "/sandbox/repo",
            persistence: "ephemeral" as const,
            ociRuntime: form.ociRuntime,
            network: {
              outbound: true,
            },
          },
          target: {
            os: {
              family: form.targetOs,
              mode: "prefer" as const,
            },
            runtime: {
              family: "auto" as const,
              mode: "prefer" as const,
            },
          },
        },
      });

      await queryClient.invalidateQueries({ queryKey: trpc.sandbox.list.pathKey() });
      window.location.assign(`/sandboxes/${encodeURIComponent(response.sandboxId)}`);
    } catch (error) {
      setSubmitError(resolveErrorMessage(error));
    }
  };

  const hasValidRepositoryUrl = isValidUrl(previewManifest.spec.sources.sandbox.url);
  const githubSourceReady =
    normalizeRequiredValue(form.githubInstallationId).length > 0 &&
    normalizeRequiredValue(form.githubInstallationRepositoryId).length > 0;
  const hasValidConfigRepositoryUrl =
    form.configRepoMode === "none"
      ? true
      : form.configRepoMode === "github"
        ? true
        : isValidUrl(effectiveConfigRepoUrl);
  const githubConfigRepoReady =
    normalizeRequiredValue(form.configRepoGitHubInstallationId).length > 0 &&
    normalizeRequiredValue(form.configRepoGitHubInstallationRepositoryId).length > 0;
  const configRepoReady =
    form.configRepoMode === "none"
      ? true
      : form.configRepoMode === "github"
        ? githubConfigRepoReady
        : hasValidConfigRepositoryUrl;
  const configRepoSummary =
    form.configRepoMode === "none"
      ? "Disabled"
      : form.configRepoMode === "github"
        ? (selectedConfigGitHubRepository?.fullName ?? "Select a GitHub repository")
        : normalizeRequiredValue(form.configRepoUrl).length > 0
          ? effectiveConfigRepoUrl
          : "Enter a repository URL";
  const sourceGitHubSummary =
    selectedGitHubRepository?.fullName ??
    (normalizeRequiredValue(form.githubInstallationId).length > 0
      ? "Select a synced repository"
      : "Select a GitHub installation");

  return (
    <section className="overflow-hidden rounded-3xl border border-border bg-popover shadow-[var(--shadow-sm)]">
      <div className="grid min-h-[calc(100svh-9.5rem)] gap-0 xl:grid-cols-[1.45fr_0.65fr]">
        <form
          id="new-sandbox-form"
          onSubmit={handleSubmit}
          className="border-b border-rule-faint xl:border-b-0 xl:border-r"
        >
          <header className="border-b border-rule-faint px-8 py-10 sm:px-10">
            <p className="ev-eyebrow">New sandbox</p>
            <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Create sandbox spec
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">
              Configure operational parameters for a new sandbox and submit one typed launch request
              through the control plane.
            </p>
          </header>

          <div className="space-y-0">
            <FormSection
              index="01"
              title="Sandbox Source"
              content={
                <div className="space-y-5">
                  <LabeledField label="Source Mode">
                    <div className="grid gap-2 sm:grid-cols-2">
                      {[
                        {
                          value: "git",
                          title: "Raw Git URL",
                          detail: "Paste any public or generic repository URL.",
                        },
                        {
                          value: "github",
                          title: "GitHub App",
                          detail: "Use a granted installation and synced private repository cache.",
                        },
                      ].map((option) => {
                        const isActive = form.sourceMode === option.value;

                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => {
                              setField("sourceMode", option.value as SourceMode);
                            }}
                            className={
                              isActive
                                ? "rounded-2xl border border-primary bg-accent px-4 py-3.5 text-left shadow-[var(--shadow-xs)]"
                                : "rounded-2xl border border-border bg-card px-4 py-3.5 text-left shadow-[var(--shadow-xs)] transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-sm)]"
                            }
                          >
                            <p className="ev-eyebrow">Mode</p>
                            <p className="mt-1.5 text-sm font-medium text-foreground">
                              {option.title}
                            </p>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                              {option.detail}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  </LabeledField>

                  {form.sourceMode === "git" ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <LabeledField label="Repository URL">
                        <input
                          value={form.sandboxSource}
                          onChange={(event) => {
                            setField("sandboxSource", event.target.value);
                          }}
                          placeholder="github.com/sealant-ops/core"
                          className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </LabeledField>

                      <LabeledField label="Branch / Commit">
                        <input
                          value={form.branch}
                          onChange={(event) => {
                            setField("branch", event.target.value);
                          }}
                          placeholder="main"
                          className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </LabeledField>
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-border bg-background">
                      <button
                        type="button"
                        onClick={() => {
                          setIsSourceGitHubExpanded((current) => !current);
                        }}
                        className="flex w-full items-start justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/30"
                        aria-expanded={isSourceGitHubExpanded}
                      >
                        <div>
                          <p className="ev-eyebrow">GitHub app source</p>
                          <p className="mt-2 text-sm leading-6 text-foreground">
                            {sourceGitHubSummary}
                          </p>
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {isSourceGitHubExpanded ? "Collapse" : "Expand"}
                        </span>
                      </button>

                      {isSourceGitHubExpanded ? (
                        <div className="space-y-4 border-t border-border px-4 py-4">
                          {availableGitHubInstallations.length === 1 ? null : (
                            <div className="flex flex-col gap-3 rounded-2xl border border-border bg-background px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                              <div>
                                <p className="ev-eyebrow">Installation access</p>
                                <p className="mt-2 text-sm leading-7 text-foreground">
                                  Import an installation once, then select any synced repository it
                                  exposes.
                                </p>
                              </div>
                              <a
                                href="/github/setup"
                                className="inline-flex h-10 items-center justify-center rounded-lg border border-input px-4 text-sm text-foreground no-underline transition-colors hover:border-foreground"
                              >
                                Manage GitHub access
                              </a>
                            </div>
                          )}

                          {githubInstallationsQuery.isLoading ? (
                            <div className="rounded-2xl border border-border bg-card px-4 py-4 text-sm leading-7 text-muted-foreground">
                              Loading granted GitHub installations...
                            </div>
                          ) : githubInstallationsQuery.isError ? (
                            <div className="border-l-2 border-danger-dot py-1 pl-3 text-sm leading-7 text-danger">
                              {resolveErrorMessage(githubInstallationsQuery.error)}
                            </div>
                          ) : availableGitHubInstallations.length === 0 ? (
                            <div className="rounded-2xl border border-border bg-card px-4 py-4 text-sm leading-7 text-muted-foreground">
                              No granted GitHub installations are available yet. Open GitHub setup,
                              import an installation, then come back here.
                            </div>
                          ) : (
                            <>
                              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                                <LabeledField label="GitHub Installation">
                                  <div className="relative">
                                    <select
                                      value={form.githubInstallationId}
                                      onChange={(event) => {
                                        setField("githubInstallationId", event.target.value);
                                      }}
                                      className="h-11 w-full appearance-none rounded-lg border border-input bg-background pl-3 pr-14 text-sm text-foreground focus:border-primary focus:outline-none"
                                    >
                                      <option value="">Select installation</option>
                                      {availableGitHubInstallations.map((installation) => (
                                        <option
                                          key={installation.installationId}
                                          value={installation.installationId}
                                        >
                                          {installation.accountLogin} ({installation.accountType})
                                        </option>
                                      ))}
                                    </select>
                                    <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-muted-foreground">
                                      <svg
                                        viewBox="0 0 12 12"
                                        aria-hidden="true"
                                        className="h-3.5 w-3.5"
                                      >
                                        <path
                                          d="M3 4.5L6 7.5L9 4.5"
                                          fill="none"
                                          stroke="currentColor"
                                        />
                                      </svg>
                                    </span>
                                  </div>
                                </LabeledField>

                                <div className="flex items-end">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="h-11 px-4"
                                    disabled={
                                      normalizeRequiredValue(form.githubInstallationId).length ===
                                        0 || syncGitHubInstallationMutation.isPending
                                    }
                                    onClick={() => {
                                      if (
                                        normalizeRequiredValue(form.githubInstallationId).length ===
                                        0
                                      ) {
                                        return;
                                      }

                                      setSubmitError(null);
                                      syncGitHubInstallationMutation.mutate({
                                        installationId: form.githubInstallationId,
                                      });
                                    }}
                                  >
                                    {syncGitHubInstallationMutation.isPending
                                      ? "Refreshing..."
                                      : "Refresh repos"}
                                  </Button>
                                </div>
                              </div>

                              <div className="grid gap-4 sm:grid-cols-2">
                                <LabeledField label="Search Synced Repositories">
                                  <input
                                    value={githubRepositorySearch}
                                    onChange={(event) => {
                                      setGitHubRepositorySearch(event.target.value);
                                    }}
                                    placeholder="Filter by owner or repository"
                                    className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                                    autoComplete="off"
                                    spellCheck={false}
                                  />
                                </LabeledField>

                                <LabeledField label="Branch / Ref (Optional)">
                                  <input
                                    value={form.branch}
                                    onChange={(event) => {
                                      setField("branch", event.target.value);
                                    }}
                                    placeholder={
                                      selectedGitHubRepository?.defaultBranch ?? "default branch"
                                    }
                                    className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                                    autoComplete="off"
                                    spellCheck={false}
                                  />
                                </LabeledField>
                              </div>

                              {syncGitHubInstallationMutation.error instanceof Error ? (
                                <div className="border-l-2 border-danger-dot py-1 pl-3 text-sm text-danger">
                                  {syncGitHubInstallationMutation.error.message}
                                </div>
                              ) : null}

                              <LabeledField label="Repository Picker">
                                <div className="overflow-hidden rounded-2xl border border-border bg-card">
                                  {normalizeRequiredValue(form.githubInstallationId).length ===
                                  0 ? (
                                    <div className="px-4 py-4 text-sm text-muted-foreground">
                                      Select an installation to view its synced repositories.
                                    </div>
                                  ) : githubRepositoriesQuery.isLoading ? (
                                    <div className="px-4 py-4 text-sm text-muted-foreground">
                                      Loading synced repositories...
                                    </div>
                                  ) : githubRepositoriesQuery.isError ? (
                                    <div className="px-4 py-4 text-sm text-destructive">
                                      {resolveErrorMessage(githubRepositoriesQuery.error)}
                                    </div>
                                  ) : filteredGitHubRepositories.length === 0 ? (
                                    <div className="px-4 py-4 text-sm text-muted-foreground">
                                      No synced repositories matched this filter.
                                    </div>
                                  ) : (
                                    <div className="max-h-72 overflow-auto">
                                      {filteredGitHubRepositories.map((repository) => {
                                        const isActive =
                                          repository.installationRepositoryId ===
                                          form.githubInstallationRepositoryId;

                                        return (
                                          <button
                                            key={repository.installationRepositoryId}
                                            type="button"
                                            onClick={() => {
                                              setField(
                                                "githubInstallationRepositoryId",
                                                repository.installationRepositoryId,
                                              );
                                              if (
                                                normalizeOptionalValue(form.branch).length === 0
                                              ) {
                                                setField("branch", repository.defaultBranch);
                                              }
                                            }}
                                            className={
                                              isActive
                                                ? "grid w-full gap-2 border-b border-border bg-accent px-4 py-4 text-left last:border-b-0"
                                                : "grid w-full gap-2 border-b border-border bg-card px-4 py-4 text-left transition-colors hover:bg-muted/40 last:border-b-0"
                                            }
                                          >
                                            <div className="flex items-center justify-between gap-3">
                                              <p className="font-mono text-[0.72rem] text-foreground">
                                                {repository.fullName}
                                              </p>
                                              <span className="ev-eyebrow">
                                                {repository.isPrivate ? "Private" : "Public"}
                                              </span>
                                            </div>
                                            <p className="font-mono text-[0.66rem] text-faint">
                                              default {repository.defaultBranch}
                                              {repository.isArchived ? " · archived" : ""}
                                            </p>
                                          </button>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              </LabeledField>
                            </>
                          )}
                        </div>
                      ) : null}
                    </div>
                  )}

                  <div className="rounded-2xl border border-border bg-background">
                    <button
                      type="button"
                      onClick={() => {
                        setIsConfigRepoExpanded((current) => !current);
                      }}
                      className="flex w-full items-start justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/30"
                      aria-expanded={isConfigRepoExpanded}
                    >
                      <div>
                        <p className="ev-eyebrow">Config repo (dotfiles, optional)</p>
                        <p className="mt-2 text-sm leading-6 text-foreground">
                          {configRepoSummary}
                        </p>
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {isConfigRepoExpanded ? "Collapse" : "Expand"}
                      </span>
                    </button>

                    {isConfigRepoExpanded ? (
                      <div className="border-t border-border px-4 py-4">
                        <LabeledField label="Config Repo Mode">
                          <div className="space-y-4">
                            <div className="grid gap-2 sm:grid-cols-3">
                              {[
                                { value: "none", label: "None" },
                                { value: "git", label: "Raw Git URL" },
                                { value: "github", label: "GitHub App" },
                              ].map((option) => {
                                const isActive = form.configRepoMode === option.value;

                                return (
                                  <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => {
                                      setField("configRepoMode", option.value as ConfigRepoMode);
                                    }}
                                    className={
                                      isActive
                                        ? "h-10 rounded-lg border border-primary bg-primary text-sm text-primary-foreground"
                                        : "h-10 rounded-lg border border-input bg-card text-sm text-foreground transition-colors hover:border-foreground"
                                    }
                                  >
                                    {option.label}
                                  </button>
                                );
                              })}
                            </div>

                            {form.configRepoMode === "none" ? (
                              <p className="text-xs leading-6 text-muted-foreground">
                                No dotfiles config repo will be applied.
                              </p>
                            ) : form.configRepoMode === "git" ? (
                              <div className="grid gap-4 sm:grid-cols-2">
                                <LabeledField label="Config Repo URL">
                                  <input
                                    value={form.configRepoUrl}
                                    onChange={(event) => {
                                      setField("configRepoUrl", event.target.value);
                                    }}
                                    placeholder="github.com/owner/dotfiles"
                                    className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                                    autoComplete="off"
                                    spellCheck={false}
                                  />
                                </LabeledField>

                                <LabeledField label="Config Repo Branch / Ref (Optional)">
                                  <input
                                    value={form.configRepoRef}
                                    onChange={(event) => {
                                      setField("configRepoRef", event.target.value);
                                    }}
                                    placeholder="main"
                                    className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                                    autoComplete="off"
                                    spellCheck={false}
                                  />
                                </LabeledField>
                              </div>
                            ) : (
                              <div className="space-y-4">
                                <div className="grid gap-4 sm:grid-cols-2">
                                  <LabeledField label="GitHub Installation (Config Repo)">
                                    <div className="relative">
                                      <select
                                        value={form.configRepoGitHubInstallationId}
                                        onChange={(event) => {
                                          setField(
                                            "configRepoGitHubInstallationId",
                                            event.target.value,
                                          );
                                        }}
                                        className="h-11 w-full appearance-none rounded-lg border border-input bg-background pl-3 pr-14 text-sm text-foreground focus:border-primary focus:outline-none"
                                      >
                                        <option value="">Select installation</option>
                                        {availableGitHubInstallations.map((installation) => (
                                          <option
                                            key={installation.installationId}
                                            value={installation.installationId}
                                          >
                                            {installation.accountLogin} ({installation.accountType})
                                          </option>
                                        ))}
                                      </select>
                                      <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-muted-foreground">
                                        <svg
                                          viewBox="0 0 12 12"
                                          aria-hidden="true"
                                          className="h-3.5 w-3.5"
                                        >
                                          <path
                                            d="M3 4.5L6 7.5L9 4.5"
                                            fill="none"
                                            stroke="currentColor"
                                          />
                                        </svg>
                                      </span>
                                    </div>
                                  </LabeledField>

                                  <LabeledField label="Config Repo Branch / Ref (Optional)">
                                    <input
                                      value={form.configRepoRef}
                                      onChange={(event) => {
                                        setField("configRepoRef", event.target.value);
                                      }}
                                      placeholder={
                                        selectedConfigGitHubRepository?.defaultBranch ??
                                        "default branch"
                                      }
                                      className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                                      autoComplete="off"
                                      spellCheck={false}
                                    />
                                  </LabeledField>
                                </div>

                                <LabeledField label="Search Config Repositories">
                                  <input
                                    value={configGitHubRepositorySearch}
                                    onChange={(event) => {
                                      setConfigGitHubRepositorySearch(event.target.value);
                                    }}
                                    placeholder="Filter by owner or repository"
                                    className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                                    autoComplete="off"
                                    spellCheck={false}
                                  />
                                </LabeledField>

                                <LabeledField label="Config Repo Picker">
                                  <div className="overflow-hidden rounded-2xl border border-border bg-card">
                                    {normalizeRequiredValue(form.configRepoGitHubInstallationId)
                                      .length === 0 ? (
                                      <div className="px-4 py-4 text-sm text-muted-foreground">
                                        Select an installation to view synced repositories.
                                      </div>
                                    ) : configGithubRepositoriesQuery.isLoading ? (
                                      <div className="px-4 py-4 text-sm text-muted-foreground">
                                        Loading synced repositories...
                                      </div>
                                    ) : configGithubRepositoriesQuery.isError ? (
                                      <div className="px-4 py-4 text-sm text-destructive">
                                        {resolveErrorMessage(configGithubRepositoriesQuery.error)}
                                      </div>
                                    ) : filteredConfigGitHubRepositories.length === 0 ? (
                                      <div className="px-4 py-4 text-sm text-muted-foreground">
                                        No synced repositories matched this filter.
                                      </div>
                                    ) : (
                                      <div className="max-h-60 overflow-auto">
                                        {filteredConfigGitHubRepositories.map((repository) => {
                                          const isActive =
                                            repository.installationRepositoryId ===
                                            form.configRepoGitHubInstallationRepositoryId;

                                          return (
                                            <button
                                              key={repository.installationRepositoryId}
                                              type="button"
                                              onClick={() => {
                                                setField(
                                                  "configRepoGitHubInstallationRepositoryId",
                                                  repository.installationRepositoryId,
                                                );
                                                if (
                                                  normalizeOptionalValue(form.configRepoRef)
                                                    .length === 0
                                                ) {
                                                  setField(
                                                    "configRepoRef",
                                                    repository.defaultBranch,
                                                  );
                                                }
                                              }}
                                              className={
                                                isActive
                                                  ? "grid w-full gap-2 border-b border-border bg-accent px-4 py-3 text-left last:border-b-0"
                                                  : "grid w-full gap-2 border-b border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/40 last:border-b-0"
                                              }
                                            >
                                              <div className="flex items-center justify-between gap-3">
                                                <p className="font-mono text-[0.7rem] text-foreground">
                                                  {repository.fullName}
                                                </p>
                                                <span className="ev-eyebrow">
                                                  {repository.isPrivate ? "Private" : "Public"}
                                                </span>
                                              </div>
                                            </button>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                </LabeledField>
                              </div>
                            )}

                            {form.configRepoMode === "none" ? null : (
                              <div className="space-y-4 rounded-2xl border border-border bg-card px-4 py-4">
                                <div className="grid gap-4 sm:grid-cols-2">
                                  <LabeledField label="Config Strategy">
                                    <div className="relative">
                                      <select
                                        value={form.configRepoManager}
                                        onChange={(event) => {
                                          setField(
                                            "configRepoManager",
                                            parseDotfilesManager(event.target.value),
                                          );
                                        }}
                                        className="h-11 w-full appearance-none rounded-lg border border-input bg-background pl-3 pr-14 text-sm text-foreground focus:border-primary focus:outline-none"
                                      >
                                        {DOTFILES_MANAGER_OPTIONS.map((option) => (
                                          <option key={option.value} value={option.value}>
                                            {option.label}
                                          </option>
                                        ))}
                                      </select>
                                      <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-muted-foreground">
                                        <svg
                                          viewBox="0 0 12 12"
                                          aria-hidden="true"
                                          className="h-3.5 w-3.5"
                                        >
                                          <path
                                            d="M3 4.5L6 7.5L9 4.5"
                                            fill="none"
                                            stroke="currentColor"
                                          />
                                        </svg>
                                      </span>
                                    </div>
                                  </LabeledField>

                                  <LabeledField label="Apply Target">
                                    <div className="relative">
                                      <select
                                        value={form.configRepoTarget}
                                        onChange={(event) => {
                                          setField(
                                            "configRepoTarget",
                                            parseDotfilesTarget(event.target.value),
                                          );
                                        }}
                                        className="h-11 w-full appearance-none rounded-lg border border-input bg-background pl-3 pr-14 text-sm text-foreground focus:border-primary focus:outline-none"
                                      >
                                        {DOTFILES_TARGET_OPTIONS.map((option) => (
                                          <option key={option.value} value={option.value}>
                                            {option.label}
                                          </option>
                                        ))}
                                      </select>
                                      <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-muted-foreground">
                                        <svg
                                          viewBox="0 0 12 12"
                                          aria-hidden="true"
                                          className="h-3.5 w-3.5"
                                        >
                                          <path
                                            d="M3 4.5L6 7.5L9 4.5"
                                            fill="none"
                                            stroke="currentColor"
                                          />
                                        </svg>
                                      </span>
                                    </div>
                                  </LabeledField>
                                </div>

                                <label className="flex items-center gap-3 text-sm text-foreground">
                                  <input
                                    type="checkbox"
                                    checked={form.configRepoRunBootstrap}
                                    onChange={(event) => {
                                      setField("configRepoRunBootstrap", event.target.checked);
                                    }}
                                    className="h-4 w-4 border border-border bg-background"
                                  />
                                  Run bootstrap command after apply
                                </label>

                                {form.configRepoRunBootstrap ? (
                                  <LabeledField label="Bootstrap Command">
                                    <input
                                      value={form.configRepoBootstrapCommand}
                                      onChange={(event) => {
                                        setField("configRepoBootstrapCommand", event.target.value);
                                      }}
                                      placeholder="./install.sh"
                                      className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                                      autoComplete="off"
                                      spellCheck={false}
                                    />
                                  </LabeledField>
                                ) : null}
                              </div>
                            )}
                          </div>
                        </LabeledField>
                      </div>
                    ) : null}
                  </div>
                </div>
              }
            />

            <FormSection
              index="02"
              title="Execution Environment"
              content={
                <div className="space-y-5">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <LabeledField label="Harness Type">
                      <div className="relative">
                        <select
                          value={form.harness}
                          onChange={(event) => {
                            setField("harness", parseHarnessId(event.target.value));
                          }}
                          className="h-11 w-full appearance-none rounded-lg border border-input bg-background pl-3 pr-14 text-sm text-foreground focus:border-primary focus:outline-none"
                        >
                          {HARNESS_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-muted-foreground">
                          <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3.5 w-3.5">
                            <path d="M3 4.5L6 7.5L9 4.5" fill="none" stroke="currentColor" />
                          </svg>
                        </span>
                      </div>
                    </LabeledField>

                    <LabeledField label="Target OS">
                      <div className="grid grid-cols-3 gap-2">
                        {TARGET_OS_OPTIONS.map((option) => {
                          const isActive = form.targetOs === option.value;

                          return (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => {
                                setField("targetOs", option.value);
                              }}
                              className={
                                isActive
                                  ? "h-11 rounded-lg border border-primary bg-primary px-2 text-sm text-primary-foreground"
                                  : "h-11 rounded-lg border border-input bg-card px-2 text-sm text-foreground transition-colors hover:border-foreground"
                              }
                            >
                              {option.label}
                            </button>
                          );
                        })}
                      </div>
                    </LabeledField>

                    <LabeledField label="Default Shell">
                      <div className="relative">
                        <select
                          value={form.defaultShell}
                          onChange={(event) => {
                            setField("defaultShell", parseLoginShell(event.target.value));
                          }}
                          className="h-11 w-full appearance-none rounded-lg border border-input bg-background pl-3 pr-14 text-sm text-foreground focus:border-primary focus:outline-none"
                        >
                          {SHELL_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-muted-foreground">
                          <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3.5 w-3.5">
                            <path d="M3 4.5L6 7.5L9 4.5" fill="none" stroke="currentColor" />
                          </svg>
                        </span>
                      </div>
                    </LabeledField>
                  </div>

                  <LabeledField label="OCI Runtime">
                    <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        {OCI_RUNTIME_OPTIONS.map((option) => {
                          const isActive = form.ociRuntime === option.value;

                          return (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => {
                                setField("ociRuntime", option.value);
                              }}
                              className={
                                isActive
                                  ? "rounded-2xl border border-primary bg-accent px-4 py-4 text-left shadow-[var(--shadow-xs)]"
                                  : "rounded-2xl border border-border bg-card px-4 py-4 text-left shadow-[var(--shadow-xs)] transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-sm)]"
                              }
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="font-mono text-lg leading-none text-foreground">
                                    {option.label}
                                  </p>
                                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                                    {option.detail}
                                  </p>
                                </div>
                                {isActive ? (
                                  <span className="inline-flex items-center gap-1.5 text-xs text-primary">
                                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                                    Active
                                  </span>
                                ) : (
                                  <span className="text-xs text-muted-foreground">Ready</span>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <p className="font-mono text-[0.66rem] leading-6 text-faint">
                        `runsc` launches require the worker Docker host to have the gVisor runtime
                        registered.
                      </p>
                    </div>
                  </LabeledField>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <LabeledField label="Registry ID">
                      <input
                        value={selectedRegistryId}
                        onChange={(event) => {
                          setField("registryId", event.target.value);
                        }}
                        className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                        placeholder="default"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </LabeledField>

                    <LabeledField label="Image Repository">
                      <input
                        value={form.artifactRepository}
                        onChange={(event) => {
                          setField("artifactRepository", event.target.value);
                        }}
                        className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                        placeholder="sealant/sandboxes/demo"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </LabeledField>

                    <LabeledField label="Image Tag">
                      <input
                        value={form.artifactTag}
                        onChange={(event) => {
                          setField("artifactTag", event.target.value);
                        }}
                        className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                        placeholder="opencode"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </LabeledField>
                  </div>
                </div>
              }
            />

            <FormSection
              index="03"
              title="Build Dependencies"
              content={
                <div>
                  <LabeledField label="Package Inventory">
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-2">
                        {form.packages.map((pkg) => {
                          const validation = packageValidationById.get(pkg);
                          const packageState = validation?.state ?? "pending";

                          return (
                            <button
                              key={pkg}
                              type="button"
                              className="inline-flex h-8 items-center gap-2 rounded-lg border border-input bg-card px-2.5 font-mono text-[0.66rem] text-foreground transition-colors hover:border-foreground"
                              onClick={() => {
                                setField(
                                  "packages",
                                  form.packages.filter((entry) => entry !== pkg),
                                );
                              }}
                              aria-label={`Remove package ${pkg}`}
                              title={validation?.message}
                            >
                              <span
                                aria-hidden
                                className={
                                  packageState === "invalid"
                                    ? "h-1.5 w-1.5 rounded-full bg-warning-dot"
                                    : packageState === "valid"
                                      ? "h-1.5 w-1.5 rounded-full bg-success-dot"
                                      : "h-1.5 w-1.5 rounded-full border border-input"
                                }
                              />
                              <span>{pkg}</span>
                              <span aria-hidden className="text-faint">
                                ×
                              </span>
                            </button>
                          );
                        })}
                      </div>

                      {packageValidationIssues.length > 0 ? (
                        <div className="space-y-1 border-l-2 border-warning-dot py-1 pl-3">
                          {packageValidationIssues.map((issue) => (
                            <p key={issue} className="text-sm leading-6 text-warning">
                              {issue}
                            </p>
                          ))}
                        </div>
                      ) : null}

                      <div className="flex flex-col gap-2 sm:flex-row">
                        <input
                          value={packageInput}
                          onChange={(event) => {
                            setPackageInput(event.target.value);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              appendPackage();
                            }
                          }}
                          className="h-10 w-full rounded-lg border border-dashed border-input bg-background px-3 font-mono text-[0.7rem] text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                          placeholder="Add package (for example: ripgrep)"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          className="h-10 px-4"
                          onClick={appendPackage}
                        >
                          Add package
                        </Button>
                      </div>
                    </div>
                  </LabeledField>
                </div>
              }
            />

            <FormSection
              index="04"
              title="Runtime Commands"
              content={
                <div className="space-y-6">
                  <LabeledField label="Setup Steps (Ordered, Optional)">
                    <div className="space-y-2">
                      {form.setupSteps.map((command, index) => (
                        <div
                          key={`${command}-${index}`}
                          className="grid grid-cols-[2rem_1fr_auto] gap-2"
                        >
                          <span className="flex h-10 items-center justify-center font-mono text-[0.7rem] text-faint">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <input
                            value={command}
                            onChange={(event) => {
                              const nextCommands = [...form.setupSteps];
                              nextCommands[index] = event.target.value;
                              setField("setupSteps", nextCommands);
                            }}
                            className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-[0.74rem] text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            className="h-10 px-3"
                            onClick={() => {
                              setField(
                                "setupSteps",
                                form.setupSteps.filter((_, commandIndex) => commandIndex !== index),
                              );
                            }}
                          >
                            Remove
                          </Button>
                        </div>
                      ))}

                      <div className="grid grid-cols-[2rem_1fr_auto] gap-2">
                        <span className="flex h-10 items-center justify-center font-mono text-[0.7rem] text-faint">
                          +
                        </span>
                        <input
                          value={setupStepInput}
                          onChange={(event) => {
                            setSetupStepInput(event.target.value);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              appendSetupCommand();
                            }
                          }}
                          className="h-10 w-full rounded-lg border border-dashed border-input bg-background px-3 font-mono text-[0.74rem] text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                          placeholder="Append command"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          className="h-10 px-3"
                          onClick={appendSetupCommand}
                        >
                          Append
                        </Button>
                      </div>
                    </div>
                  </LabeledField>

                  <LabeledField label="Entrypoint Command (Optional)">
                    <input
                      value={form.entrypoint}
                      onChange={(event) => {
                        setField("entrypoint", event.target.value);
                      }}
                      className="h-11 w-full rounded-lg border border-input bg-background px-3 font-mono text-[0.74rem] text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                      placeholder="pnpm dev"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </LabeledField>
                </div>
              }
            />

            <FormSection
              index="05"
              title="Security & Access"
              content={
                <div className="space-y-4">
                  <button
                    type="button"
                    onClick={() => {
                      setField("sshEnabled", !form.sshEnabled);
                    }}
                    className="flex w-full items-center justify-between rounded-2xl border border-border bg-background px-4 py-4 text-left transition-colors hover:border-input"
                    role="switch"
                    aria-checked={form.sshEnabled}
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">Enable SSH tunneling</p>
                      <p className="mt-1 text-xs leading-6 text-muted-foreground">
                        Allow direct terminal access to the active sandbox runtime endpoint.
                      </p>
                    </div>
                    <span
                      className={
                        form.sshEnabled
                          ? "inline-flex items-center gap-1.5 text-sm text-primary"
                          : "inline-flex items-center gap-1.5 text-sm text-muted-foreground"
                      }
                    >
                      <span
                        aria-hidden
                        className={
                          form.sshEnabled
                            ? "h-1.5 w-1.5 rounded-full bg-primary"
                            : "h-1.5 w-1.5 rounded-full border border-input"
                        }
                      />
                      {form.sshEnabled ? "On" : "Off"}
                    </span>
                  </button>

                  {form.sshEnabled ? (
                    sshKeysQuery.isLoading ? (
                      <div className="rounded-2xl border border-rule-faint bg-background px-4 py-4 text-sm text-muted-foreground">
                        Checking your registered SSH keys...
                      </div>
                    ) : registeredSshKeyCount > 0 ? (
                      <div className="flex items-center gap-2 rounded-2xl border border-rule-faint bg-background px-4 py-4">
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success-dot" />
                        <p className="text-sm leading-6 text-muted-foreground">
                          {registeredSshKeyCount} SSH {registeredSshKeyCount === 1 ? "key" : "keys"}{" "}
                          registered to your account — you can connect right after launch.
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-warning-dot/40 bg-background px-4 py-4">
                        <p className="text-sm font-medium text-warning">
                          No SSH keys registered — add one to connect to this sandbox
                        </p>
                        <p className="mt-1 text-xs leading-6 text-muted-foreground">
                          Paste your public key (usually{" "}
                          <span className="font-mono">~/.ssh/id_ed25519.pub</span>). It registers to
                          your account, so it works for every sandbox you own. You can also add one
                          later from Settings → SSH keys.
                        </p>
                        <textarea
                          value={sshKeyInput}
                          onChange={(event) => {
                            setSshKeyInput(event.target.value);
                          }}
                          rows={3}
                          className="mt-3 w-full rounded-lg border border-input bg-background px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground placeholder:text-faint focus:border-primary focus:outline-none"
                          placeholder="ssh-ed25519 AAAA... user@host"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        {addSshKeyMutation.error instanceof Error ? (
                          <p className="mt-2 text-xs leading-6 text-danger">
                            {addSshKeyMutation.error.message}
                          </p>
                        ) : null}
                        <div className="mt-3">
                          <Button
                            type="button"
                            variant="outline"
                            className="h-10 px-4"
                            disabled={
                              addSshKeyMutation.isPending || sshKeyInput.trim().length === 0
                            }
                            onClick={() => {
                              addSshKeyMutation.mutate({ publicKey: sshKeyInput.trim() });
                            }}
                          >
                            {addSshKeyMutation.isPending ? "Registering..." : "Register key"}
                          </Button>
                        </div>
                      </div>
                    )
                  ) : null}
                </div>
              }
            />

            {formErrors.length > 0 ? (
              <div className="border-t border-rule-faint px-8 py-6 sm:px-10">
                <div className="border-l-2 border-danger-dot py-1 pl-3">
                  <p className="text-sm font-medium text-danger">
                    Fix the fields below before starting the sandbox
                  </p>
                  <ul className="mt-2 space-y-1 text-sm leading-6 text-ink-2">
                    {formErrors.map((error) => (
                      <li key={error}>• {error}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {submitError === null ? null : (
              <div className="border-t border-rule-faint px-8 py-6 sm:px-10">
                <div className="border-l-2 border-danger-dot py-1 pl-3">
                  <p className="text-sm font-medium text-danger">Launch request failed</p>
                  <p className="mt-2 text-sm leading-6 text-ink-2">{submitError}</p>
                </div>
              </div>
            )}
          </div>
        </form>

        <aside className="border-t border-rule-faint bg-card px-6 py-8 sm:px-8 xl:border-t-0">
          <div className="xl:sticky xl:top-6">
            <h2 className="font-display text-xl font-semibold tracking-tight text-foreground">
              Live preview
            </h2>

            <div className="mt-6 border-t border-rule-faint pt-6">
              <p className="ev-eyebrow">Operational summary</p>

              <dl className="mt-4 space-y-2.5 text-sm">
                <SummaryRow
                  label="Target"
                  value={previewManifest.spec.sources.sandbox.url}
                  highlighted
                />
                <SummaryRow label="Harness" value={previewManifest.spec.harness.id} />
                <SummaryRow label="Target OS" value={previewManifest.spec.target.os.family} />
                <SummaryRow label="OCI runtime" value={previewManifest.spec.runtime.ociRuntime} />
                <SummaryRow
                  label="Packages"
                  value={String(previewManifest.spec.tooling.packages.length)}
                />
                <SummaryRow
                  label="Config repo"
                  value={
                    form.configRepoMode === "none"
                      ? "disabled"
                      : (previewManifest.spec.sources.inputs[0]?.url ?? "pending selection")
                  }
                  highlighted={form.configRepoMode !== "none"}
                />
                <SummaryRow
                  label="Config strategy"
                  value={
                    form.configRepoMode === "none"
                      ? "n/a"
                      : `${form.configRepoManager} @ ${form.configRepoTarget === "home" ? "home" : "config"}`
                  }
                />
                <SummaryRow
                  label="SSH state"
                  value={previewManifest.spec.access.ssh.enabled ? "active" : "disabled"}
                  highlighted={previewManifest.spec.access.ssh.enabled}
                />
              </dl>
            </div>

            <div className="mt-7 border-t border-rule-faint pt-6">
              <p className="ev-eyebrow">Raw manifest (JSON)</p>
              <pre className="mt-3 max-h-72 overflow-auto rounded-xl border border-border bg-background p-4 font-mono text-[0.66rem] leading-6 text-ink-2">
                {JSON.stringify(previewManifest, null, 2)}
              </pre>
            </div>

            <div className="mt-7 border-t border-rule-faint pt-6">
              <p className="ev-eyebrow">Health check</p>
              <div className="mt-3 space-y-2">
                <HealthRow
                  ok={form.sourceMode === "github" ? githubSourceReady : hasValidRepositoryUrl}
                  text={
                    form.sourceMode === "github"
                      ? githubSourceReady
                        ? "GitHub installation and repository selected"
                        : "Select a GitHub installation and repository"
                      : hasValidRepositoryUrl
                        ? "Repository source validated"
                        : "Repository source is invalid"
                  }
                />
                <HealthRow
                  ok={previewManifest.spec.harness.id.length > 0}
                  text={
                    previewManifest.spec.harness.id.length > 0
                      ? "Harness profile allocated"
                      : "Harness profile is missing"
                  }
                />
                <HealthRow
                  ok={configRepoReady}
                  text={
                    form.configRepoMode === "none"
                      ? "Config repo disabled"
                      : form.configRepoMode === "github"
                        ? configRepoReady
                          ? "Config repo GitHub selection is ready"
                          : "Select installation and repository for config repo"
                        : hasValidConfigRepositoryUrl
                          ? "Config repo source validated"
                          : "Config repo source is invalid"
                  }
                />
                <HealthRow
                  ok={compatibilityIssues.length === 0}
                  text={
                    compatibilityIssues.length === 0
                      ? "Package inventory validated"
                      : "Package inventory has compatibility warnings"
                  }
                />
                {/* Warning only — keys can be added after launch, so this never blocks create. */}
                <HealthRow
                  ok={!form.sshEnabled || registeredSshKeyCount > 0}
                  text={
                    !form.sshEnabled
                      ? "SSH tunneling disabled"
                      : registeredSshKeyCount > 0
                        ? "SSH key registered for gateway access"
                        : "SSH enabled but no keys registered yet"
                  }
                />
                {compatibilityIssues.length > 0 ? (
                  <p className="text-sm leading-6 text-warning">{compatibilityIssues[0]}</p>
                ) : null}
              </div>
            </div>

            <div className="mt-10 space-y-3 border-t border-rule-faint pt-6">
              <Button
                type="submit"
                className="h-12 w-full"
                disabled={createSandboxMutation.isPending}
                form="new-sandbox-form"
              >
                {createSandboxMutation.isPending ? "Starting sandbox..." : "Start sandbox"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-12 w-full"
                onClick={() => {
                  setForm(createInitialFormState("default"));
                  setIsSourceGitHubExpanded(false);
                  setIsConfigRepoExpanded(false);
                  setFormErrors([]);
                  setSubmitError(null);
                }}
                disabled={createSandboxMutation.isPending}
              >
                Reset spec
              </Button>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

function FormSection(props: {
  readonly index: string;
  readonly title: string;
  readonly content: ReactNode;
}) {
  return (
    <section className="border-t border-rule-faint px-8 py-8 sm:px-10">
      <h2 className="flex items-baseline gap-3 text-lg font-semibold tracking-tight text-foreground">
        <span className="font-mono text-[0.8rem] font-medium text-primary">{props.index}</span>
        {props.title}
      </h2>
      <div className="mt-5">{props.content}</div>
    </section>
  );
}

function LabeledField(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="ev-eyebrow">{props.label}</span>
      {props.children}
    </label>
  );
}

function SummaryRow(props: {
  readonly label: string;
  readonly value: string;
  readonly highlighted?: boolean;
}) {
  return (
    <div className="grid grid-cols-[6.4rem_1fr] items-start gap-3">
      <dt className="text-xs text-label">{props.label}</dt>
      <dd
        className={
          props.highlighted
            ? "font-mono text-[0.7rem] text-primary"
            : "font-mono text-[0.7rem] text-foreground"
        }
      >
        {props.value}
      </dd>
    </div>
  );
}

function HealthRow(props: { readonly ok: boolean; readonly text: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className={
          props.ok
            ? "h-1.5 w-1.5 shrink-0 rounded-full bg-success-dot"
            : "h-1.5 w-1.5 shrink-0 rounded-full bg-warning-dot"
        }
      />
      <p className={props.ok ? "text-sm text-success" : "text-sm text-warning"}>{props.text}</p>
    </div>
  );
}

function createInitialFormState(registryId: string): NewSandboxFormState {
  return {
    sourceMode: "git",
    sandboxSource: "https://github.com/sealant-ops/core",
    branch: "main",
    githubInstallationId: "",
    githubInstallationRepositoryId: "",
    configRepoMode: "none",
    configRepoUrl: "",
    configRepoRef: "",
    configRepoGitHubInstallationId: "",
    configRepoGitHubInstallationRepositoryId: "",
    configRepoManager: "auto",
    configRepoTarget: "home",
    configRepoRunBootstrap: true,
    configRepoBootstrapCommand: "./install.sh",
    harness: "opencode",
    defaultShell: "bash",
    targetOs: "fedora",
    ociRuntime: "runc",
    registryId,
    artifactRepository: "sealant/sandboxes/demo",
    artifactTag: "opencode",
    packages: [],
    setupSteps: [],
    entrypoint: "",
    sshEnabled: true,
  };
}

function trimValue(value: string): string {
  return value.trim();
}

const normalizeRequiredValue = trimValue;

const normalizeOptionalValue = trimValue;

function normalizePackageIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

const normalizeCommandStep = trimValue;

function parseHarnessId(value: string): HarnessId {
  if (value === "codex") {
    return "codex";
  }

  if (value === "claude-code") {
    return "claude-code";
  }

  return "opencode";
}

function parseLoginShell(value: string): LoginShell {
  if (value === "zsh") {
    return "zsh";
  }

  if (value === "fish") {
    return "fish";
  }

  return "bash";
}

function parseDotfilesManager(value: string): DotfilesManager {
  if (value === "chezmoi") {
    return "chezmoi";
  }

  if (value === "stow") {
    return "stow";
  }

  if (value === "copy") {
    return "copy";
  }

  return "auto";
}

function parseDotfilesTarget(value: string): DotfilesTarget {
  if (value === "config") {
    return "config";
  }

  return "home";
}

function normalizeRepositoryUrl(value: string): string {
  const trimmed = value.trim();

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

function buildGitHubRepositoryUrl(fullName: string): string {
  return `https://github.com/${fullName}.git`;
}

function isValidUrl(value: string): boolean {
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.href.length > 0;
  } catch {
    return false;
  }
}

function validateForm(
  form: NewSandboxFormState,
  registryId: string,
  compatibilityIssues: readonly string[],
): readonly string[] {
  const errors: string[] = [];

  if (form.sourceMode === "git") {
    const repositoryUrl = normalizeRepositoryUrl(form.sandboxSource);
    if (!isValidUrl(repositoryUrl)) {
      errors.push("Repository URL must be a valid URL.");
    }

    if (normalizeRequiredValue(form.branch).length === 0) {
      errors.push("Branch or commit is required.");
    }
  } else {
    if (normalizeRequiredValue(form.githubInstallationId).length === 0) {
      errors.push("Choose a GitHub installation.");
    }

    if (normalizeRequiredValue(form.githubInstallationRepositoryId).length === 0) {
      errors.push("Choose a GitHub repository.");
    }
  }

  if (form.configRepoMode === "git") {
    const configRepositoryUrl = normalizeRepositoryUrl(form.configRepoUrl);
    if (!isValidUrl(configRepositoryUrl)) {
      errors.push("Config repo URL must be a valid URL.");
    }
  }

  if (form.configRepoMode === "github") {
    if (normalizeRequiredValue(form.configRepoGitHubInstallationId).length === 0) {
      errors.push("Choose a GitHub installation for the config repo.");
    }

    if (normalizeRequiredValue(form.configRepoGitHubInstallationRepositoryId).length === 0) {
      errors.push("Choose a GitHub repository for the config repo.");
    }
  }

  if (
    form.configRepoMode !== "none" &&
    form.configRepoRunBootstrap &&
    normalizeRequiredValue(form.configRepoBootstrapCommand).length === 0
  ) {
    errors.push("Bootstrap command is required when bootstrap is enabled.");
  }

  if (normalizeRequiredValue(registryId).length === 0) {
    errors.push("Registry id is required.");
  }

  if (normalizeRequiredValue(form.artifactRepository).length === 0) {
    errors.push("Image repository is required.");
  }

  if (normalizeRequiredValue(form.artifactTag).length === 0) {
    errors.push("Image tag is required.");
  }

  if (compatibilityIssues.length > 0) {
    errors.push(...compatibilityIssues);
  }

  return errors;
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Unable to create sandbox right now.";
}
