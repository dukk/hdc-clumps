import { pveJsonRequest, pveData, pveDataArray, pveFormBody, waitForPveTask } from "./pve-http.mjs";

/**
 * @param {string} msg
 */
export function pveAuthFailureHint(msg) {
  if (!/HTTP 401/.test(msg)) return "";
  return (
    " Set a per-host API token in vault (HDC_PROXMOX_API_TOKEN_<HOST>) with VM.Audit and Datastore.Audit, " +
    "or broaden the existing token's privileges."
  );
}

/**
 * @param {string} volid e.g. local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst
 * @returns {string | null} appliance catalog filename for pveam / aplinfo
 */
export function applianceTemplateFromVolid(volid) {
  const s = String(volid ?? "").trim();
  const m = s.match(/:vztmpl\/(.+)$/);
  return m?.[1] ? m[1] : null;
}

/**
 * @param {string} apiBase
 * @param {string} node
 * @param {string} storage
 * @param {string} template appliance catalog filename
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 * @param {(line: string) => void} log
 * @param {import("./pve-version.mjs").PveProfile} [profile]
 */
export async function downloadLxcApplianceTemplate(
  apiBase,
  node,
  storage,
  template,
  authorization,
  rejectUnauthorized,
  log,
  profile,
) {
  const method = profile?.lxcTemplateDownload ?? "aplinfo";
  if (method !== "aplinfo") {
    throw new Error(`Unsupported LXC template download method ${JSON.stringify(method)} for this PVE version`);
  }
  const path = `/nodes/${encodeURIComponent(node)}/aplinfo`;
  const form = pveFormBody({ storage, template });
  const body = await pveJsonRequest("POST", apiBase, path, authorization, rejectUnauthorized, form);
  const upid = pveData(body);
  if (typeof upid !== "string" || !upid.trim()) {
    throw new Error(`Proxmox apl_download did not return a task id for ${template}`);
  }
  log(`Downloading ${template} to storage ${storage} on ${node} …`);
  await waitForPveTask({
    apiBase,
    node,
    upid: upid.trim(),
    authorization,
    rejectUnauthorized,
    log: (line) => log(line),
  });
}

/**
 * @param {string} apiBase
 * @param {string} node
 * @param {string} storage
 * @param {string} authorization
 * @param {boolean} rejectUnauthorized
 */
export async function fetchVztmplVolidsOnNode(apiBase, node, storage, authorization, rejectUnauthorized) {
  const path = `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content?content=vztmpl`;
  const body = await pveJsonRequest("GET", apiBase, path, authorization, rejectUnauthorized, undefined);
  const rows = pveDataArray(body);
  /** @type {string[]} */
  const volids = [];
  for (const r of rows) {
    if (typeof r.volid === "string" && r.volid.trim()) volids.push(r.volid.trim());
  }
  return volids;
}
