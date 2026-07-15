#!/usr/bin/env node
/**
 * Query Windows home clients (disk, pending updates).
 *
 * Usage: hdc run client windows query -- [--host-id <id>] [--no-wol]
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runClientVerb } from "hdc/package/clients/client-run.mjs";

const clumpRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
await runClientVerb({ platform: "windows", verb: "query", clumpRoot, argv: process.argv.slice(2) });
