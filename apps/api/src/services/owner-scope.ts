/**
 * Owner scope on every operation (CORE-03).
 *
 * Every owned resource is read and changed on behalf of one owner, and the caller names that
 * owner on every call. "No owner named" used to mean "unscoped": a read of any run by id, a
 * listing across owners, a status flip or a rename of a resource nobody had to claim. It now means
 * the resource is not found. A service key still asserts any owner; what it may no longer do is
 * act without one, so a bug in a caller cannot widen into every owner's data.
 *
 * `SEALANT_REQUIRE_OWNER_SCOPE=false` restores the unscoped reads for one rollout, so a control
 * plane can be upgraded ahead of an SDK caller that does not yet send the owner everywhere. It is
 * logged at start and is not meant to stay off.
 */
import { env } from "../runtime-env.js";

export type OwnerScope =
  | { readonly kind: "owner"; readonly ownerUserId: string }
  /** Legacy only: the caller named no owner and this install still tolerates that. */
  | { readonly kind: "unscoped" }
  | { readonly kind: "missing" };

export const resolveOwnerScope = (
  asserted: string | undefined,
  required: boolean = env.SEALANT_REQUIRE_OWNER_SCOPE,
): OwnerScope => {
  const owner = asserted?.trim();
  if (owner !== undefined && owner.length > 0) return { kind: "owner", ownerUserId: owner };
  return required ? { kind: "missing" } : { kind: "unscoped" };
};

/** Whether a resource owned by `resourceOwner` is inside the scope. */
export const scopeAdmits = (scope: OwnerScope, resourceOwner: string): boolean =>
  scope.kind === "unscoped" || (scope.kind === "owner" && scope.ownerUserId === resourceOwner);

export const OWNER_REQUIRED_HINT = "ownerUserId is required on this call";
