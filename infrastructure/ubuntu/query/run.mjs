import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = basename(dirname(here));

const payload = {
  target,
  verb: "query",
  ok: true,
  stub: true,
  message: "Replace with live checks (HTTP API, SSH, etc.).",
  generated_at: new Date().toISOString(),
};
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
