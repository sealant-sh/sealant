/**
 * Client-side refusal of a network policy and its brokered secrets, with the rules and words the
 * control plane applies on every parse (`@sealant/api-contracts/network-policy`), so a bad policy
 * fails before a request is sent instead of as a 400. Values are checked, never quoted.
 */
import {
  brokeredSecretsProblems,
  brokeredSecretValuesProblems,
  networkPolicyProblems,
  type BrokeredSecret,
  type NetworkPolicy,
} from "@sealant/api-contracts/network-policy";

import { SealantError } from "../errors.js";

export const requireValidNetworkPolicy = (
  operation: string,
  input: {
    readonly networkPolicy?: NetworkPolicy | undefined;
    readonly brokeredSecrets?: readonly BrokeredSecret[] | undefined;
    readonly brokeredSecretValues?: Readonly<Record<string, string>> | undefined;
    /** Variables the spec also sets (`env`): a brokered secret's `name` may not be one. */
    readonly envNames?: readonly string[] | undefined;
    /** Variables `secretEnv` sets: it would win over the placeholder, so none may be one. */
    readonly secretEnvNames?: readonly string[] | undefined;
  },
): void => {
  const secrets = input.brokeredSecrets ?? [];
  const envNames = new Set(input.envNames ?? []);
  const secretEnvNames = new Set(input.secretEnvNames ?? []);
  const problems = [
    ...(input.networkPolicy === undefined ? [] : networkPolicyProblems(input.networkPolicy)),
    ...brokeredSecretsProblems(secrets),
    ...brokeredSecretValuesProblems(secrets, input.brokeredSecretValues ?? {}),
    // The blueprint's own check, in its words (`runtime.userEnv` is what `env` becomes).
    ...secrets
      .filter((secret) => envNames.has(secret.name))
      .map(
        (secret) =>
          `brokeredSecrets \`${secret.secretId}\`: ${secret.name} is also set in runtime.env or runtime.userEnv`,
      ),
    // The control plane's create check, in its words.
    ...secrets
      .filter((secret) => secretEnvNames.has(secret.name))
      .map(
        (secret) =>
          `brokeredSecrets \`${secret.secretId}\`: ${secret.name} is also set in secretEnv`,
      ),
  ];
  if (problems.length > 0) {
    throw new SealantError(`${operation} was rejected: ${problems.join("; ")}`, {
      code: "invalid_network_policy",
    });
  }
};
