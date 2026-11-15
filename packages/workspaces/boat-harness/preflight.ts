/**
 * What a harness run would find on this Docker host, without starting or changing anything: who
 * holds the host lock, which finished runs left labelled objects, whether sealant objects another
 * deployment owns are here (the run refuses to start beside them), and whether the twin base image
 * is already built. Prints one JSON document; `pnpm verify boat-harness` reads it.
 *
 *   pnpm --filter @sealant/workspaces exec tsx boat-harness/preflight.ts
 */
import { docker, listCoreObjectNames } from "./docker.js";
import { cleanupPlan } from "./reap.js";
import { cachedImageTag, TWIN_IMAGE } from "./stack.js";

const plan = await cleanupPlan();
const twinTag = await cachedImageTag(TWIN_IMAGE.name, TWIN_IMAGE.context);
const twinCached = (await docker(["image", "inspect", "-f", "{{.Id}}", twinTag])).code === 0;
const foreign =
  process.env.BOAT_HARNESS_ALLOW_SHARED_DOCKER === "1" ? [] : await listCoreObjectNames();

process.stdout.write(
  `${JSON.stringify({
    lock:
      plan.live !== undefined
        ? { state: "live", run: plan.live }
        : plan.staleLock !== undefined
          ? { state: "stale", run: plan.staleLock }
          : { state: "free" },
    leftovers: plan.reap,
    foreign,
    twin: { tag: twinTag, cached: twinCached },
  })}\n`,
);
