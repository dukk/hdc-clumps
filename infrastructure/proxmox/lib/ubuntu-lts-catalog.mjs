/**
 * Ubuntu LTS releases hdc maintain keeps on Proxmox (container vztmpl + QEMU cloud templates).
 * Excludes interim releases and LTS versions past their security maintenance window.
 */

/** @typedef {object} UbuntuLtsRelease
 * @property {string} release e.g. "22.04"
 * @property {string} lxcAppliance Proxmox appliance catalog filename (pveam)
 * @property {string} cloudImageUrl Ubuntu cloud image for QEMU template build
 * @property {string} cloudImageFilename
 * @property {number} qemuTemplateVmid hdc-managed template vmid (90xx)
 * @property {string} qemuTemplateName
 */

/** @type {UbuntuLtsRelease[]} */
export const UBUNTU_LTS_RELEASES = [
  {
    release: "22.04",
    lxcAppliance: "ubuntu-22.04-standard_22.04-1_amd64.tar.zst",
    cloudImageUrl:
      "https://cloud-images.ubuntu.com/releases/22.04/release/ubuntu-22.04-server-cloudimg-amd64.img",
    cloudImageFilename: "ubuntu-22.04-server-cloudimg-amd64.img",
    qemuTemplateVmid: 9022,
    qemuTemplateName: "tpl-ubuntu-2204",
  },
  {
    release: "24.04",
    lxcAppliance: "ubuntu-24.04-standard_24.04-2_amd64.tar.zst",
    cloudImageUrl:
      "https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img",
    cloudImageFilename: "ubuntu-24.04-server-cloudimg-amd64.img",
    qemuTemplateVmid: 9024,
    qemuTemplateName: "tpl-ubuntu-2404",
  },
  {
    release: "26.04",
    lxcAppliance: "ubuntu-26.04-standard_26.04-1_amd64.tar.zst",
    cloudImageUrl:
      "https://cloud-images.ubuntu.com/releases/26.04/release/ubuntu-26.04-server-cloudimg-amd64.img",
    cloudImageFilename: "ubuntu-26.04-server-cloudimg-amd64.img",
    qemuTemplateVmid: 9026,
    qemuTemplateName: "tpl-ubuntu-2604",
  },
];

/** vmid range reserved for hdc-built Ubuntu LTS QEMU templates */
export const HDC_UBUNTU_QEMU_VMID_MIN = 9020;
export const HDC_UBUNTU_QEMU_VMID_MAX = 9039;

export const DEFAULT_UBUNTU_LTS_RELEASE = "22.04";

/**
 * @param {string} release
 * @returns {UbuntuLtsRelease | null}
 */
export function ubuntuLtsByRelease(release) {
  const r = String(release ?? "").trim();
  return UBUNTU_LTS_RELEASES.find((e) => e.release === r) ?? null;
}

/**
 * @param {number} vmid
 * @returns {UbuntuLtsRelease | null}
 */
export function ubuntuLtsByQemuVmid(vmid) {
  return UBUNTU_LTS_RELEASES.find((e) => e.qemuTemplateVmid === vmid) ?? null;
}

/**
 * @param {string} storage
 * @param {string} appliance
 */
export function lxcVolidForAppliance(storage, appliance) {
  return `${storage}:vztmpl/${appliance}`;
}

/**
 * @param {string} volid
 */
export function isUbuntuVztmplVolid(volid) {
  return /:vztmpl\/ubuntu-/i.test(String(volid ?? ""));
}

/**
 * @param {string} applianceFilename
 */
export function isAllowedUbuntuLxcAppliance(applianceFilename) {
  const allowed = new Set(UBUNTU_LTS_RELEASES.map((e) => e.lxcAppliance));
  return allowed.has(applianceFilename);
}

/**
 * @param {string} name
 */
export function hdcUbuntuQemuTemplateName(name) {
  return /^tpl-ubuntu-\d{4}$/.test(String(name ?? "").trim());
}

/**
 * @param {number} vmid
 */
export function isHdcUbuntuQemuVmidRange(vmid) {
  return vmid >= HDC_UBUNTU_QEMU_VMID_MIN && vmid <= HDC_UBUNTU_QEMU_VMID_MAX;
}

/**
 * @returns {Set<number>}
 */
export function allowedUbuntuQemuTemplateVmids() {
  return new Set(UBUNTU_LTS_RELEASES.map((e) => e.qemuTemplateVmid));
}
