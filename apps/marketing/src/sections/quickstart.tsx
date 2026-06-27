// Quickstart — the conversion event. The honest dark terminal is legitimate here
// (one of the three places: SSH, Quickstart, the indictment foil). Four numbered
// steps from daemon to opened run, then a faint in-development note and the ask.

import {
  CodePanel,
  Container,
  Eyebrow,
  InDevBadge,
  SectionHead,
  SecondaryCTA,
} from "#/components/primitives";

export function Quickstart() {
  return (
    <section id="quickstart" className="bg-panel py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow={<Eyebrow>Quickstart</Eyebrow>}
          title="Your first recorded run."
          intro={<p>Five minutes, self-hosted, on your own machine.</p>}
        />

        <div className="mt-10 max-w-[44rem]">
          <CodePanel title="first-run.sh">
            <span className="block text-white/40"># 1 · run the daemon (Docker)</span>
            <span className="block text-white/85">
              docker run -d --name sealantd ghcr.io/get-sealant/sealantd
            </span>
            <span className="block"> </span>
            <span className="block text-white/40"># 2 · install the SDK</span>
            <span className="block text-white/85">npm i @sealant/sdk</span>
            <span className="block"> </span>
            <span className="block text-white/40"># 3 · create a sandbox, run a harness</span>
            <span className="block text-white/85">const run = await sealant.sandboxes</span>
            <span className="block text-white/85">{"  .create({ repository, harness })"}</span>
            <span className="block text-white/85">
              {"  ."}
              <span className="text-[#9db4f0]">harness</span>
              {"."}
              <span className="text-[#9db4f0]">run</span>
              {"(prompt);"}
            </span>
            <span className="block"> </span>
            <span className="block text-white/40"># 4 · open the run</span>
            <span className="block text-white/85">
              {"console."}
              <span className="text-[#9db4f0]">log</span>
              {"(run."}
              <span className="text-[#9db4f0]">record</span>
              {"."}
              <span className="text-[#9db4f0]">replayUrl</span>
              {");"}
            </span>
          </CodePanel>

          <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-faint">
            <InDevBadge>SDK in development</InDevBadge>
            The runtime runs today; the fluent SDK is in active development — these are the intended
            commands.
          </p>
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <p className="text-foreground">Five minutes to your first recorded run.</p>
          <SecondaryCTA>Read the full docs</SecondaryCTA>
        </div>
      </Container>
    </section>
  );
}
