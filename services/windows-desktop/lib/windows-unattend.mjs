/**
 * @param {string} s
 */
function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const NS = 'xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
const COMP = 'processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"';

/** Drive letters probed for the VirtIO ISO (CD-ROM letters differ between WinPE and the installed OS). */
export const VIRTIO_DRIVE_LETTERS = ["D", "E", "F", "G"];

/**
 * PowerShell (single line) that installs an MSI found at the root-relative path on any drive.
 * @param {string} relPath e.g. guest-agent\qemu-ga-x86_64.msi
 */
function installMsiFromAnyDriveCommand(relPath) {
  return (
    "powershell -NoProfile -ExecutionPolicy Bypass -Command \"" +
    "Get-PSDrive -PSProvider FileSystem | ForEach-Object { " +
    "$p = Join-Path $_.Root '" + relPath + "'; " +
    "if (Test-Path $p) { Start-Process msiexec.exe -ArgumentList '/i',$p,'/qn','/norestart' -Wait } }\""
  );
}

/** First-logon commands shared by ISO install and clone OOBE. */
export function firstLogonCommands() {
  return [
    { description: "Install VirtIO guest tools", command: installMsiFromAnyDriveCommand("virtio-win-gt-x64.msi") },
    { description: "Install QEMU guest agent", command: installMsiFromAnyDriveCommand("guest-agent\\qemu-ga-x86_64.msi") },
    {
      description: "Enable Remote Desktop",
      command:
        "powershell -NoProfile -ExecutionPolicy Bypass -Command \"" +
        "Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -Value 0; " +
        "Enable-NetFirewallRule -DisplayGroup 'Remote Desktop'\"",
    },
    {
      description: "Mark LAN network private",
      command:
        "powershell -NoProfile -ExecutionPolicy Bypass -Command \"Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private\"",
    },
  ];
}

/**
 * @param {string} ipCidr
 */
function splitCidr(ipCidr) {
  const [ip, prefixStr] = ipCidr.split("/");
  return { ip, prefix: Number(prefixStr) || 24 };
}

/**
 * @param {object} opts
 * @param {string} opts.computerName
 * @param {string} opts.adminUsername
 * @param {string} opts.adminPassword
 * @param {string} opts.locale
 * @param {string} [opts.timeZone] defaults UTC
 * @param {{ ipCidr?: string; gateway?: string; dnsServers?: string[] }} [opts.network]
 * @returns {string}
 */
function buildSpecializeAndOobeXml(opts) {
  const { computerName, adminUsername, adminPassword, locale, timeZone = "UTC", network } = opts;

  /** @type {string[]} */
  const specialize = [
    `    <component name="Microsoft-Windows-Shell-Setup" ${COMP} ${NS}>
      <ComputerName>${xmlEscape(computerName)}</ComputerName>
      <TimeZone>${xmlEscape(timeZone)}</TimeZone>
    </component>`,
    `    <component name="Microsoft-Windows-TerminalServices-LocalSessionManager" ${COMP} ${NS}>
      <fDenyTSConnections>false</fDenyTSConnections>
    </component>`,
    `    <component name="Networking-MPSSVC-Svc" ${COMP} ${NS}>
      <FirewallGroups>
        <FirewallGroup wcm:action="add" wcm:keyValue="RemoteDesktop">
          <Active>true</Active>
          <Group>Remote Desktop</Group>
          <Profile>all</Profile>
        </FirewallGroup>
      </FirewallGroups>
    </component>`,
  ];

  if (network?.ipCidr && network.gateway) {
    const { ip, prefix } = splitCidr(network.ipCidr);
    const dns = (network.dnsServers ?? []).filter(Boolean);
    specialize.push(`    <component name="Microsoft-Windows-TCPIP" ${COMP} ${NS}>
      <Interfaces>
        <Interface wcm:action="add">
          <Ipv4Settings>
            <DhcpEnabled>false</DhcpEnabled>
          </Ipv4Settings>
          <Identifier>Ethernet</Identifier>
          <UnicastIpAddresses>
            <IpAddress wcm:action="add" wcm:keyValue="1">${xmlEscape(ip)}/${prefix}</IpAddress>
          </UnicastIpAddresses>
          <Routes>
            <Route wcm:action="add">
              <Identifier>0</Identifier>
              <Prefix>0.0.0.0/0</Prefix>
              <NextHopAddress>${xmlEscape(network.gateway)}</NextHopAddress>
            </Route>
          </Routes>
        </Interface>
      </Interfaces>
    </component>`);
    if (dns.length) {
      specialize.push(`    <component name="Microsoft-Windows-DNS-Client" ${COMP} ${NS}>
      <Interfaces>
        <Interface wcm:action="add">
          <Identifier>Ethernet</Identifier>
          <DNSServerSearchOrder>
${dns.map((d, i) => `            <IpAddress wcm:action="add" wcm:keyValue="${i + 1}">${xmlEscape(d)}</IpAddress>`).join("\n")}
          </DNSServerSearchOrder>
        </Interface>
      </Interfaces>
    </component>`);
    }
  }

  const builtinAdmin = adminUsername.trim().toLowerCase() === "administrator";
  const passwordXml = `<Value>${xmlEscape(adminPassword)}</Value>
            <PlainText>true</PlainText>`;
  const userAccounts = builtinAdmin
    ? `<UserAccounts>
        <AdministratorPassword>
            ${passwordXml}
        </AdministratorPassword>
      </UserAccounts>`
    : `<UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>${xmlEscape(adminUsername)}</Name>
            <Group>Administrators</Group>
            <Password>
            ${passwordXml}
            </Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>`;

  const commands = firstLogonCommands()
    .map(
      (c, i) => `        <SynchronousCommand wcm:action="add">
          <Order>${i + 1}</Order>
          <Description>${xmlEscape(c.description)}</Description>
          <CommandLine>${xmlEscape(c.command)}</CommandLine>
        </SynchronousCommand>`,
    )
    .join("\n");

  return `
  <settings pass="specialize">
${specialize.join("\n")}
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" ${COMP} ${NS}>
      <InputLocale>${xmlEscape(locale)}</InputLocale>
      <SystemLocale>${xmlEscape(locale)}</SystemLocale>
      <UILanguage>${xmlEscape(locale)}</UILanguage>
      <UserLocale>${xmlEscape(locale)}</UserLocale>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" ${COMP} ${NS}>
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      ${userAccounts}
      <AutoLogon>
        <Enabled>true</Enabled>
        <LogonCount>1</LogonCount>
        <Username>${xmlEscape(adminUsername)}</Username>
        <Password>
          <Value>${xmlEscape(adminPassword)}</Value>
          <PlainText>true</PlainText>
        </Password>
      </AutoLogon>
      <FirstLogonCommands>
${commands}
      </FirstLogonCommands>
    </component>
  </settings>`;
}

