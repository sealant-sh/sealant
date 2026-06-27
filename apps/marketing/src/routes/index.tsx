import { createFileRoute } from "@tanstack/react-router";

import { BuildOnSdk } from "#/sections/sdk";
import { RecordCaptures } from "#/sections/capture";
import { FinalCta } from "#/sections/final-cta";
import { Hero } from "#/sections/hero";
import { ModelStrip } from "#/sections/thesis-strip";
import { OpenSource } from "#/sections/opensource";
import { Products } from "#/sections/products";
import { RunSurface } from "#/sections/record";
import { Sandboxes } from "#/sections/sandboxes";

export const Route = createFileRoute("/")({
  component: MarketingPage,
});

// Ordered by value, not implementation: reviewable agent work → the replayable run
// record → the SDK → what the record captures → live sandboxes & access → versatility
// → open-source → adopt. See docs/product/LANDING-PAGE-CONTENT-MAP.md.
function MarketingPage() {
  return (
    <main className="overflow-x-clip">
      <Hero />
      <ModelStrip />
      <RunSurface />
      <BuildOnSdk />
      <RecordCaptures />
      <Sandboxes />
      <Products />
      <OpenSource />
      <FinalCta />
    </main>
  );
}
