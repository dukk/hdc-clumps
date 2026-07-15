/**
 * @param {string} s
 */
export function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {unknown} v
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").parseVrrpInstances>[number]} inst
 */
function renderTrackScripts(inst) {
  const scripts = inst.trackScripts;
  if (!scripts.length) return "";
  const blocks = scripts.map((ts) => {
    const lines = [
      `vrrp_script ${ts.id} {`,
      `    script "${ts.script.replace(/"/g, '\\"')}"`,
      `    interval ${ts.interval}`,
    ];
    if (ts.weight !== 0) {
      lines.push(`    weight ${ts.weight}`);
    }
    lines.push("}");
    return lines.join("\n");
  });
  return `${blocks.join("\n\n")}\n\n`;
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").parseVrrpInstances>[number]} inst
 * @param {ReturnType<typeof import("./deployments.mjs").finalizeDirectorDeployment>} director
 * @param {string} authPass
 */
function renderVrrpInstance(inst, director, authPass) {
  const trackRefs = inst.trackScripts.map((ts) => `        ${ts.id}`).join("\n");
  const vips = inst.virtualIpaddress.map((a) => `        ${a}`).join("\n");
  const lines = [
    `vrrp_instance ${inst.instanceName} {`,
    `    state ${director.state}`,
    `    interface ${inst.interface}`,
    `    virtual_router_id ${inst.virtualRouterId}`,
    `    priority ${director.priority}`,
    "    advert_int 1",
    "    authentication {",
    "        auth_type PASS",
    `        auth_pass ${authPass}`,
    "    }",
  ];
  if (trackRefs) {
    lines.push("    track_script {", trackRefs, "    }");
  }
  lines.push("    virtual_ipaddress {", vips, "    }", "}");
  return lines.join("\n");
}

/**
 * @param {ReturnType<typeof import("./deployments.mjs").parseVirtualServers>[number]} vs
 */
function renderVirtualServer(vs) {
  const realBlocks = vs.realServers.map((rs) => {
    const lines = [
      `    real_server ${rs.address} ${rs.port} {`,
      `        weight ${rs.weight}`,
      "        TCP_CHECK {",
      `            connect_port ${rs.port}`,
      "        }",
      "    }",
    ];
    return lines.join("\n");
  });
  const lines = [
    `virtual_server ${vs.vip} ${vs.port} {`,
    "    delay_loop 6",
    `    lb_algo ${vs.lbAlgo}`,
    `    lb_kind ${vs.lbKind}`,
    `    protocol ${vs.protocol}`,
    "",
    ...realBlocks,
    "}",
  ];
  return lines.join("\n");
}

/**
 * Render keepalived.conf for a director node.
 *
 * @param {object} opts
 * @param {ReturnType<typeof import("./deployments.mjs").keepalivedGlobalSettings>} opts.global
 * @param {ReturnType<typeof import("./deployments.mjs").finalizeDirectorDeployment>} opts.director
 * @param {ReturnType<typeof import("./deployments.mjs").parseVrrpInstances>} opts.vrrpInstances
 * @param {ReturnType<typeof import("./deployments.mjs").parseVirtualServers>} opts.virtualServers
 * @param {string} opts.authPass
 */
export function renderKeepalivedConf(opts) {
  const { global, director, vrrpInstances, virtualServers, authPass } = opts;
  const selectedVrrp = vrrpInstances.filter((v) => director.vrrpInstanceIds.includes(v.id));
  const selectedVrrpIds = new Set(selectedVrrp.map((v) => v.id));
  const selectedVs = virtualServers.filter((vs) => selectedVrrpIds.has(vs.vrrpInstanceId));

  const parts = [`global_defs {\n    router_id ${global.routerId}\n}\n\n`];

  for (const inst of selectedVrrp) {
    parts.push(renderTrackScripts(inst));
    parts.push(renderVrrpInstance(inst, director, authPass));
    parts.push("\n\n");
  }

  for (const vs of selectedVs) {
    parts.push(renderVirtualServer(vs));
    parts.push("\n\n");
  }

  return parts.join("").trimEnd() + "\n";
}

/**
 * Shell commands to prepare a DR mode real server (loopback VIP + ARP sysctl).
 * @param {string} vip CIDR or address e.g. 192.0.2.50/32
 */
export function buildDrRealServerCommands(vip) {
  const addr = vip.includes("/") ? vip.split("/")[0] : vip;
  const cidr = vip.includes("/") ? vip : `${vip}/32`;
  return `set -e
grep -q '^net.ipv4.conf.all.arp_ignore' /etc/sysctl.d/99-hdc-keepalived-rs.conf 2>/dev/null || cat > /etc/sysctl.d/99-hdc-keepalived-rs.conf <<'EOF'
net.ipv4.conf.all.arp_ignore = 1
net.ipv4.conf.all.arp_announce = 2
EOF
sysctl --system >/dev/null 2>&1 || sysctl -p /etc/sysctl.d/99-hdc-keepalived-rs.conf
ip addr show dev lo | grep -q ${shellQuote(addr)} || ip addr add ${shellQuote(cidr)} dev lo
`;
}

/**
 * Verify NAT real server default route points at director VIP (non-fatal warning only).
 * @param {string} directorVip
 */
export function buildNatRealServerVerifyCommand(directorVip) {
  const addr = directorVip.includes("/") ? directorVip.split("/")[0] : directorVip;
  return `ip route show default | grep -q ${shellQuote(addr)} && echo "nat_gw_ok" || echo "nat_gw_check: default route does not use director VIP ${addr}"`;
}

/**
 * @param {boolean} enableNat
 */
export function buildDirectorSysctlCommands(enableNat) {
  if (!enableNat) return "";
  return `grep -q '^net.ipv4.ip_forward' /etc/sysctl.d/99-hdc-keepalived-director.conf 2>/dev/null || echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-hdc-keepalived-director.conf
sysctl --system >/dev/null 2>&1 || sysctl -p /etc/sysctl.d/99-hdc-keepalived-director.conf
`;
}
