import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: MarketingPage,
});

function MarketingPage() {
  return (
    <main>
      <section className="hero hero-poster section-rule">
        <div className="container hero-poster-grid">
          <div className="hero-main-panel">
            <p className="hero-badge">Open source // Sandboxes + issue workflows</p>
            <h1>
              Issue
              <br />
              workflows
              <br />
              in tailored
              <br />
              sandboxes
              <br />
              for review
            </h1>
            <p className="hero-copy">
              Run each issue workflow in an isolated sandbox and keep prompts, tool traces, checks,
              and diffs attached from issue intake through pull request handoff.
            </p>
            <div className="hero-actions">
              <a
                className="primary-cta"
                href="https://docs.sealant.dev"
                target="_blank"
                rel="noreferrer"
              >
                Read installation docs
              </a>
              <a
                className="secondary-cta"
                href="https://github.com/sealant-ops/sealant"
                target="_blank"
                rel="noreferrer"
              >
                View GitHub
              </a>
            </div>
          </div>

          <aside className="hero-capability-grid" aria-label="Core capabilities">
            <article className="hero-capability-card">
              <span className="hero-capability-marker" aria-hidden="true" />
              <p className="hero-capability-index">[01]</p>
              <p className="hero-capability-title">Custom sandboxes</p>
              <p className="hero-capability-copy">
                Launch tailored sandboxes quickly with your dotfiles, packages, and startup
                commands, then connect over SSH or your editor.
              </p>
            </article>

            <article className="hero-capability-card">
              <span className="hero-capability-marker" aria-hidden="true" />
              <p className="hero-capability-index">[02]</p>
              <p className="hero-capability-title">Issue workflows</p>
              <p className="hero-capability-copy">
                Import issues from GitHub, GitLab, Linear, and similar systems, then execute each
                issue workflow inside an isolated sandbox.
              </p>
            </article>

            <article className="hero-capability-card">
              <span className="hero-capability-marker" aria-hidden="true" />
              <p className="hero-capability-index">[03]</p>
              <p className="hero-capability-title">Review clarity</p>
              <p className="hero-capability-copy">
                Review exactly what happened and how in one place: prompts, tool calls, command
                output, checks, diffs, and pull request actions.
              </p>
            </article>

            <article className="hero-capability-card">
              <span className="hero-capability-marker" aria-hidden="true" />
              <p className="hero-capability-index">[04]</p>
              <p className="hero-capability-title">Open source deploy</p>
              <p className="hero-capability-copy">
                Sealant is open source and self-hostable, from a personal machine to Kubernetes. Get
                up and running in a few steps.
              </p>
            </article>
          </aside>
        </div>
      </section>

      <section id="details" className="section-rule details-section">
        <div className="container section-stack">
          <div>
            <p className="kicker">Built for developer workflows</p>
            <h2>Make setup and automation easier to reason about.</h2>
            <p>
              Most workflow pain shows up in three places: inconsistent environments, awkward
              handoff between tools, and automation that produces changes without enough review
              context.
            </p>
          </div>
          <ol className="line-list" aria-label="Sealant capabilities">
            <li>
              <span>Environment definition</span>
              <p>
                Define repository source, OS target, your harness of choice, packages, startup
                commands, dotfiles, and runtime options in one sandbox spec. Run LLMs inside
                isolated environments backed by runtimes such as gVisor, Kata, and other hardened
                sandbox boundaries.
              </p>
            </li>
            <li>
              <span>Direct access</span>
              <p>
                Connect to the active sandbox over SSH or open it in VS Code or Cursor without
                recreating the environment locally.
              </p>
            </li>
            <li>
              <span>Workflow trace</span>
              <p>
                Issue workflows keep prompts, tool calls, attempts, validation output, diffs, and
                pull request linkage attached to the same execution record.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className="section-rule">
        <div className="container section-stack">
          <div>
            <p className="kicker">Issue workflow reporting</p>
            <h2>Every LLM attempt stays inspectable.</h2>
            <p>
              Load issues from GitHub, GitLab, Linear, and similar systems, then run them through a
              tracked issue-to-PR workflow. When the pull request opens, the full execution record
              stays attached.
            </p>
          </div>
          <ol className="line-list" aria-label="Issue workflow details">
            <li>
              <span>Issue intake</span>
              <p>
                Import work from GitHub, GitLab, Linear, and other issue systems instead of copying
                context across tools by hand.
              </p>
            </li>
            <li>
              <span>Prompt log</span>
              <p>
                Store issue context, execution inputs, and prompt history before and during the run
                so the attempt can be audited later.
              </p>
            </li>
            <li>
              <span>Tool trace</span>
              <p>
                Record tool calls, status transitions, validation output, and produced artifacts as
                the workflow runs.
              </p>
            </li>
            <li>
              <span>Diff context</span>
              <p>
                Keep change summaries and per-file diffs tied to the workflow execution so reviewers
                can inspect what changed and how the attempt evolved.
              </p>
            </li>
            <li>
              <span>PR linkage</span>
              <p>
                Publish pull requests with direct links back to the logged issue workflow so review
                stays cleaner, more repeatable, and easier to reason about.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section id="opensource" className="final-section">
        <div className="container">
          <p className="kicker">Open Source</p>
          <h2>Own the execution layer.</h2>
          <p>
            Sealant is open source and self-hostable. Teams can inspect the control plane, adapt the
            integration points, and keep workflow infrastructure inside their own operational
            boundary.
          </p>
          <div className="final-actions">
            <a
              className="primary-cta"
              href="https://github.com/sealant-ops/sealant"
              target="_blank"
              rel="noreferrer"
            >
              Explore repository
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
