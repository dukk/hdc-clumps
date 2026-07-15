import { describe, expect, it } from "vitest";

import { buildMaintainScript } from "./paperclip-install.mjs";

const composeYaml = "services:\n  db:\n    image: postgres:17-alpine\n";
const envContent = "POSTGRES_PASSWORD=secret\n";

describe("paperclip-install buildMaintainScript", () => {
  it("does not run docker compose down -v by default", () => {
    const script = buildMaintainScript("/opt/paperclip", composeYaml, envContent);
    expect(script).not.toContain("docker compose down -v");
    expect(script).toContain("docker compose pull");
    expect(script).toContain("docker compose up -d");
  });

  it("runs docker compose down -v only when resetVolumes is true", () => {
    const script = buildMaintainScript("/opt/paperclip", composeYaml, envContent, {
      resetVolumes: true,
    });
    expect(script).toContain("docker compose down -v || true");
  });

  it("skips pull when skipUpgrade is set", () => {
    const script = buildMaintainScript("/opt/paperclip", composeYaml, envContent, {
      skipUpgrade: true,
    });
    expect(script).not.toContain("docker compose pull");
    expect(script).toContain("docker compose up -d");
  });
});
