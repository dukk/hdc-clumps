/** Max clone/create attempts when Proxmox reports a VMID conflict. */
export const VMID_CONFLICT_MAX_ATTEMPTS = 32;

const VMID_CONFLICT_RE =
  /config file already exists|already exists|already in use/i;

/**
 * @param {string} message
 */
export function isVmidConflictError(message) {
  return VMID_CONFLICT_RE.test(message);
}

/**
 * @param {Record<string, unknown>[]} resources
 * @returns {Set<number>}
 */
export function collectClusterVmids(resources) {
  /** @type {Set<number>} */
  const out = new Set();
  for (const r of resources) {
    const raw = r.vmid;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      out.add(raw);
      continue;
    }
    if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
      const n = Number(raw.trim());
      if (n > 0) out.add(n);
    }
  }
  return out;
}

/**
 * Smallest integer >= start not present in used or taken.
 * @param {number} start
 * @param {Set<number>} used
 * @param {Set<number>} taken
 */
export function nextVmidCandidate(start, used, taken) {
  let v = start;
  while (v < 1_000_000) {
    if (!used.has(v) && !taken.has(v)) return v;
    v += 1;
  }
  throw new Error(`No VMID candidate from ${start} (exhausted search)`);
}

/**
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionResult} provisionResult
 * @param {number} requested
 */
export function resolveProvisionVmid(provisionResult, requested) {
  const d = provisionResult.details;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const raw = /** @type {Record<string, unknown>} */ (d).vmid;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
    if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  }
  return requested;
}

/**
 * POST with automatic VMID bump on Proxmox ID conflicts.
 *
 * @param {object} opts
 * @param {number} opts.requestedVmid
 * @param {Set<number>} opts.clusterUsed
 * @param {import("../../../lib/host-provisioner.mjs").ProvisionLog} opts.log
 * @param {(vmid: number) => Promise<unknown>} opts.tryPost
 * @param {number} [opts.maxAttempts]
 * @returns {Promise<
 *   | { ok: true; vmid: number; data: unknown; requested_vmid: number; vmid_reassigned: boolean }
 *   | { ok: false; message: string }
 * >}
 */
export async function postWithVmidRetry(opts) {
  const maxAttempts = opts.maxAttempts ?? VMID_CONFLICT_MAX_ATTEMPTS;
  const requestedVmid = opts.requestedVmid;
  /** @type {Set<number>} */
  const taken = new Set();
  let lastError = "";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate =
      attempt === 0 ? requestedVmid : nextVmidCandidate(requestedVmid + 1, opts.clusterUsed, taken);
    taken.add(candidate);

    try {
      const data = await opts.tryPost(candidate);
      return {
        ok: true,
        vmid: candidate,
        data,
        requested_vmid: requestedVmid,
        vmid_reassigned: candidate !== requestedVmid,
      };
    } catch (e) {
      lastError = /** @type {Error} */ (e).message || String(e);
      if (!isVmidConflictError(lastError)) {
        return { ok: false, message: lastError };
      }
      const nextHint =
        attempt + 1 < maxAttempts
          ? `; trying next vmid`
          : `; no more attempts (${maxAttempts})`;
      opts.log.warn(`vmid ${candidate} conflict: ${lastError}${nextHint}`);
    }
  }

  const tried = [...taken].sort((a, b) => a - b);
  const range =
    tried.length <= 6
      ? tried.join(", ")
      : `${tried[0]}–${tried[tried.length - 1]} (${tried.length} ids)`;
  return {
    ok: false,
    message: `VMID conflict after ${maxAttempts} attempts (requested ${requestedVmid}, tried ${range}): ${lastError}`,
  };
}
