import {
  parseRuntimeAdapterLaunchInput,
  parseRuntimeAdapterSupportInput,
  parseRuntimeAdapterSupport,
  type RuntimeAdapter,
  type RuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchResult,
  type RuntimeAdapterSupportInput,
  type RuntimeAdapterSupport,
} from "@sealant/runtime-adapters-api";

const notImplementedMessage =
  "The Kubernetes runtime adapter launch path is not implemented yet.";

const notImplementedError = (): Error & { code: string } => {
  const error = new Error(notImplementedMessage) as Error & { code: string };
  error.code = "adapter-unavailable";
  return error;
};

export class K8sRuntimeAdapter implements RuntimeAdapter {
  public readonly id = "k8s" as const;

  public supports(input: RuntimeAdapterSupportInput): RuntimeAdapterSupport {
    parseRuntimeAdapterSupportInput(input);

    return parseRuntimeAdapterSupport({
      supported: false,
      reason: "adapter-unavailable",
      message: notImplementedMessage,
    });
  }

  public async launch(_input: RuntimeAdapterLaunchInput): Promise<RuntimeAdapterLaunchResult> {
    parseRuntimeAdapterLaunchInput(_input);
    throw notImplementedError();
  }
}
