import type { MicrovmPublication, NativePublication } from "@sealant/validators";

import type { BoatNativeCatalogService } from "../images/boat/catalog.js";
import type { WorkspaceImageBuilder } from "../images/image-builder.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";

/** A registration correlates its publication owner with the adapter that can launch it. */
export type RegisteredRuntime =
  | {
      readonly kind: "oci";
      readonly adapter: RuntimeAdapter;
      readonly imageBuilder: WorkspaceImageBuilder;
    }
  | {
      readonly kind: "microvm";
      readonly adapter: RuntimeAdapter<MicrovmPublication>;
      readonly imageBuilder: WorkspaceImageBuilder;
    }
  | {
      readonly kind: "boat-native";
      readonly adapter: RuntimeAdapter<NativePublication>;
      readonly artifacts: BoatNativeCatalogService;
    };
