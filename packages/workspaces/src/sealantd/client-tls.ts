/**
 * Resolve the control-plane's client material from the shared env contract
 * (`controlClientTlsEnvSchema` + `microvmRuntimeEnvSchema` in `@sealant/validators/env`). Every
 * process that opens control connections (API, worker, SSH gateway) feeds the result into
 * `sealantTargetForRuntimeInstance` so Kubernetes instances (client mTLS), Cloudflare instances
 * (bearer token) and MicroVM instances (bearer token + minted endpoint tokens) become
 * addressable; Docker deployments leave all of it unset.
 */
import {
  microvmEndpointTokensFromEnv,
  type MicrovmEndpointTokens,
} from "../runtime/microvm/endpoint-tokens.js";
import type { SealantTargetDerivationOptions } from "./target.js";

export interface ControlClientTlsEnvLike {
  readonly SEALANT_CONTROL_CLIENT_CERT_PATH?: string | undefined;
  readonly SEALANT_CONTROL_CLIENT_KEY_PATH?: string | undefined;
  readonly SEALANT_CONTROL_CA_PATH?: string | undefined;
  readonly SEALANT_CONTROL_BEARER_TOKEN?: string | undefined;
  readonly SEALANT_MICROVM_REGION?: string | undefined;
  readonly SEALANT_MICROVM_AGENT_PORT?: number | undefined;
  readonly SEALANT_MICROVM_TOKEN_TTL_MINUTES?: number | undefined;
  readonly SEALANT_MICROVM_TOKEN_REFRESH_MARGIN_MS?: number | undefined;
  readonly SEALANT_MICROVM_WS_AUTH?: "header" | "subprotocol" | undefined;
}

/**
 * Derivation options for this process: websocket TLS when fully configured, the bearer token
 * when set, and MicroVM endpoint-token minting when a region is set. Pass `microvmTokens` to
 * share one token cache with a `MicrovmRuntimeAdapter` in the same process (the worker does).
 */
export const targetDerivationOptionsFromEnv = (
  env: ControlClientTlsEnvLike,
  microvmTokens?: MicrovmEndpointTokens,
): SealantTargetDerivationOptions => {
  const certPath = env.SEALANT_CONTROL_CLIENT_CERT_PATH;
  const keyPath = env.SEALANT_CONTROL_CLIENT_KEY_PATH;
  const caPath = env.SEALANT_CONTROL_CA_PATH;
  const bearerToken = env.SEALANT_CONTROL_BEARER_TOKEN;
  const tokens = microvmTokens ?? microvmEndpointTokensFromEnv(env);
  return {
    ...(certPath === undefined || keyPath === undefined || caPath === undefined
      ? {}
      : { websocketTls: { caPath, certPath, keyPath } }),
    ...(bearerToken === undefined ? {} : { controlBearerToken: bearerToken }),
    ...(tokens === undefined
      ? {}
      : { microvmConnectMaterial: (microvmId: string) => tokens.connectMaterial(microvmId) }),
  };
};
