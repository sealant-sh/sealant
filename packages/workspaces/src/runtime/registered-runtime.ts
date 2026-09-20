import type { WorkspaceImageBuilder } from "../images/image-builder.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";

/**
 * A runtime as the worker knows it: the adapter that launches a workspace, and the builder of the
 * image that adapter boots (docs/workspace-image-builders-design.md, D1).
 *
 * The two are registered together so that no runtime can take workspaces without a way to build
 * the blueprint's image for it. A blueprint's packages, shell and setup commands are part of what
 * a project is, on every runtime. `runtime-adapter.conformance.test.ts` holds each adapter id to
 * that, so adding one without a builder fails CI.
 */
export interface RegisteredRuntime {
  readonly adapter: RuntimeAdapter;
  readonly imageBuilder: WorkspaceImageBuilder;
}
