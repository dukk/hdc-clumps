#!/usr/bin/env node
/**
 * Maintain Windows home clients (disk, updates via WinRM).
 *
 * Usage: hdc run client windows maintain -- [--host-id <id>] [--dry-run] [--skip-updates] [--reboot] [--no-wol]
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runClientVerb } from "hdc/package/clients/client-run.mjs";

const clumpRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
await runClientVerb({ platform: "windows", verb: "maintain", clumpRoot, argv: process.argv.slice(2) });
