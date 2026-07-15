import { composeDir } from "./twenty-render.mjs";

/**
 * When ENCRYPTION_KEY changes, JWT signing keys in Postgres cannot be decrypted.
 * Purge stale rows so Twenty mints a fresh keypair on next login (CRM data untouched).
 * Skipped when FALLBACK_ENCRYPTION_KEY is set (intentional rotation in progress).
 *
 * @param {string} composeDirPath
 * @param {string} encryptionKeyId Eight-char fingerprint from twentyEncryptionKeyId().
 * @returns {string[]}
 */
export function buildEncryptionKeyGuardLines(composeDirPath, encryptionKeyId) {
  const dir = composeDirPath.replace(/'/g, `'\\''`);
  const meta = `${dir}/.hdc`.replace(/'/g, `'\\''`);
  const id = encryptionKeyId.replace(/'/g, `'\\''`);
  return [
    `mkdir -p '${meta}'`,
    `CURRENT_ID='${id}'`,
    `STORED_ID="$(cat '${meta}/encryption-key-id' 2>/dev/null || true)"`,
    'FALLBACK="$(grep -E "^FALLBACK_ENCRYPTION_KEY=" .env | head -1 | cut -d= -f2- | tr -d \'\\r"\' || true)"',
    'if [ -n "$STORED_ID" ] && [ "$CURRENT_ID" != "$STORED_ID" ] && [ -z "$FALLBACK" ]; then',
    '  echo "twenty: ENCRYPTION_KEY fingerprint changed — purging stale JWT signing keys"',
    '  docker compose exec -T db psql -U postgres -d default -v ON_ERROR_STOP=1 -c \'DELETE FROM core."signingKey";\'',
    "fi",
    `echo "$CURRENT_ID" > '${meta}/encryption-key-id'`,
  ];
}

/**
 * Safety net: if server logs still show JWT signing failures, purge and restart.
 * @returns {string[]}
 */
export function buildSigningKeyLogHealLines() {
  return [
    'if docker compose logs server --tail 150 2>&1 | grep -q "No active signing key available to sign asymmetric token"; then',
    '  echo "twenty: JWT signing unhealthy — purging signing keys and restarting server"',
    '  docker compose exec -T db psql -U postgres -d default -v ON_ERROR_STOP=1 -c \'DELETE FROM core."signingKey";\'',
    "  docker compose restart server worker",
    "  for i in $(seq 1 30); do",
    '    curl -sf --max-time 5 "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null 2>&1 && break',
    "    sleep 5",
    "  done",
    "fi",
  ];
}

/**
 * @param {Record<string, unknown>} install
 */
export function hdcMetadataFile(install) {
  return `${composeDir(install)}/.hdc/encryption-key-id`;
}
