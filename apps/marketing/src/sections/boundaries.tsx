// The credibility climax — lowest decoration, most quotable. Six denials, each a
// sans claim over a mono qualifier, separated by hairlines. The argument is that the
// boundaries ARE the feature: depth and type only, no tinted panels, no alarm color.

import { Container, Eyebrow, Reveal, SectionHead } from "#/components/primitives";

interface Denial {
  readonly claim: string;
  readonly qualifier: string;
}

const DENIALS: ReadonlyArray<Denial> = [
  {
    claim: "Not an agent or a model",
    qualifier: "bring your own — opencode, a custom agent, a CI worker",
  },
  { claim: "Not just Docker", qualifier: "containers isolate; we add the work model" },
  {
    claim: "Not a hosted service",
    qualifier: "self-hosted only — your code never leaves your infra",
  },
  { claim: "Not a judge", qualifier: "evidence, not verdicts" },
  { claim: "Not yet tamper-proof", qualifier: "tamper-evident, and we say so" },
  { claim: "Not a deterministic time machine", qualifier: "replay re-folds the run's own history" },
];

function DenialRow({ denial }: { denial: Denial }) {
  return (
    <div className="border-t border-rule-faint py-6">
      <p className="font-medium text-foreground">{denial.claim}</p>
      <p className="mt-1.5 font-mono text-sm text-muted-foreground">{denial.qualifier}</p>
    </div>
  );
}

export function Boundaries() {
  return (
    <section id="not" className="bg-panel py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow={<Eyebrow>The boundaries are the feature</Eyebrow>}
          title="What Sealant is not."
          className="max-w-[46ch]"
        />
        <Reveal className="mt-12">
          <div className="grid gap-x-12 sm:grid-cols-2">
            {DENIALS.map((denial) => (
              <DenialRow key={denial.claim} denial={denial} />
            ))}
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
