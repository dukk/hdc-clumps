#!/usr/bin/env node
/**
 * Query Ubuntu desktops (disk, upgradable package count).
 *
 * Usage: hdc run client ubuntu query -- [--host-id <id>] [--no-wol]
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runClientVerb } from "hdc/package/clients/client-run.mjs";

const clumpRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
await runClientVerb({ platform: "ubuntu", verb: "query", clumpRoot, argv: process.argv.slice(2) });
