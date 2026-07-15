import { describe, expect, it } from "vitest";

import {
  buildPagesDeployArgv,
  buildWorkerDeployArgv,
  buildWorkerDeleteArgv,
} from "./workers-wrangler.mjs";

describe("workers-wrangler", () => {
  it("buildWorkerDeployArgv with env and dry-run", () => {
    const args = buildWorkerDeployArgv(
      {
        id: "w",
        managed: true,
        project_dir: "workers/w",
        script_name: "w",
        wrangler_env: "staging",
        npm_install: true,
        routes: [],
        secrets: [],
      },
      { dryRun: true }
    );
    expect(args).toEqual(["deploy", "--dry-run", "--env", "staging"]);
  });

  it("buildPagesDeployArgv includes project and branch", () => {
    const args = buildPagesDeployArgv({
      id: "p",
      managed: true,
      project_dir: "pages/p",
      project_name: "my-site",
      deploy_dir: "dist",
      build_command: null,
      production_branch: "main",
      npm_install: true,
      create_project: true,
    });
    expect(args).toEqual([
      "pages",
      "deploy",
      "dist",
      "--project-name",
      "my-site",
      "--branch",
      "main",
    ]);
  });

  it("buildWorkerDeleteArgv", () => {
    expect(buildWorkerDeleteArgv("script-a")).toEqual(["delete", "script-a", "--force"]);
  });
});
