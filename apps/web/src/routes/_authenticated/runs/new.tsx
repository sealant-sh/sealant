import { Button } from "@sealant/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useTRPC } from "@/lib/trpc/react";

type HarnessId = "opencode" | "codex" | "claude-code";
type TargetOs = "fedora" | "nix" | "arch";

interface NewSandboxFormState {
  readonly workspaceSource: string;
  readonly branch: string;
  readonly harness: HarnessId;
  readonly targetOs: TargetOs;
  readonly registryId: string;
  readonly artifactRepository: string;
  readonly artifactTag: string;
  readonly packages: readonly string[];
  readonly setupSteps: readonly string[];
  readonly entrypoint: string;
  readonly sshEnabled: boolean;
}

const HARNESS_OPTIONS: ReadonlyArray<{ readonly value: HarnessId; readonly label: string }> = [
  { value: "opencode", label: "OpenCode (Standard)" },
  { value: "codex", label: "Codex" },
  { value: "claude-code", label: "Claude Code" },
];

const TARGET_OS_OPTIONS: ReadonlyArray<{ readonly value: TargetOs; readonly label: string }> = [
  { value: "fedora", label: "Fedora" },
  { value: "nix", label: "Nix" },
  { value: "arch", label: "Arch" },
];

const NIX_SUPPORTED_PACKAGES = new Set(["curl", "git", "jq", "nodejs", "pnpm", "ripgrep"]);

export const Route = createFileRoute("/_authenticated/runs/new" as never)({
  component: NewSandboxPage,
});

function NewSandboxPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<NewSandboxFormState>(() => {
    return createInitialFormState("default");
  });
  const selectedRegistryId =
    normalizeRequiredValue(form.registryId).length > 0
      ? normalizeRequiredValue(form.registryId)
      : "default";
  const [packageInput, setPackageInput] = useState("");
  const [setupStepInput, setSetupStepInput] = useState("");
  const [formErrors, setFormErrors] = useState<readonly string[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const createSandboxMutation = useMutation(trpc.sandbox.create.mutationOptions());

  const previewManifest = useMemo(() => {
    const normalizedRepositoryUrl = normalizeRepositoryUrl(form.workspaceSource);
    const normalizedSetupSteps = form.setupSteps
      .map(normalizeCommandStep)
      .filter((value) => value.length > 0);
    const normalizedEntrypoint = normalizeRequiredValue(form.entrypoint);

    return {
      registryId: selectedRegistryId,
      repository: normalizeRequiredValue(form.artifactRepository),
      tag: normalizeRequiredValue(form.artifactTag),
      spec: {
        source: {
          url: normalizedRepositoryUrl,
          ref: normalizeRequiredValue(form.branch),
        },
        harness: form.harness,
        os: form.targetOs,
        packages: form.packages,
        ssh: form.sshEnabled,
        ...(normalizedSetupSteps.length === 0 ? {} : { setup: normalizedSetupSteps }),
        ...(normalizedEntrypoint.length === 0 ? {} : { startup: normalizedEntrypoint }),
      },
    };
  }, [form, selectedRegistryId]);

  const setField = <TField extends keyof NewSandboxFormState>(
    field: TField,
    value: NewSandboxFormState[TField],
  ) => {
    setForm((current) => {
      return {
        ...current,
        [field]: value,
      };
    });
    setFormErrors([]);
    setSubmitError(null);
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

    const validationErrors = validateForm(form, selectedRegistryId);
    setFormErrors(validationErrors);

    if (validationErrors.length > 0) {
      return;
    }

    const repositoryUrl = normalizeRepositoryUrl(form.workspaceSource);
    const packages = form.packages
      .map(normalizePackageIdentifier)
      .filter((value) => value.length > 0);
    const setup = form.setupSteps.map(normalizeCommandStep).filter((value) => value.length > 0);
    const startup = normalizeRequiredValue(form.entrypoint);

    try {
      const response = await createSandboxMutation.mutateAsync({
        registryId: selectedRegistryId,
        repository: normalizeRequiredValue(form.artifactRepository),
        tag: normalizeRequiredValue(form.artifactTag),
        spec: {
          source: {
            url: repositoryUrl,
            ref: normalizeRequiredValue(form.branch),
          },
          harness: form.harness,
          os: form.targetOs,
          ssh: form.sshEnabled,
          ...(packages.length === 0 ? {} : { packages }),
          ...(setup.length === 0 ? {} : { setup }),
          ...(startup.length === 0 ? {} : { startup }),
        },
      });

      await queryClient.invalidateQueries({ queryKey: trpc.sandbox.list.pathKey() });
      window.location.assign(`/runs/${encodeURIComponent(response.sandboxId)}`);
    } catch (error) {
      setSubmitError(resolveErrorMessage(error));
    }
  };

  const hasValidRepositoryUrl = isValidUrl(previewManifest.spec.source.url);
  const hasCommands =
    Array.isArray(previewManifest.spec.setup) && previewManifest.spec.setup.length > 0;
  const compatibilityIssues = getCompatibilityIssues(form);

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
              }
            />

            <FormSection
              index="02"
              title="Execution Environment"
              content={
                <div className="space-y-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <LabeledField label="Harness Type">
                      <select
                        value={form.harness}
                        onChange={(event) => {
                          setField("harness", parseHarnessId(event.target.value));
                        }}
                        className="h-11 w-full border border-border bg-background px-3 text-sm text-foreground focus:border-foreground focus:outline-none"
                      >
                        {HARNESS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
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
                  </div>

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
                        {form.packages.map((pkg) => (
                          <button
                            key={pkg}
                            type="button"
                            className="inline-flex h-8 items-center gap-2 border border-border bg-muted/50 px-2.5 font-mono text-[0.62rem] tracking-[0.11em] text-foreground"
                            onClick={() => {
                              setField(
                                "packages",
                                form.packages.filter((entry) => entry !== pkg),
                              );
                            }}
                            aria-label={`Remove package ${pkg}`}
                          >
                            <span>{pkg.toUpperCase()}</span>
                            <span aria-hidden>×</span>
                          </button>
                        ))}
                      </div>

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
                    Fix the fields below before starting the run
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
                <SummaryRow label="Packages" value={String(previewManifest.spec.packages.length)} />
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
                  ok={hasValidRepositoryUrl}
                  text={
                    hasValidRepositoryUrl
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
                  ok={compatibilityIssues.length === 0}
                  text={hasCommands ? "Setup commands configured" : "No setup commands (optional)"}
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
                {createSandboxMutation.isPending ? "Starting Run..." : "Start Run"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-12 w-full text-[0.7rem] tracking-[0.12em]"
                onClick={() => {
                  setForm(createInitialFormState("default"));
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
    workspaceSource: "https://github.com/sealant-ops/core",
    branch: "main",
    harness: "opencode",
    targetOs: "fedora",
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

function normalizeRepositoryUrl(value: string): string {
  const trimmed = value.trim();

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function validateForm(form: NewSandboxFormState, registryId: string): readonly string[] {
  const errors: string[] = [];

  const repositoryUrl = normalizeRepositoryUrl(form.workspaceSource);
  if (!isValidUrl(repositoryUrl)) {
    errors.push("Repository URL must be a valid URL.");
  }

  if (normalizeRequiredValue(form.branch).length === 0) {
    errors.push("Branch or commit is required.");
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

  const compatibilityIssues = getCompatibilityIssues(form);
  if (compatibilityIssues.length > 0) {
    errors.push(...compatibilityIssues);
  }

  return errors;
}

function getCompatibilityIssues(form: NewSandboxFormState): readonly string[] {
  const issues: string[] = [];

  if (form.targetOs !== "nix") {
    return issues;
  }

  const setupCount = form.setupSteps
    .map(normalizeCommandStep)
    .filter((value) => value.length > 0).length;
  if (setupCount > 0) {
    issues.push("Nix target does not support setup steps yet. Remove setup commands to continue.");
  }

  const unsupportedPackages = form.packages.filter((pkg) => !NIX_SUPPORTED_PACKAGES.has(pkg));
  if (unsupportedPackages.length > 0) {
    issues.push(
      `Nix target does not support packages: ${unsupportedPackages.join(", ")}. Supported: curl, git, jq, nodejs, pnpm, ripgrep.`,
    );
  }

  return issues;
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Unable to create sandbox right now.";
}
