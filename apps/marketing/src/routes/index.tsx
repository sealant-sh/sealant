import { createFileRoute } from "@tanstack/react-router";

import { Boundaries } from "#/sections/boundaries";
import { BrowserEvidence } from "#/sections/browser";
import { Contract } from "#/sections/contract";
import { FinalCta } from "#/sections/final-cta";
import { Hero } from "#/sections/hero";
import { HumanAccess } from "#/sections/human-access";
import { Indictment } from "#/sections/indictment";
import { Model } from "#/sections/model";
import { Products } from "#/sections/products";
import { Quickstart } from "#/sections/quickstart";
import { RecordClimax } from "#/sections/record";
import { ThesisStrip } from "#/sections/thesis-strip";
import { Versatility } from "#/sections/versatility";

export const Route = createFileRoute("/")({
  component: MarketingPage,
});

function MarketingPage() {
  return (
    <main className="overflow-x-clip">
      <Hero />
      <ThesisStrip />
      <Indictment />
      <Model />
      <Versatility />
      <RecordClimax />
      <BrowserEvidence />
      <HumanAccess />
      <Contract />
      <Boundaries />
      <Products />
      <Quickstart />
      <FinalCta />
    </main>
  );
}
