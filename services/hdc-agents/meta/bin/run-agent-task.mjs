#!/usr/bin/env node
/**
 * Dispatch an approved task via hdc-manager internal API.
 *
 * Usage: run-agent-task.mjs <task-id> [job-id]
 */
const taskId = process.argv[2];
const jobId = process.argv[3] ?? "";

async function main() {
  if (!taskId) {
    process.stderr.write("usage: run-agent-task.mjs <task-id> [job-id]\n");
    process.exit(1);
  }
  const token = String(process.env.HDC_WEB_API_TOKEN ?? "").trim();
  if (!token) {
    process.stderr.write("run-agent-task: HDC_WEB_API_TOKEN unset\n");
    process.exit(1);
  }
  const base =
    String(process.env.HDC_MANAGER_A2A_URL ?? process.env.HDC_MANAGER_INTERNAL_URL ?? "http://hdc-manager:9200").trim() ||
    "http://hdc-manager:9200";
  const url = `${base.replace(/\/$/, "")}/internal/dispatch-task`;
  process.stderr.write(`run-agent-task: dispatch ${taskId}${jobId ? ` job=${jobId}` : ""}\n`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ task_id: taskId }),
  });
  const text = await res.text();
  process.stdout.write(`${text}\n`);
  if (!res.ok) {
    process.stderr.write(`run-agent-task: manager returned ${res.status}\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`run-agent-task: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
