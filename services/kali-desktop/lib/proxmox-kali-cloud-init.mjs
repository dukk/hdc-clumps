import { stderr as errout } from "node:process";

import { pveFormBody, pveJsonRequest } from "../../../infrastructure/proxmox/lib/pve-http.mjs";
import { discoverLocalSshMaterial } from "hdc/cli/lib/ssh-host-access.mjs";

/**
 * Build Proxmox cloud-init config fields for Kali (non-root ciuser).
 * @param {object} opts
 * @param {string} opts.hostname
 * @param {string} opts.ipCidr
 * @param {string} opts.gateway
 * @param {string} opts.ciuser
 * @param {string} [opts.cipassword]
 * @param {string[]} [opts.dnsServers]
 * @param {string[]} [opts.publicKeyLines]
 * @returns {{ fields: Record<string, string | number>; sshBlob: string | null; keyCount: number }}
 */
export function buildKaliCloudInitFields(opts) {
  const { hostname, ipCidr, gateway, ciuser, cipassword, dnsServers = [] } = opts;
  const keys = (opts.publicKeyLines ?? [])
    .map((line) => line.replace(/\r/g, "").trim())
    .filter(Boolean);

  const dns = dnsServers.map((s) => String(s).trim()).filter(Boolean);
  const ipParts = [`ip=${ipCidr}`, `gw=${gateway}`];
  if (dns.length) ipParts.push(`dns=${dns.join("+")}`);

  /** @type {Record<string, string | number>} */
  const fields = {
    ipconfig0: ipParts.join(","),
    name: hostname,
    ciupgrade: 0,
    ciuser,
  };
  if (typeof cipassword === "string" && cipassword.length > 0) {
    fields.cipassword = cipassword;
  }

  const sshBlob =
    keys.length > 0 ? encodeURIComponent(encodeURIComponent(keys.join("\n"))) : null;

  return { fields, sshBlob, keyCount: keys.length };
}

/**
 * Apply cloud-init on a Kali QEMU guest (ciuser is typically `kali`, not root).
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.authorization
 * @param {boolean} opts.rejectUnauthorized
 * @param {string} opts.node
 * @param {number} opts.vmid
 * @param {string} opts.hostname
 * @param {string} opts.ipCidr
 * @param {string} opts.gateway
 * @param {string} opts.ciuser
 * @param {string} opts.cipassword
 * @param {string[]} [opts.dnsServers]
 * @param {(line: string) => void} [opts.log]
 */
export async function applyKaliCloudInit(opts) {
  const {
    apiBase,
    authorization,
    rejectUnauthorized,
    node,
    vmid,
    hostname,
    ipCidr,
    gateway,
    ciuser,
    cipassword,
    dnsServers,
  } = opts;
  const log = opts.log ?? ((line) => errout.write(`${line}\n`));
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/config`;

  const { publicKeyLines } = discoverLocalSshMaterial();
  const { fields, sshBlob, keyCount } = buildKaliCloudInitFields({
    hostname,
    ipCidr,
    gateway,
    ciuser,
    cipassword,
    dnsServers,
    publicKeyLines,
  });

  log(
    `Setting cloud-init on vmid ${vmid}: ${fields.ipconfig0}, hostname ${hostname}, ciuser ${ciuser}` +
      (keyCount ? `, ${keyCount} SSH key(s)` : " (no local ~/.ssh public keys)"),
  );
  await pveJsonRequest("PUT", apiBase, path, authorization, rejectUnauthorized, pveFormBody(fields));

  if (sshBlob) {
    const sshBody = `sshkeys=${sshBlob}`;
    log(`Setting cloud-init SSH keys on vmid ${vmid} …`);
    await pveJsonRequest("PUT", apiBase, path, authorization, rejectUnauthorized, sshBody);
  }

  const regenPath = `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(vmid))}/cloudinit`;
  try {
    log(`Regenerating cloud-init drive for vmid ${vmid} …`);
    await pveJsonRequest("POST", apiBase, regenPath, authorization, rejectUnauthorized, undefined);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message || e);
    log(`cloud-init regenerate skipped (${msg}) — stop/start the guest if keys or IP do not apply.`);
  }
}
