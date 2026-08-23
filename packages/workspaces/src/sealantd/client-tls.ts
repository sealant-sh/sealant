/**
 * Resolve the control-plane's client mTLS material from the shared env contract
 * (`controlClientTlsEnvSchema` in `@sealant/validators/env`). Every process that opens control
 * connections (API, worker, SSH gateway) feeds the result into `sealantTargetForRuntimeInstance`
 * so Kubernetes instances become addressable; Docker deployments leave all three unset.
 */
import type { SealantTargetDerivationOptions } from "./target.js";

export interface ControlClientTlsEnvLike {
  readonly SEALANT_CONTROL_CLIENT_CERT_PATH?: string | undefined;
  readonly SEALANT_CONTROL_CLIENT_KEY_PATH?: string | undefined;
  readonly SEALANT_CONTROL_CA_PATH?: string | undefined;
}

/** Derivation options for this process: websocket TLS when fully configured, nothing otherwise. */
export const targetDerivationOptionsFromEnv = (
  env: ControlClientTlsEnvLike,
): SealantTargetDerivationOptions => {
  const certPath = env.SEALANT_CONTROL_CLIENT_CERT_PATH;
  const keyPath = env.SEALANT_CONTROL_CLIENT_KEY_PATH;
  const caPath = env.SEALANT_CONTROL_CA_PATH;
  if (certPath === undefined || keyPath === undefined || caPath === undefined) {
    return {};
  }
  return { websocketTls: { caPath, certPath, keyPath } };
};
