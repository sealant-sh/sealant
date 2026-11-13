import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { boatAccounts } from "./boat-accounts.js";
import { workspaceAttempts } from "./control-plane.js";
import { nativePublications } from "./native-publications.js";

const instant = () => timestamp({ mode: "date", withTimezone: true });

/**
 * One row per Boat run: everything sealant asked of Boat for the run, everything Boat answered, and
 * everything handed to the VM's agent. A fact is a column, set once by one guarded statement.
 *
 * The row outlives job claims and holds the run's publication pin until Boat's own answer says it
 * has no VM for the run (`absent_at`). `absent_at` is terminal and comes from Boat alone
 * (`absent_basis`): its typed 404 for a VM it had reported past creation, its own completed
 * deletion operation, or sealant's own record that create was never issued or was refused. A
 * timeout or an unreadable reply is never absence, and nothing here stands for elapsed time.
 */
export const boatRuns = snakeCase.table(
  "boat_runs",
  {
    runId: text()
      .primaryKey()
      .references(() => workspaceAttempts.id, { onDelete: "restrict" }),
    deploymentId: text().notNull(),
    /**
     * The stored Boat account the run was created under, whose key every later call for the run
     * uses. Null: the install's default account (the env key), as every run made before accounts
     * existed is.
     */
    accountId: uuid().references(() => boatAccounts.id, { onDelete: "restrict" }),
    /**
     * The Boat wallet it was created in, named (`X-Boat-Org`) on every later request about it: an
     * organization's id or name, or `personal`; null with `boatWalletState` `known`: the key's only
     * wallet (an organization's key), named by no header. See `boatWalletState`.
     */
    boatWallet: text(),
    /**
     * `known`: `boatWallet` is where it is. `unknown`: made before sealant recorded wallets, by an
     * account with no pin; requests about it name no wallet, as they did then, until sealant has
     * found it. `unreachable`: Boat has it in none of the wallets the key can bill (or, for a key
     * that cannot list them, not in the one it bills): the run is absent on that basis.
     */
    boatWalletState: text().notNull().default("unknown"),
    publicationId: uuid()
      .notNull()
      .references(() => nativePublications.id, { onDelete: "restrict" }),
    workspaceId: text().notNull(),
    launchAttemptId: text().notNull(),
    manifestDigest: text().notNull(),
    /** The saved snapshot create names, frozen so a replay under the key asks for the same VM. */
    snapshotName: text().notNull(),
    /** `none`: launched never to be linked to project resources. Null: it has a gateway and a tunnel. */
    resources: text().$type<"none">(),
    idempotencyKey: uuid().notNull().unique(),
    diskLineage: uuid().notNull().unique(),
    /** Set by `now()` in the statement that issues create; a future instant is refused by trigger. */
    createIssuedAt: instant(),
    /**
     * Set by `now()` in the statement that marks the first replay of create under the run's key,
     * before that replay is sent. From then on a refusal of the first create no longer proves Boat
     * holds no VM: the replay may make it. Never set on a row already absent.
     */
    replayIssuedAt: instant(),
    sandboxId: text(),
    /** Boat reported the VM past creation: from then on a 404 for it can only mean it is gone. */
    createdSeenAt: instant(),
    /** The bound target, as sealed into every secret of the run: never rebuilt from columns. */
    target: jsonb().$type<unknown>(),
    exchangeId: uuid(),
    exchangePublicKey: text(),
    sealedExchange: text(),
    sealedControl: text(),
    admissionOperationId: uuid(),
    admissionEpoch: integer(),
    admissionDigest: text(),
    docker: boolean(),
    sealedLaunch: text(),
    isolation: jsonb().$type<unknown>(),
    launchIssuedAt: instant(),
    launchAcceptedAt: instant(),
    fencedAt: instant(),
    deletionClaimedAt: instant(),
    deletionOperationId: text(),
    deletionCompletedAt: instant(),
    absentAt: instant(),
    absentBasis: text().$type<
      "not-found" | "deletion-completed" | "never-created" | "unreachable"
    >(),
    heldReason: text().$type<
      "allocation-conflict" | "lifetime-unverified" | "run-stopped" | "create-unresolved"
    >(),
    conflictingSandboxes: jsonb()
      .$type<unknown>()
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (table) => [
    check(
      "boat_runs_wallet",
      sql`${table.boatWalletState} in ('known','unknown','unreachable') and (${table.boatWalletState} = 'known' or ${table.boatWallet} is null)`,
    ),
    uniqueIndex("boat_runs_sandbox").on(table.deploymentId, table.sandboxId),
    index("boat_runs_deployment").on(table.deploymentId, table.runId),
    index("boat_runs_account").on(table.accountId, table.runId),
    // The runs Boat may still hold a VM for, which is what the sweeps page through: an ended run
    // leaves this index when its absence is committed.
    index("boat_runs_present")
      .on(table.deploymentId, table.runId)
      .where(sql`${table.absentAt} is null`),
    // The runs that never had a VM: the convergence sweep reads their capture records, and an
    // ended run that had one is never in this index.
    index("boat_runs_no_vm")
      .on(table.deploymentId, table.runId)
      .where(sql`${table.sandboxId} is null`),
    check("boat_runs_resources", sql`${table.resources} is null or ${table.resources} = 'none'`),
    // The bound target names this row's run, VM, disk and source, and nothing else.
    check(
      "boat_runs_target",
      sql`${table.target} is null or (${table.sandboxId} is not null and ${table.target}->>'runId' = ${table.runId} and ${table.target}->>'runtimeInstanceId' = ${table.runId} and ${table.target}->>'deploymentId' = ${table.deploymentId} and ${table.target}->>'workspaceId' = ${table.workspaceId} and ${table.target}->>'launchAttemptId' = ${table.launchAttemptId} and ${table.target}->>'sourceId' = ${table.publicationId}::text and ${table.target}->>'sandboxId' = ${table.sandboxId} and ${table.target}->>'diskLineage' = ${table.diskLineage}::text and ${table.target}->>'manifestDigest' = ${table.manifestDigest})`,
    ),
    // A VM exists only for an issued create, and only a VM is seen, claimed or deleted.
    check(
      "boat_runs_vm",
      sql`(${table.sandboxId} is null or ${table.createIssuedAt} is not null) and (${table.sandboxId} is not null or (${table.createdSeenAt} is null and ${table.deletionClaimedAt} is null and ${table.deletionOperationId} is null)) and (${table.deletionCompletedAt} is null or (${table.deletionOperationId} is not null and ${table.absentAt} is not null))`,
    ),
    // A replay is of an issued create.
    check(
      "boat_runs_replay",
      sql`${table.replayIssuedAt} is null or ${table.createIssuedAt} is not null`,
    ),
    // Each step of the launch has the one before it: bind, bearer, sealed launch, push, answer.
    // (A launch carried from before isolation was recorded has none; every new push requires it.)
    check(
      "boat_runs_launch",
      sql`(${table.exchangeId} is null or ${table.target} is not null) and (${table.sealedExchange} is null or (${table.exchangeId} is not null and ${table.exchangePublicKey} is not null)) and (${table.sealedControl} is null or (${table.exchangeId} is not null and ${table.sealedExchange} is null)) and num_nulls(${table.admissionOperationId}, ${table.admissionEpoch}, ${table.admissionDigest}, ${table.docker}) in (0, 4) and (${table.admissionOperationId} is null or ${table.exchangeId} is not null) and ((${table.sealedLaunch} is null and ${table.isolation} is null) or ${table.admissionOperationId} is not null) and (${table.launchIssuedAt} is null or ${table.admissionOperationId} is not null) and (${table.launchAcceptedAt} is null or ${table.launchIssuedAt} is not null)`,
    ),
    // What `boat_observations_shape` held: absence has a basis, and each basis its evidence.
    check(
      "boat_runs_absence",
      sql`(${table.absentAt} is null and ${table.absentBasis} is null)
        or (${table.absentAt} is not null and ${table.absentBasis} = 'not-found' and ${table.sandboxId} is not null and ${table.createdSeenAt} is not null)
        or (${table.absentAt} is not null and ${table.absentBasis} = 'deletion-completed' and ${table.sandboxId} is not null)
        or (${table.absentAt} is not null and ${table.absentBasis} = 'never-created' and ${table.sandboxId} is null)
        or (${table.absentAt} is not null and ${table.absentBasis} = 'unreachable')`,
    ),
    check(
      "boat_runs_held",
      sql`${table.heldReason} is null or (${table.absentAt} is null and ${table.target} is null and ${table.heldReason} in ('allocation-conflict', 'lifetime-unverified', 'run-stopped', 'create-unresolved') and (${table.heldReason} = 'lifetime-unverified') = (${table.sandboxId} is not null) and (${table.heldReason} = 'run-stopped') = (${table.createIssuedAt} is null))`,
    ),
  ],
);

export type BoatRunRow = typeof boatRuns.$inferSelect;
