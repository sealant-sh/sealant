// Human access — the section that admits automation is not always enough. Anchored in
// a genuinely-shipping capability: SSH into the same live sandbox. This is one of the
// three places a dark terminal is honest, so the visual is a real CodePanel, not the
// RunRecord Exhibit. Text on the right, terminal on the left on lg.

import { Callout, CodePanel, Container, Display, Eyebrow, Reveal } from "#/components/primitives";

export function HumanAccess() {
  return (
    <section id="access" className="bg-panel py-24 lg:py-32">
      <Container>
        <Reveal>
          <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
            <div className="order-2 min-w-0 lg:order-1">
              <CodePanel title="sandbox.sbx_8m2k — ssh">
                <span className="block">
                  <span className="text-[#9db4f0]">$ </span>
                  <span className="text-[#e6e6ea]">ssh sandbox.sbx_8m2k</span>
                </span>
                <span className="block"> </span>
                <span className="block">
                  <span className="text-[#9db4f0]">$ </span>
                  <span className="text-[#e6e6ea]">git diff --stat</span>
                </span>
                <span className="block text-white/55"> src/checkout.ts | 18 +++++---</span>
                <span className="block"> </span>
                <span className="block">
                  <span className="text-[#9db4f0]">$ </span>
                  <span className="text-[#e6e6ea]">pnpm test checkout</span>
                </span>
                <span className="block text-success">✓ 14 tests passed</span>
              </CodePanel>
            </div>

            <div className="order-1 min-w-0 lg:order-2">
              <Eyebrow>Not a black box</Eyebrow>
              <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-[2.85rem]">
                Let the harness work. Step in when reality gets messy.
              </Display>
              <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
                Developer environments fail in ordinary ways — a missing dependency, an occupied
                port, a hung process.
              </p>
              <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
                SSH into the same live sandbox, inspect files and processes, make a change, and let
                the work continue without recreating the environment.
              </p>
              <p className="mt-5 font-mono text-xs leading-relaxed text-faint">
                Same repo · same processes · same task · same record. Your keystrokes land in the
                same run.
              </p>
              <Callout className="mt-7">
                Automation when it works. Direct access when it doesn&apos;t.
              </Callout>
            </div>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
