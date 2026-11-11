import { z } from "zod";

import { boatExecutionTargetSchema } from "./boat-run.js";

/** Canonical nonzero 32-byte WireGuard key. The last base64 character has two zero padding bits. */
export const boatWireGuardKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/)
  .refine((value) => value !== "A".repeat(43) + "=");

/**
 * The host ports a run's gateway is given, one each: published on the relay host address alone and
 * reached only by Core's own carrier, so no firewall names them. They sit above Linux's default
 * ephemeral range (32768 to 60999): a port in that range can already be the source port of an
 * outbound socket on the host (Core's own carrier to another gateway is one), and the gateway
 * that was reserved it could then never bind it.
 */
export const BOAT_TUNNEL_PORTS = { first: 61000, last: 61511 } as const;
/**
 * The sixteen ports of the tunnel's first allocator, from when each had to be opened to the
 * Internet for VMs to dial. No longer handed out; a reservation that holds one stays valid until
 * its run ends.
 */
export const BOAT_TUNNEL_LEGACY_PORTS = { first: 40000, last: 40015 } as const;
const within = (range: { readonly first: number; readonly last: number }, port: number) =>
  port >= range.first && port <= range.last;

/** Stable operator-owned identity for the Docker host, shared across deployments on that host. */
export const boatTunnelBindingSchema = z.strictObject({
  target: boatExecutionTargetSchema,
  gatewayHostId: z.uuid().transform((value) => value.toLowerCase()),
});
/** A reservation does not authorize resource access or guest admission. */
export type BoatTunnelBinding = z.infer<typeof boatTunnelBindingSchema>;

/** Ciphertext only. Both private keys are sealed together under the complete reservation context. */
export const boatTunnelMaterialSchema = z
  .strictObject({
    gatewayPublicKey: boatWireGuardKeySchema,
    guestPublicKey: boatWireGuardKeySchema,
    sealedKeys: z.string().min(1).max(8192),
  })
  .refine((value) => value.gatewayPublicKey !== value.guestPublicKey);
/** Private persisted key custody, never a public API projection. */
export type BoatTunnelMaterial = z.infer<typeof boatTunnelMaterialSchema>;

/** Public immutable setup intent. Reconciliation must not silently change a guest's network. */
export const boatNetworkIntentSchema = z.strictObject({
  epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  operationId: z.uuid(),
  /**
   * The gateway's public address a VM dialled, from when a tunnel could be dialled over UDP.
   * Never written now and never read: it is kept so a reservation made before the upgrade still
   * parses, and its run can still be reconciled and closed.
   */
  endpoint: z.ipv4().optional(),
  subnet: z
    .string()
    .regex(/^[0-9.]+\/27$/)
    .refine((value) => {
      const [address, prefix] = value.split("/");
      return (
        prefix === "27" &&
        z.ipv4().safeParse(address).success &&
        Number(address?.split(".").at(-1)) % 32 === 0 &&
        (address?.startsWith("10.") ||
          address?.startsWith("192.168.") ||
          (address?.startsWith("172.") &&
            Number(address.split(".")[1]) >= 16 &&
            Number(address.split(".")[1]) <= 31))
      );
    }),
});
/** Frozen before the first gateway or guest setup request. */
export type BoatNetworkIntent = z.infer<typeof boatNetworkIntentSchema>;

/** One port and key pair per execution. Only positively completed canonical close releases it. */
export const boatTunnelReservationSchema = z
  .strictObject({
    binding: boatTunnelBindingSchema,
    reservationId: z.uuid().transform((value) => value.toLowerCase()),
    listenPort: z
      .number()
      .int()
      .refine((port) => within(BOAT_TUNNEL_PORTS, port) || within(BOAT_TUNNEL_LEGACY_PORTS, port)),
    material: boatTunnelMaterialSchema.nullable(),
    network: boatNetworkIntentSchema.optional(),
    updates: z
      .array(z.uuid())
      .max(16)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    closeId: z.uuid().optional(),
    removal: z
      .strictObject({ id: z.string().regex(/^bdop_[a-f0-9]{32}$/), completed: z.boolean() })
      .optional(),
    released: z.literal(true).optional(),
    aborted: z.literal(true).optional(),
    /** Released because Boat positively no longer has the guest (its observation is absent). */
    absent: z.literal(true).optional(),
  })
  .superRefine((record, context) => {
    if (
      (record.closeId !== undefined && (record.updates?.length ?? 0) !== 0) ||
      (record.removal !== undefined && record.closeId === undefined) ||
      (record.aborted === true && (record.closeId === undefined || record.removal !== undefined)) ||
      (record.absent === true && record.closeId === undefined) ||
      (record.released === true &&
        record.removal?.completed !== true &&
        record.aborted !== true &&
        record.absent !== true)
    )
      context.addIssue({ code: "custom", message: "Invalid tunnel close state" });
  });
/** Parsed durable reservation. Null material holds its port until key installation resumes. */
export type BoatTunnelReservation = z.infer<typeof boatTunnelReservationSchema>;
