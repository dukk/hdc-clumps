import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { normalizePrivateKeyPem, signOciRequest } from "./oci-request-sign.mjs";

describe("oci-request-sign", () => {
  it("reformats single-line PEM blocks for OpenSSL", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const singleLine = pem.replace(/\n/g, "");
    const normalized = normalizePrivateKeyPem(singleLine);
    expect(normalized).toContain("-----BEGIN PRIVATE KEY-----\n");
    expect(normalized).toContain("\n-----END PRIVATE KEY-----");
    const headers = signOciRequest(
      {
        tenancyOcid: "ocid1.tenancy.oc1..aaa",
        userOcid: "ocid1.user.oc1..bbb",
        fingerprint: "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99",
        privateKeyPem: normalized,
      },
      {
        method: "GET",
        host: "iaas.us-ashburn-1.oraclecloud.com",
        path: "/20160918/vcns",
        now: new Date("2026-06-26T12:00:00.000Z"),
      },
    );
    expect(headers.authorization).toMatch(/^Signature version="1"/);
  });

  it("strips trailing garbage after PEM block", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const normalized = normalizePrivateKeyPem(`${pem}\nOCI_API_KEY`);
    expect(normalized).toBe(pem.trim());
    expect(normalized).not.toContain("OCI_API_KEY");
  });

  it("normalizes bare private key material into PEM", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const bare = pem.replace(/-----[^-]+-----|\s+/g, "");
    const normalized = normalizePrivateKeyPem(bare);
    expect(normalized).toContain("BEGIN PRIVATE KEY");
  });

  it("signs GET requests with authorization header", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const creds = {
      tenancyOcid: "ocid1.tenancy.oc1..aaa",
      userOcid: "ocid1.user.oc1..bbb",
      fingerprint: "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99",
      privateKeyPem,
    };
    const now = new Date("2026-06-26T12:00:00.000Z");
    const headers = signOciRequest(creds, {
      method: "GET",
      host: "iaas.us-ashburn-1.oraclecloud.com",
      path: "/20160918/vcns",
      now,
    });
    expect(headers.authorization).toMatch(/^Signature version="1"/);
    expect(headers.date).toBe(now.toUTCString());

    const auth = headers.authorization;
    const sigMatch = auth.match(/signature="([^"]+)"/);
    expect(sigMatch).toBeTruthy();
    const signature = Buffer.from(sigMatch[1], "base64");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(
      `(request-target): get /20160918/vcns\nhost: iaas.us-ashburn-1.oraclecloud.com\ndate: ${now.toUTCString()}`,
    );
    verifier.end();
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifier.verify(publicKeyPem, signature)).toBe(true);
  });
});
