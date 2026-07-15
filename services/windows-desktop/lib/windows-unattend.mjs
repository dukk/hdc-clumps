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

/**
 * @param {object} opts
 * @param {string} opts.computerName
 * @param {string} opts.adminUsername
 * @param {string} opts.adminPassword
 * @param {string} opts.locale
 * @param {string} [opts.timeZone] defaults UTC
 * @param {{ ipCidr?: string; gateway?: string; dnsServers?: string[] }} [opts.network]
 * @param {string} [opts.virtioDriverPath] WinPE driver path on virtio ISO (e.g. E:\vioscsi\w11\amd64)
 * @returns {string}
 */
function buildSpecializeAndOobeXml(opts) {
  const {
    computerName,
    adminUsername,
    adminPassword,
    locale,
    timeZone = "UTC",
    network,
  } = opts;

  /** @type {string[]} */
  const specializeParts = [
    `<ComputerName>${xmlEscape(computerName)}</ComputerName>`,
    `<TimeZone>${xmlEscape(timeZone)}</TimeZone>`,
  ];

  if (network?.ipCidr && network.gateway) {
    const [ip, prefixStr] = network.ipCidr.split("/");
    const prefix = Number(prefixStr) || 24;
    const maskBits = (0xffffffff << (32 - prefix)) >>> 0;
    const mask = [
      (maskBits >>> 24) & 255,
      (maskBits >>> 16) & 255,
      (maskBits >>> 8) & 255,
      maskBits & 255,
    ].join(".");
    const dns = (network.dnsServers ?? []).filter(Boolean);
    const dnsXml = dns.length
      ? `<DNSDomain>${xmlEscape(dns[0])}</DNSDomain><DNSServerSearchOrder>${dns.map((d) => `<IpAddress>${xmlEscape(d)}</IpAddress>`).join("")}</DNSServerSearchOrder>`
      : "";
    specializeParts.push(`
    <component name="Microsoft-Windows-TCPIP" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <Interfaces>
        <Interface wcm:action="add">
          <Ipv4Settings>
            <Metadata>
              <Item wcm:action="add">
                <Key>IsDhcpEnabled</Key>
                <Value>false</Value>
              </Item>
            </Metadata>
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
    </component>
    <component name="Microsoft-Windows-DNS-Client" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
      ${dnsXml}
    </component>`);
    void mask;
  }

  const localAccount = `
    <LocalAccounts>
      <LocalAccount wcm:action="add">
        <Name>${xmlEscape(adminUsername)}</Name>
        <Group>Administrators</Group>
        <Password>
          <Value>${xmlEscape(adminPassword)}</Value>
          <PlainText>true</PlainText>
        </Password>
      </LocalAccount>
    </LocalAccounts>`;

  return `
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      ${specializeParts.join("\n      ")}
      ${localAccount}
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <AutoLogon>
        <Enabled>true</Enabled>
        <Username>${xmlEscape(adminUsername)}</Username>
        <Password>
          <Value>${xmlEscape(adminPassword)}</Value>
          <PlainText>true</PlainText>
        </Password>
      </AutoLogon>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add">
          <Order>1</Order>
          <Description>Install VirtIO guest tools</Description>
          <CommandLine>powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path E:\\virtio-win-gt-x64.msi) { Start-Process msiexec.exe -ArgumentList '/i','E:\\virtio-win-gt-x64.msi','/qn','/norestart' -Wait }"</CommandLine>
        </SynchronousCommand>
        <SynchronousCommand wcm:action="add">
          <Order>2</Order>
          <Description>Install QEMU guest agent</Description>
          <CommandLine>powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path E:\\guest-agent\\qemu-ga-x86_64.msi) { Start-Process msiexec.exe -ArgumentList '/i','E:\\guest-agent\\qemu-ga-x86_64.msi','/qn','/norestart' -Wait }"</CommandLine>
        </SynchronousCommand>
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
 * @param {string} [opts.virtioDriverPath] WinPE driver path on virtio ISO (e.g. E:\vioscsi\w11\amd64)
 * @returns {string}
 */
export function renderAutounattendXml(opts) {
  const {
    computerName,
    adminUsername,
    adminPassword,
    locale,
    timeZone = "UTC",
    network,
    virtioDriverPath = "E:\\vioscsi\\w11\\amd64",
  } = opts;

  const tail = buildSpecializeAndOobeXml({
    computerName,
    adminUsername,
    adminPassword,
    locale,
    timeZone,
    network,
  });

  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <SetupUILanguage>
        <UILanguage>${xmlEscape(locale)}</UILanguage>
      </SetupUILanguage>
      <InputLocale>${xmlEscape(locale)}</InputLocale>
      <SystemLocale>${xmlEscape(locale)}</SystemLocale>
      <UILanguage>${xmlEscape(locale)}</UILanguage>
      <UserLocale>${xmlEscape(locale)}</UserLocale>
    </component>
    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
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
      <DriverPaths>
        <PathAndCredentials wcm:action="add" wcm:keyValue="1">
          <Path>${xmlEscape(virtioDriverPath)}</Path>
        </PathAndCredentials>
      </DriverPaths>
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
<unattend xmlns="urn:schemas-microsoft-com:unattend">${tail}
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
