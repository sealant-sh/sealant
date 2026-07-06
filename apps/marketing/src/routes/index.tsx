import { createFileRoute } from "@tanstack/react-router";

import { RecordCaptures } from "#/sections/capture";
import { FinalCta } from "#/sections/final-cta";
import { Hero } from "#/sections/hero";
import { OpenSource } from "#/sections/opensource";
import { Products } from "#/sections/products";
import { RunSurface } from "#/sections/record";
import { BuildOnSdk } from "#/sections/sdk";
import { ModelStrip } from "#/sections/thesis-strip";
import { Workspaces } from "#/sections/workspaces";

export const Route = createFileRoute("/")({
  component: MarketingPage,
});

// Ordered by value, not implementation: reviewable agent work → the replayable run
// record → the SDK → what the record captures → live workspaces & access → versatility
// → open-source → adopt. See docs/product/LANDING-PAGE-CONTENT-MAP.md.
function MarketingPage() {
  return (
    <main className="overflow-x-clip">
      <Hero />
      <ModelStrip />
      <RunSurface />
      <BuildOnSdk />
      <RecordCaptures />
      <Workspaces />
      <Products />
      <OpenSource />
      <FinalCta />
    </main>
  );
}
