/**
 * The ids that name a person, and the one rule that keeps a resource domain out of them.
 *
 * A resource domain (`resource-domains.ts`) is an owner that is not a person: it never holds a
 * login or a provider credential and never runs a harness. Core mints every resource domain id
 * with {@link RESOURCE_DOMAIN_ID_PREFIX}, and no `user` row may carry it (a database check), so
 * the spelling alone tells the two apart. Every field and header that names a person (`ownerUserId`,
 * `onBehalfOfUserId`, `userId`, the SSH gateway's `principalId`) is a {@link PersonId}: a domain id there is refused with a `400`
 * `RequestRefusedError` while the request is decoded, before any handler runs. A test walks every
 * endpoint of the control plane API and fails on a person field that is not one.
 */
import { Schema } from "effect";

export const RESOURCE_DOMAIN_ID_PREFIX = "rdm:";

export const isResourceDomainId = (id: string): boolean => id.startsWith(RESOURCE_DOMAIN_ID_PREFIX);

/** Why an id cannot name a person, after the field's name. Never quotes the id. */
export const NOT_A_PERSON =
  "names a resource domain, which never holds a login or a provider credential and never runs a harness";

export const PersonId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isTrimmed(),
  Schema.makeFilter((id: string) => (isResourceDomainId(id) ? NOT_A_PERSON : undefined)),
);
