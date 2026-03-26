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
  readonly workspaceSource: string;
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

export const Route = createFileRoute("/_authenticated/sandboxes/new" as never)({
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
  const effectiveWorkspaceSourceUrl =
    form.sourceMode === "github"
      ? selectedGitHubRepository === undefined
        ? "https://github.com/owner/repository.git"
        : buildGitHubRepositoryUrl(selectedGitHubRepository.fullName)
      : normalizeRepositoryUrl(form.workspaceSource);
  const effectiveWorkspaceRef =
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
    const normalizedSetupSteps = form.setupSteps
      .map(normalizeCommandStep)
      .filter((value) => value.length > 0);
    const normalizedEntrypoint = normalizeRequiredValue(form.entrypoint);
    const normalizedConfigRepoInput =
      form.configRepoMode === "none"
        ? undefined
        : {
            kind: "git" as const,
            purpose: "dotfiles" as const,
            ...(form.configRepoMode === "github" ? { provider: "github" as const } : {}),
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
        source: {
          url: effectiveWorkspaceSourceUrl,
          ref: effectiveWorkspaceRef,
        },
        harness: form.harness,
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
        os: form.targetOs,
        runtime: {
          ociRuntime: form.ociRuntime,
        },
        packages: form.packages,
        ssh: form.sshEnabled,
        ...(normalizedConfigRepoInput === undefined ? {} : { inputs: [normalizedConfigRepoInput] }),
        ...(normalizedSetupSteps.length === 0 ? {} : { setup: normalizedSetupSteps }),
        ...(normalizedEntrypoint.length === 0 ? {} : { startup: normalizedEntrypoint }),
      },
    };
  }, [
    effectiveConfigRepoRef,
    effectiveConfigRepoUrl,
    effectiveWorkspaceRef,
    effectiveWorkspaceSourceUrl,
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
            kind: "git" as const,
            purpose: "dotfiles" as const,
            ...(form.configRepoMode === "github" ? { provider: "github" as const } : {}),
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
          source: {
            url: effectiveWorkspaceSourceUrl,
            ref: effectiveWorkspaceRef,
          },
          harness: form.harness,
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
          os: form.targetOs,
          runtime: {
            ociRuntime: form.ociRuntime,
          },
          ssh: form.sshEnabled,
          ...(normalizedConfigRepoInput === undefined
            ? {}
            : { inputs: [normalizedConfigRepoInput] }),
          ...(packages.length === 0 ? {} : { packages }),
          ...(setup.length === 0 ? {} : { setup }),
          ...(startup.length === 0 ? {} : { startup }),
        },
      });

      await queryClient.invalidateQueries({ queryKey: trpc.sandbox.list.pathKey() });
      window.location.assign(`/sandboxes/${encodeURIComponent(response.sandboxId)}`);
    } catch (error) {
      setSubmitError(resolveErrorMessage(error));
    }
  };

  const hasValidRepositoryUrl = isValidUrl(previewManifest.spec.source.url);
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
    <section className="overflow-hidden border border-border bg-card">
      <div className="h-1 w-full bg-primary" />

      <div className="grid min-h-[calc(100svh-9.5rem)] gap-0 xl:grid-cols-[1.45fr_0.65fr]">
        <form
          id="new-sandbox-form"
          onSubmit={handleSubmit}
          className="border-b border-border xl:border-b-0 xl:border-r"
        >
          <header className="border-b border-border px-6 py-7 sm:px-8 sm:py-8">
            <p className="font-mono text-[0.68rem] tracking-[0.18em] text-primary">SEQUENCE.01</p>
            <h1 className="mt-3 font-display text-5xl leading-[0.86] tracking-[0.02em] text-foreground sm:text-6xl">
              Create Sandbox Spec
            </h1>
            <p className="mt-5 max-w-3xl text-sm leading-7 text-muted-foreground">
              Configure operational parameters for a new sandbox and submit one typed launch request
              through the control plane.
            </p>
          </header>

          <div className="space-y-0">
            <FormSection
              index="01"
              title="Workspace Source"
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
                                ? "border border-primary bg-primary/10 px-3 py-2.5 text-left"
                                : "border border-border bg-background px-3 py-2.5 text-left transition-colors hover:border-foreground"
                            }
                          >
                            <p className="font-mono text-[0.6rem] tracking-[0.12em] text-muted-foreground">
                              MODE
                            </p>
                            <p className="mt-1.5 font-mono text-[0.72rem] tracking-[0.08em] text-foreground">
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
                          value={form.workspaceSource}
                          onChange={(event) => {
                            setField("workspaceSource", event.target.value);
                          }}
                          placeholder="github.com/sealant-ops/core"
                          className="h-11 w-full border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
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
                          className="h-11 w-full border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </LabeledField>
                    </div>
                  ) : (
                    <div className="border border-border bg-background">
                      <button
                        type="button"
                        onClick={() => {
                          setIsSourceGitHubExpanded((current) => !current);
                        }}
                        className="flex w-full items-start justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/30"
                        aria-expanded={isSourceGitHubExpanded}
                      >
                        <div>
                          <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
                            GITHUB APP SOURCE
                          </p>
                          <p className="mt-2 text-sm leading-6 text-foreground">
                            {sourceGitHubSummary}
                          </p>
                        </div>
                        <span className="font-mono text-[0.62rem] tracking-[0.12em] text-muted-foreground">
                          {isSourceGitHubExpanded ? "COLLAPSE" : "EXPAND"}
                        </span>
                      </button>

                      {isSourceGitHubExpanded ? (
                        <div className="space-y-4 border-t border-border px-4 py-4">
                          {availableGitHubInstallations.length === 1 ? null : (
                            <div className="flex flex-col gap-3 border border-border bg-background px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                              <div>
                                <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
                                  INSTALLATION ACCESS
                                </p>
                                <p className="mt-2 text-sm leading-7 text-foreground">
                                  Import an installation once, then select any synced repository it
                                  exposes.
                                </p>
                              </div>
                              <a
                                href="/github/setup"
                                className="inline-flex h-10 items-center justify-center border border-border px-4 font-mono text-[0.62rem] tracking-[0.12em] text-foreground no-underline transition-colors hover:border-foreground"
                              >
                                Manage GitHub Access
                              </a>
                            </div>
                          )}

                          {githubInstallationsQuery.isLoading ? (
                            <div className="border border-border bg-card px-4 py-4 text-sm leading-7 text-muted-foreground">
                              Loading granted GitHub installations...
                            </div>
                          ) : githubInstallationsQuery.isError ? (
                            <div className="border border-destructive/35 bg-destructive/10 px-4 py-4 text-sm leading-7 text-destructive">
                              {resolveErrorMessage(githubInstallationsQuery.error)}
                            </div>
                          ) : availableGitHubInstallations.length === 0 ? (
                            <div className="border border-border bg-card px-4 py-4 text-sm leading-7 text-muted-foreground">
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
                                      className="h-11 w-full appearance-none border border-border bg-background pl-3 pr-14 text-sm text-foreground focus:border-foreground focus:outline-none"
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
                                    className="h-11 px-4 text-[0.62rem] tracking-[0.12em]"
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
                                      : "Refresh Repos"}
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
                                    className="h-11 w-full border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
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
                                    className="h-11 w-full border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
                                    autoComplete="off"
                                    spellCheck={false}
                                  />
                                </LabeledField>
                              </div>

                              {syncGitHubInstallationMutation.error instanceof Error ? (
                                <div className="border border-destructive/35 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                                  {syncGitHubInstallationMutation.error.message}
                                </div>
                              ) : null}

                              <LabeledField label="Repository Picker">
                                <div className="border border-border bg-card">
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
                                                ? "grid w-full gap-2 border-b border-border bg-primary/10 px-4 py-4 text-left last:border-b-0"
                                                : "grid w-full gap-2 border-b border-border bg-card px-4 py-4 text-left transition-colors hover:bg-muted/40 last:border-b-0"
                                            }
                                          >
                                            <div className="flex items-center justify-between gap-3">
                                              <p className="font-mono text-[0.72rem] text-foreground">
                                                {repository.fullName}
                                              </p>
                                              <span className="font-mono text-[0.58rem] tracking-[0.12em] text-muted-foreground">
                                                {repository.isPrivate ? "PRIVATE" : "PUBLIC"}
                                              </span>
                                            </div>
                                            <p className="font-mono text-[0.58rem] tracking-[0.11em] text-muted-foreground">
                                              DEFAULT {repository.defaultBranch.toUpperCase()}
                                              {repository.isArchived ? " // ARCHIVED" : ""}
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

                  <div className="border border-border bg-background">
                    <button
                      type="button"
                      onClick={() => {
                        setIsConfigRepoExpanded((current) => !current);
                      }}
                      className="flex w-full items-start justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/30"
                      aria-expanded={isConfigRepoExpanded}
                    >
                      <div>
                        <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
                          CONFIG REPO (DOTFILES, OPTIONAL)
                        </p>
                        <p className="mt-2 text-sm leading-6 text-foreground">
                          {configRepoSummary}
                        </p>
                      </div>
                      <span className="font-mono text-[0.62rem] tracking-[0.12em] text-muted-foreground">
                        {isConfigRepoExpanded ? "COLLAPSE" : "EXPAND"}
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
                                        ? "h-10 border border-primary bg-primary/10 font-mono text-[0.62rem] tracking-[0.12em] text-primary"
                                        : "h-10 border border-border bg-card font-mono text-[0.62rem] tracking-[0.12em] text-foreground transition-colors hover:border-foreground"
                                    }
                                  >
                                    {option.label.toUpperCase()}
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
                                    className="h-11 w-full border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
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
                                    className="h-11 w-full border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
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
                                        className="h-11 w-full appearance-none border border-border bg-background pl-3 pr-14 text-sm text-foreground focus:border-foreground focus:outline-none"
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
                                      className="h-11 w-full border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
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
                                    className="h-11 w-full border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
                                    autoComplete="off"
                                    spellCheck={false}
                                  />
                                </LabeledField>

                                <LabeledField label="Config Repo Picker">
                                  <div className="border border-border bg-card">
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
                                                  ? "grid w-full gap-2 border-b border-border bg-primary/10 px-4 py-3 text-left last:border-b-0"
                                                  : "grid w-full gap-2 border-b border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/40 last:border-b-0"
                                              }
                                            >
                                              <div className="flex items-center justify-between gap-3">
                                                <p className="font-mono text-[0.7rem] text-foreground">
                                                  {repository.fullName}
                                                </p>
                                                <span className="font-mono text-[0.56rem] tracking-[0.12em] text-muted-foreground">
                                                  {repository.isPrivate ? "PRIVATE" : "PUBLIC"}
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
                              <div className="space-y-4 border border-border bg-card px-4 py-4">
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
                                        className="h-11 w-full appearance-none border border-border bg-background pl-3 pr-14 text-sm text-foreground focus:border-foreground focus:outline-none"
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
                                        className="h-11 w-full appearance-none border border-border bg-background pl-3 pr-14 text-sm text-foreground focus:border-foreground focus:outline-none"
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
                                      className="h-11 w-full border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
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
                          className="h-11 w-full appearance-none border border-border bg-background pl-3 pr-14 text-sm text-foreground focus:border-foreground focus:outline-none"
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
                                  ? "h-11 border border-primary bg-primary px-2 font-mono text-[0.62rem] tracking-[0.13em] text-primary-foreground"
                                  : "h-11 border border-border bg-card px-2 font-mono text-[0.62rem] tracking-[0.13em] text-foreground transition-colors hover:border-foreground"
                              }
                            >
                              {option.label.toUpperCase()}
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
                          className="h-11 w-full appearance-none border border-border bg-background pl-3 pr-14 text-sm text-foreground focus:border-foreground focus:outline-none"
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
                                  ? "border border-primary bg-primary/10 px-4 py-4 text-left"
                                  : "border border-border bg-background px-4 py-4 text-left transition-colors hover:border-foreground"
                              }
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="font-display text-3xl leading-none text-foreground">
                                    {option.label}
                                  </p>
                                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                                    {option.detail}
                                  </p>
                                </div>
                                <span
                                  className={
                                    isActive
                                      ? "border border-primary bg-primary px-2 py-1 font-mono text-[0.58rem] tracking-[0.12em] text-primary-foreground"
                                      : "border border-border px-2 py-1 font-mono text-[0.58rem] tracking-[0.12em] text-muted-foreground"
                                  }
                                >
                                  {isActive ? "ACTIVE" : "READY"}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <p className="font-mono text-[0.62rem] leading-6 tracking-[0.11em] text-muted-foreground">
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
                        className="h-11 w-full border border-border bg-background px-3 text-sm text-foreground focus:border-foreground focus:outline-none"
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
                        className="h-11 w-full border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
                        placeholder="sealant/workspaces/demo"
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
                        className="h-11 w-full border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
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
                              className={
                                packageState === "invalid"
                                  ? "inline-flex h-8 items-center gap-2 border border-amber-500/50 bg-amber-950/15 px-2.5 font-mono text-[0.62rem] tracking-[0.11em] text-amber-300"
                                  : packageState === "valid"
                                    ? "inline-flex h-8 items-center gap-2 border border-emerald-500/45 bg-emerald-950/15 px-2.5 font-mono text-[0.62rem] tracking-[0.11em] text-emerald-300"
                                    : "inline-flex h-8 items-center gap-2 border border-border bg-muted/50 px-2.5 font-mono text-[0.62rem] tracking-[0.11em] text-foreground"
                              }
                              onClick={() => {
                                setField(
                                  "packages",
                                  form.packages.filter((entry) => entry !== pkg),
                                );
                              }}
                              aria-label={`Remove package ${pkg}`}
                              title={validation?.message}
                            >
                              <span>{pkg.toUpperCase()}</span>
                              <span>
                                {packageState === "valid"
                                  ? "OK"
                                  : packageState === "invalid"
                                    ? "WARN"
                                    : "..."}
                              </span>
                              <span aria-hidden>×</span>
                            </button>
                          );
                        })}
                      </div>

                      {packageValidationIssues.length > 0 ? (
                        <div className="space-y-1 border border-amber-800/40 bg-amber-950/15 px-3 py-2">
                          {packageValidationIssues.map((issue) => (
                            <p
                              key={issue}
                              className="font-mono text-[0.62rem] tracking-[0.11em] text-amber-300"
                            >
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
                          className="h-10 w-full border border-dashed border-border bg-background px-3 font-mono text-[0.68rem] text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
                          placeholder="Add package (for example: ripgrep)"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          className="h-10 px-4 text-[0.62rem] tracking-[0.12em]"
                          onClick={appendPackage}
                        >
                          Add Package
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
                          <span className="flex h-10 items-center justify-center font-mono text-[0.62rem] tracking-[0.12em] text-muted-foreground">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <input
                            value={command}
                            onChange={(event) => {
                              const nextCommands = [...form.setupSteps];
                              nextCommands[index] = event.target.value;
                              setField("setupSteps", nextCommands);
                            }}
                            className="h-10 w-full border border-border bg-background px-3 font-mono text-[0.72rem] text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            className="h-10 px-3 text-[0.62rem] tracking-[0.11em]"
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
                        <span className="flex h-10 items-center justify-center font-mono text-[0.62rem] tracking-[0.12em] text-muted-foreground">
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
                          className="h-10 w-full border border-dashed border-border bg-background px-3 font-mono text-[0.72rem] text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
                          placeholder="Append command"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          className="h-10 px-3 text-[0.62rem] tracking-[0.11em]"
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
                      className="h-11 w-full border border-border bg-background px-3 font-mono text-[0.72rem] text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
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
                <button
                  type="button"
                  onClick={() => {
                    setField("sshEnabled", !form.sshEnabled);
                  }}
                  className="flex w-full items-center justify-between border border-border bg-background px-4 py-4 text-left transition-colors hover:border-foreground"
                  role="switch"
                  aria-checked={form.sshEnabled}
                >
                  <div>
                    <p className="font-sans text-sm font-semibold text-foreground">
                      Enable SSH tunneling
                    </p>
                    <p className="mt-1 text-xs leading-6 text-muted-foreground">
                      Allow direct terminal access to the active sandbox runtime endpoint.
                    </p>
                  </div>
                  <span
                    className={
                      form.sshEnabled
                        ? "h-7 min-w-7 border border-primary bg-primary text-center font-mono text-[0.58rem] leading-[1.75rem] tracking-[0.12em] text-primary-foreground"
                        : "h-7 min-w-7 border border-border bg-card text-center font-mono text-[0.58rem] leading-[1.75rem] tracking-[0.12em] text-muted-foreground"
                    }
                  >
                    {form.sshEnabled ? "ON" : "OFF"}
                  </span>
                </button>
              }
            />

            {formErrors.length > 0 ? (
              <div className="border-t border-border px-6 py-5 sm:px-8">
                <div className="border border-destructive/35 bg-destructive/10 px-4 py-3">
                  <p className="font-mono text-[0.64rem] tracking-[0.14em] text-destructive">
                    Fix the fields below before starting the sandbox
                  </p>
                  <ul className="mt-2 space-y-1 text-sm leading-6 text-destructive">
                    {formErrors.map((error) => (
                      <li key={error}>• {error}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {submitError === null ? null : (
              <div className="border-t border-border px-6 py-5 sm:px-8">
                <div className="border border-destructive/35 bg-destructive/10 px-4 py-3">
                  <p className="font-mono text-[0.64rem] tracking-[0.14em] text-destructive">
                    Launch request failed
                  </p>
                  <p className="mt-2 text-sm leading-6 text-destructive">{submitError}</p>
                </div>
              </div>
            )}
          </div>
        </form>

        <aside className="border-t border-border bg-background px-6 py-7 sm:px-8 xl:border-t-0 xl:px-6 xl:py-8">
          <div className="xl:sticky xl:top-6">
            <h2 className="font-display text-4xl leading-[0.9] tracking-[0.02em] text-foreground">
              Live Preview
            </h2>

            <div className="mt-6 border-t border-border pt-6">
              <p className="font-mono text-[0.64rem] tracking-[0.14em] text-muted-foreground">
                Operational Summary
              </p>

              <dl className="mt-4 space-y-2.5 text-sm">
                <SummaryRow label="Target" value={previewManifest.spec.source.url} highlighted />
                <SummaryRow label="Harness" value={previewManifest.spec.harness.toUpperCase()} />
                <SummaryRow label="Target OS" value={previewManifest.spec.os.toUpperCase()} />
                <SummaryRow
                  label="OCI runtime"
                  value={previewManifest.spec.runtime.ociRuntime.toUpperCase()}
                />
                <SummaryRow label="Packages" value={String(previewManifest.spec.packages.length)} />
                <SummaryRow
                  label="Config repo"
                  value={
                    form.configRepoMode === "none"
                      ? "DISABLED"
                      : (previewManifest.spec.inputs?.[0]?.url ?? "PENDING SELECTION")
                  }
                  highlighted={form.configRepoMode !== "none"}
                />
                <SummaryRow
                  label="Config strategy"
                  value={
                    form.configRepoMode === "none"
                      ? "N/A"
                      : `${form.configRepoManager.toUpperCase()} @ ${form.configRepoTarget === "home" ? "HOME" : "CONFIG"}`
                  }
                />
                <SummaryRow
                  label="SSH state"
                  value={previewManifest.spec.ssh ? "ACTIVE" : "DISABLED"}
                  highlighted={previewManifest.spec.ssh}
                />
              </dl>
            </div>

            <div className="mt-7 border-t border-border pt-6">
              <p className="font-mono text-[0.64rem] tracking-[0.14em] text-muted-foreground">
                Raw Manifest (JSON)
              </p>
              <pre className="mt-3 max-h-72 overflow-auto border border-border bg-card p-4 font-mono text-[0.66rem] leading-6 text-foreground">
                {JSON.stringify(previewManifest, null, 2)}
              </pre>
            </div>

            <div className="mt-7 border-t border-border pt-6">
              <p className="font-mono text-[0.64rem] tracking-[0.14em] text-muted-foreground">
                Health Check
              </p>
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
                  ok={previewManifest.spec.harness.length > 0}
                  text={
                    previewManifest.spec.harness.length > 0
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
                {compatibilityIssues.length > 0 ? (
                  <p className="font-mono text-[0.62rem] tracking-[0.11em] text-amber-400">
                    {compatibilityIssues[0]}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="mt-10 space-y-3 border-t border-border pt-6">
              <Button
                type="submit"
                className="h-12 w-full text-[0.74rem] tracking-[0.14em]"
                disabled={createSandboxMutation.isPending}
                form="new-sandbox-form"
              >
                {createSandboxMutation.isPending ? "Starting Sandbox..." : "Start Sandbox"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-12 w-full text-[0.7rem] tracking-[0.12em]"
                onClick={() => {
                  setForm(createInitialFormState("default"));
                  setIsSourceGitHubExpanded(false);
                  setIsConfigRepoExpanded(false);
                  setFormErrors([]);
                  setSubmitError(null);
                }}
                disabled={createSandboxMutation.isPending}
              >
                Reset Spec
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
    <section className="border-t border-border px-6 py-6 sm:px-8 sm:py-7">
      <p className="font-display text-3xl leading-[0.9] tracking-[0.01em] text-foreground sm:text-[2.15rem]">
        {props.index}. {props.title}
      </p>
      <div className="mt-4">{props.content}</div>
    </section>
  );
}

function LabeledField(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
        {props.label}
      </span>
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
      <dt className="font-mono text-[0.62rem] tracking-[0.12em] text-muted-foreground">
        {props.label}
      </dt>
      <dd
        className={
          props.highlighted
            ? "font-mono text-[0.68rem] text-primary"
            : "font-mono text-[0.68rem] text-foreground"
        }
      >
        {props.value}
      </dd>
    </div>
  );
}

function HealthRow(props: { readonly ok: boolean; readonly text: string }) {
  return (
    <div
      className={
        props.ok
          ? "border border-emerald-800/40 bg-emerald-950/25 px-3 py-2"
          : "border border-amber-800/40 bg-amber-950/20 px-3 py-2"
      }
    >
      <p
        className={
          props.ok
            ? "font-mono text-[0.63rem] tracking-[0.12em] text-emerald-400"
            : "font-mono text-[0.63rem] tracking-[0.12em] text-amber-400"
        }
      >
        {props.ok ? "OK" : "WARN"} // {props.text}
      </p>
    </div>
  );
}

function createInitialFormState(registryId: string): NewSandboxFormState {
  return {
    sourceMode: "git",
    workspaceSource: "https://github.com/sealant-ops/core",
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
    artifactRepository: "sealant/workspaces/demo",
    artifactTag: "opencode",
    packages: [],
    setupSteps: [],
    entrypoint: "",
    sshEnabled: true,
  };
}

function normalizeRequiredValue(value: string): string {
  return value.trim();
}

function normalizeOptionalValue(value: string): string {
  return value.trim();
}

function normalizePackageIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeCommandStep(value: string): string {
  return value.trim();
}

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
    new URL(value);
    return true;
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
    const repositoryUrl = normalizeRepositoryUrl(form.workspaceSource);
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