/**
 * @param {object} opts
 * @param {string} opts.computerName
 * @param {string} opts.adminUsername
 * @param {string} opts.adminPassword
 * @param {string} opts.locale
 * @param {string} [opts.timeZone] defaults UTC
 * @param {{ ipCidr?: string; gateway?: string; dnsServers?: string[] }} [opts.network]
 * @param {string} [opts.virtioDriverPath] Deprecated single WinPE driver path; all {@link VIRTIO_DRIVE_LETTERS} are probed.
 * @returns {string}
 */
export function renderAutounattendXml(opts) {
  const { computerName, adminUsername, adminPassword, locale, timeZone = "UTC", network } = opts;

  const tail = buildSpecializeAndOobeXml({
    computerName,
    adminUsername,
    adminPassword,
    locale,
    timeZone,
    network,
  });

  const driverDirs = ["vioscsi", "viostor", "NetKVM"];
  /** @type {string[]} */
  const driverPaths = [];
  let key = 1;
  for (const letter of VIRTIO_DRIVE_LETTERS) {
    for (const dir of driverDirs) {
      driverPaths.push(`        <PathAndCredentials wcm:action="add" wcm:keyValue="${key}">
          <Path>${letter}:\\${dir}\\w11\\amd64</Path>
        </PathAndCredentials>`);
      key += 1;
    }
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" ${NS}>
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" ${COMP} ${NS}>
      <SetupUILanguage>
        <UILanguage>${xmlEscape(locale)}</UILanguage>
      </SetupUILanguage>
      <InputLocale>${xmlEscape(locale)}</InputLocale>
      <SystemLocale>${xmlEscape(locale)}</SystemLocale>
      <UILanguage>${xmlEscape(locale)}</UILanguage>
      <UserLocale>${xmlEscape(locale)}</UserLocale>
    </component>
    <component name="Microsoft-Windows-PnpCustomizationsWinPE" ${COMP} ${NS}>
      <DriverPaths>
${driverPaths.join("\n")}
      </DriverPaths>
    </component>
    <component name="Microsoft-Windows-Setup" ${COMP} ${NS}>
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add">
              <Order>1</Order>
              <Type>EFI</Type>
              <Size>300</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>2</Order>
              <Type>MSR</Type>
              <Size>128</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>3</Order>
              <Type>Primary</Type>
              <Extend>true</Extend>
            </CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add">
              <Order>1</Order>
              <PartitionID>1</PartitionID>
              <Format>FAT32</Format>
              <Label>System</Label>
            </ModifyPartition>
            <ModifyPartition wcm:action="add">
              <Order>2</Order>
              <PartitionID>2</PartitionID>
            </ModifyPartition>
            <ModifyPartition wcm:action="add">
              <Order>3</Order>
              <PartitionID>3</PartitionID>
              <Format>NTFS</Format>
              <Label>Windows</Label>
              <Letter>C</Letter>
            </ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          <InstallTo>
            <DiskID>0</DiskID>
            <PartitionID>3</PartitionID>
          </InstallTo>
        </OSImage>
      </ImageInstall>
      <UserData>
        <AcceptEula>true</AcceptEula>
      </UserData>
    </component>
  </settings>${tail}
</unattend>
`;
}

/**
 * Specialize-only autounattend for clones from a sysprep template (no disk wipe / ImageInstall).
 * @param {object} opts
 * @param {string} opts.computerName
 * @param {string} opts.adminUsername
 * @param {string} opts.adminPassword
 * @param {string} opts.locale
 * @param {string} [opts.timeZone]
 * @param {{ ipCidr?: string; gateway?: string; dnsServers?: string[] }} [opts.network]
 */
export function renderAutounattendCloneXml(opts) {
  const tail = buildSpecializeAndOobeXml(opts);
  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" ${NS}>${tail}
</unattend>
`;
}

/**
 * @param {string} xml
 */
export function assertNoProductKeyInUnattend(xml) {
  if (/ProductKey/i.test(xml)) {
    throw new Error("autounattend.xml must not contain ProductKey (OEM activation)");
  }
}
