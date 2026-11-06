import { constants, createPublicKey, publicEncrypt } from "node:crypto";

let raw = "";
try {
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 8192) throw new Error();
  }
  const { request, token } = JSON.parse(raw);
  const key = createPublicKey(request.public_key);
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength !== 3072)
    throw new Error();
  const label = Buffer.from(
    JSON.stringify([
      "sealant-bootstrap-v1",
      request.identity.deployment_id,
      request.identity.instance_id,
      request.identity.disk_lineage,
      request.boot_id,
      request.operation_id,
      request.manifest_digest,
    ]),
  );
  const encrypted = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: label },
    Buffer.from(token),
  );
  process.stdout.write(encrypted.toString("base64"));
} catch {
  process.stderr.write("Invalid bootstrap exchange\n");
  process.exitCode = 2;
}
