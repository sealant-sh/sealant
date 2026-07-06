import {
  parseRuntimeAdapterLaunchInput,
  parseRuntimeAdapterSupportInput,
  parseRuntimeAdapterSupport,
  type RuntimeAdapter,
  type RuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchResult,
  type RuntimeAdapterSupportInput,
  type RuntimeAdapterSupport,
} from "./runtime-adapter.js";

const notImplementedMessage = "The K3s runtime adapter launch path is not implemented yet.";

const notImplementedError = (): Error & { code: string } => {
  const error = new Error(notImplementedMessage) as Error & { code: string };
  error.code = "adapter-unavailable";
  return error;
};

export class K3sRuntimeAdapter implements RuntimeAdapter {
  public readonly id = "k3s" as const;

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
