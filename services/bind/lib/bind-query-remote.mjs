/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 */
export function queryNamedActive(exec) {
  const r = exec.run("systemctl is-active named 2>/dev/null || echo inactive", { capture: true });
  return {
    ok: r.status === 0,
    active: r.stdout.trim() === "active",
    raw: r.stdout.trim(),
  };
}

/**
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} exec
 * @param {string} zone
 * @param {string} [server] dig @server; defaults to querying via exec host.
 */
export function querySoa(exec, zone, server) {
  const at = server ? `@${server}` : "@127.0.0.1";
  const r = exec.run(`dig +short SOA ${zone} ${at} 2>/dev/null | head -1`, { capture: true });
  const line = r.stdout.trim();
  const serial = line ? line.split(/\s+/)[2] ?? "" : "";
  return { ok: r.status === 0 && Boolean(line), soa: line, serial };
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for slave SOA serial to match master after a primary zone push (NOTIFY / IXFR).
 * @param {object} opts
 * @param {string} opts.zone
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.primaryExec
 * @param {import("../../postfix-relay/lib/postfix-relay-configure.mjs").ConfigureExec} opts.secondaryExec
 * @param {(line: string) => void} [opts.log]
 * @param {number} [opts.maxAttempts]
 * @param {number} [opts.intervalMs]
 */
export async function waitForSoaSerialMatch(opts) {
  const maxAttempts = opts.maxAttempts ?? 15;
  const intervalMs = opts.intervalMs ?? 2000;
  const log = opts.log ?? (() => {});

  /** @type {{ primary_serial: string; secondary_serial: string }} */
  let last = { primary_serial: "", secondary_serial: "" };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const primarySoa = querySoa(opts.primaryExec, opts.zone);
    const secondarySoa = querySoa(opts.secondaryExec, opts.zone);
    last = { primary_serial: primarySoa.serial, secondary_serial: secondarySoa.serial };
    const serialMatch =
      primarySoa.ok &&
      secondarySoa.ok &&
      primarySoa.serial &&
      primarySoa.serial === secondarySoa.serial;
    if (serialMatch) {
      return {
        ok: true,
        zone: opts.zone,
        primary_serial: primarySoa.serial,
        secondary_serial: secondarySoa.serial,
        serial_match: true,
        attempts: attempt,
      };
    }
    if (attempt === 1) {
      log(
        `SOA mismatch for ${opts.zone} (primary ${primarySoa.serial} vs secondary ${secondarySoa.serial}); rndc retransfer on secondary`,
      );
      opts.secondaryExec.run(`rndc retransfer ${opts.zone} 2>/dev/null || true`, { capture: true });
    } else {
      log(`waiting for SOA sync (${attempt}/${maxAttempts})`);
    }
    await sleep(intervalMs);
  }

  return {
    ok: false,
    zone: opts.zone,
    primary_serial: last.primary_serial,
    secondary_serial: last.secondary_serial,
    serial_match: false,
    attempts: maxAttempts,
  };
}
