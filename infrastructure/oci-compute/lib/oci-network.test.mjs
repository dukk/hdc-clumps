import { describe, expect, it } from "vitest";

import { normalizeOciComputeConfig } from "./oci-config.mjs";
import {
  buildSecurityListTcpIngressRule,
  collectTcpIngressRulesForSecurityListSync,
  securityListTcpRuleKey,
} from "./oci-network.mjs";

describe("oci-network security list sync", () => {
  const sample = {
    schema_version: 1,
    oci: {
      region: "us-ashburn-1",
      compartment_id: "ocid1.compartment.oc1..test",
    },
    vcns: [{ id: "hdc-vcn", managed: true, cidr: "10.8.0.0/16", dns_label: "hdcvcn" }],
    subnets: [
      {
        id: "subnet-public-a",
        managed: true,
        vcn_id: "hdc-vcn",
        cidr: "10.8.1.0/24",
        public: true,
      },
    ],
    network_security_groups: [
      {
        id: "nsg-uptime-kuma",
        managed: true,
        vcn_id: "hdc-vcn",
        ingress: [
          { protocol: "tcp", port_min: 22, port_max: 22, source: "0.0.0.0/0" },
          { protocol: "tcp", port_min: 3001, port_max: 3001, source: "99.129.209.232/29" },
        ],
      },
    ],
    instances: [],
    container_instances: [],
  };

  it("collects per-port source CIDRs from managed NSG ingress", () => {
    const cfg = normalizeOciComputeConfig(sample);
    const rules = collectTcpIngressRulesForSecurityListSync(cfg, "hdc-vcn");
    expect(rules).toEqual([
      { port: 22, source: "0.0.0.0/0" },
      { port: 3001, source: "99.129.209.232/29" },
    ]);
  });

  it("builds security list rules with matching source CIDR", () => {
    const open = buildSecurityListTcpIngressRule(22, "0.0.0.0/0");
    const restricted = buildSecurityListTcpIngressRule(3001, "99.129.209.232/29");
    expect(securityListTcpRuleKey(open)).toBe("6|0.0.0.0/0|22|22");
    expect(securityListTcpRuleKey(restricted)).toBe("6|99.129.209.232/29|3001|3001");
  });
});
