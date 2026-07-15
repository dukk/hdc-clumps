/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} wireguard
 */
export function listenPort(wireguard) {
  const p = typeof wireguard.listen_port === "number" ? wireguard.listen_port : Number(wireguard.listen_port);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return Math.floor(p);
  return 51820;
}

/**
 * @param {Record<string, unknown>} wireguard
 */
export function interfaceAddress(wireguard) {
  const v =
    typeof wireguard.interface_address === "string" && wireguard.interface_address.trim()
      ? wireguard.interface_address.trim()
      : "10.7.0.1/24";
  return v;
}

/**
 * @param {Record<string, unknown>} wireguard
 */
export function privateKeyVaultKey(wireguard) {
  const v =
    typeof wireguard.private_key_vault_key === "string" && wireguard.private_key_vault_key.trim()
      ? wireguard.private_key_vault_key.trim()
      : "HDC_WIREGUARD_PRIVATE_KEY";
  return v;
}

/**
 * @param {Record<string, unknown>} wireguard
 */
export function normalizePeers(wireguard) {
  const peers = Array.isArray(wireguard.peers) ? wireguard.peers : [];
  return peers
    .filter(isObject)
    .map((peer, idx) => {
      const name =
        typeof peer.name === "string" && peer.name.trim() ? peer.name.trim() : `peer-${idx + 1}`;
      const publicKeyVaultKey =
        typeof peer.public_key_vault_key === "string" && peer.public_key_vault_key.trim()
          ? peer.public_key_vault_key.trim()
          : "";
      const presharedKeyVaultKey =
        typeof peer.preshared_key_vault_key === "string" && peer.preshared_key_vault_key.trim()
          ? peer.preshared_key_vault_key.trim()
          : "";
      const allowedIps = Array.isArray(peer.allowed_ips)
        ? peer.allowed_ips
            .map((v) => (typeof v === "string" ? v.trim() : ""))
            .filter(Boolean)
        : [];
      return {
        name,
        public_key_vault_key: publicKeyVaultKey,
        preshared_key_vault_key: presharedKeyVaultKey,
        allowed_ips: allowedIps,
      };
    });
}

/**
 * @param {Record<string, unknown>} wireguard
 * @param {Map<string, string>} secrets
 */
export function renderWg0Conf(wireguard, secrets) {
  const postUp = typeof wireguard.post_up === "string" ? wireguard.post_up.trim() : "";
  const postDown = typeof wireguard.post_down === "string" ? wireguard.post_down.trim() : "";
  const lines = [
    "# hdc-generated",
    "[Interface]",
    `Address = ${interfaceAddress(wireguard)}`,
    `ListenPort = ${listenPort(wireguard)}`,
    `PrivateKey = ${secrets.get(privateKeyVaultKey(wireguard)) ?? ""}`,
    "SaveConfig = false",
  ];
  if (postUp) lines.push(`PostUp = ${postUp}`);
  if (postDown) lines.push(`PostDown = ${postDown}`);
  for (const peer of normalizePeers(wireguard)) {
    lines.push("", `[Peer]`, `# ${peer.name}`);
    lines.push(`PublicKey = ${secrets.get(peer.public_key_vault_key) ?? ""}`);
    lines.push(`PresharedKey = ${secrets.get(peer.preshared_key_vault_key) ?? ""}`);
    lines.push(`AllowedIPs = ${peer.allowed_ips.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}
