import { z } from "zod";

import { boatExecutionTargetSchema } from "./boat-execution.js";

/** Canonical nonzero 32-byte WireGuard key. The last base64 character has two zero padding bits. */
export const boatWireGuardKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/)
  .refine((value) => value !== "A".repeat(43) + "=");

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

/** One port and key pair per exact execution, with no automatic expiry or recycling. */
export const boatTunnelReservationSchema = z.strictObject({
  binding: boatTunnelBindingSchema,
  reservationId: z.uuid().transform((value) => value.toLowerCase()),
  listenPort: z.number().int().min(40000).max(40015),
  material: boatTunnelMaterialSchema.nullable(),
});
/** Parsed durable reservation. Null material holds its port until key installation resumes. */
export type BoatTunnelReservation = z.infer<typeof boatTunnelReservationSchema>;
