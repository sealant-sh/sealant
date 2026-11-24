import { NETWORK_GATE_MARKER } from "./docker-egress.js";
import { EGRESS_PROXY_PORTS } from "./egress-proxy-orchestrator.js";
/**
 * The workspace side of a proxy-backed Docker workspace (workspace isolation architecture §3.1):
 * the workspace container is on its isolated network alone with `<name>-proxy`, reaches out only
 * through it (`HTTP(S)_PROXY`, and its DNS), and trusts the run's executor CA for the hosts the
 * proxy inspects. Pure: the adapter runs what these build.
 */
import { EXECUTOR_CA_ENV } from "./executor-ca.js";

/** A tmpfs every start makes empty, where the gate writes the trust bundle. */
export const EGRESS_CA_DIR = "/run/sealant-egress";
export const EGRESS_CA_BUNDLE = `${EGRESS_CA_DIR}/ca-bundle.pem`;
export const EGRESS_CA_CERT = `${EGRESS_CA_DIR}/executor-ca.pem`;

/** The label marking a workspace container that runs behind its own egress proxy. */
export const EGRESS_PROXY_BACKED_LABEL = "sealant.egress-proxy-backed";

/**
 * The gate of a proxy-backed workspace: it waits for the network guard's marker like every gated
 * workspace (`NETWORK_GATE_SCRIPT`), then writes the trust bundle (the image's own roots, then
 * the executor CA from `SEALANT_EXECUTOR_CA_PEM`) before it hands over to the image's command. A
 * bundle that cannot be written ends the container (exit 71): TLS through the proxy would fail
 * in ways much harder to read later. An image with no roots of its own gets the CA alone.
 */
export const EGRESS_PROXY_GATE_SCRIPT = [
  "i=0",
  `while [ ! -e ${NETWORK_GATE_MARKER} ]; do`,
  "  i=$((i + 1))",
  '  if [ "$i" -gt 1500 ]; then echo "sealant: the network guard never released this workspace" >&2; exit 70; fi',
  "  sleep 0.2",
  "done",
  `if [ -z "\${${EXECUTOR_CA_ENV}:-}" ]; then echo "sealant: no executor CA for this workspace" >&2; exit 71; fi`,
  'roots=""',
  "for f in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem /etc/ssl/ca-bundle.pem; do",
  '  if [ -r "$f" ]; then roots="$f"; break; fi',
  "done",
  `printf '%s\\n' "$${EXECUTOR_CA_ENV}" > ${EGRESS_CA_CERT} || { echo "sealant: could not write the executor CA" >&2; exit 71; }`,
  `{ if [ -n "$roots" ]; then cat "$roots"; fi; cat ${EGRESS_CA_CERT}; } > ${EGRESS_CA_BUNDLE} || { echo "sealant: could not write the trust bundle" >&2; exit 71; }`,
  'exec "$@"',
].join("\n");

/** `--entrypoint` and the arguments after the image that put `command` behind the proxy gate. */
export const egressProxyGateArgs = (
  command: ReadonlyArray<string>,
): { readonly entrypoint: ReadonlyArray<string>; readonly args: ReadonlyArray<string> } => ({
  entrypoint: ["--entrypoint", "/bin/sh"],
  args: ["-c", EGRESS_PROXY_GATE_SCRIPT, "sealant-egress-gate", ...command],
});

/**
 * The `docker run` args that send a workspace through its proxy: DNS at the proxy, the proxy as
 * its explicit HTTP and HTTPS proxy (both spellings, which tools read either of), the executor
 * CA's certificate and where every common TLS stack finds the bundle. Only the public certificate
 * is here: the CA's key never leaves sealant and the proxy.
 */
export const proxiedWorkspaceArgs = (input: {
  readonly proxyIp: string;
  readonly caCertPem: string;
  /** The workspace's Docker service, reached directly by name on its own network. */
  readonly dockerService: boolean;
}): ReadonlyArray<string> => {
  const proxy = `http://${input.proxyIp}:${String(EGRESS_PROXY_PORTS.httpProxy)}`;
  const noProxy = [
    "localhost",
    "127.0.0.1",
    "::1",
    ...(input.dockerService ? ["docker"] : []),
  ].join(",");
  const env: ReadonlyArray<readonly [string, string]> = [
    ["HTTP_PROXY", proxy],
    ["HTTPS_PROXY", proxy],
    ["http_proxy", proxy],
    ["https_proxy", proxy],
    ["NO_PROXY", noProxy],
    ["no_proxy", noProxy],
    [EXECUTOR_CA_ENV, input.caCertPem],
    ["SSL_CERT_FILE", EGRESS_CA_BUNDLE],
    ["REQUESTS_CA_BUNDLE", EGRESS_CA_BUNDLE],
    ["CURL_CA_BUNDLE", EGRESS_CA_BUNDLE],
    ["NODE_EXTRA_CA_CERTS", EGRESS_CA_CERT],
  ];
  return [
    "--dns",
    input.proxyIp,
    "--tmpfs",
    `${EGRESS_CA_DIR}:rw,nosuid,nodev,noexec,mode=1777,size=4m`,
    "--label",
    `${EGRESS_PROXY_BACKED_LABEL}=true`,
    ...env.flatMap(([name, value]) => ["-e", `${name}=${value}`]),
  ];
};
