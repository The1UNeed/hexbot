// HEXBOT_SUPERVISOR=service tells the daemon it runs under launchd or systemd
// and may install a verified native update when a client asks.
export interface ServiceFileOptions {
  executable: string
  home: string
  path: string
  logDir: string
}

const xml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

export function launchdPlist(options: ServiceFileOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.hexbot.daemon</string>
  <key>ProgramArguments</key><array><string>${xml(options.executable)}</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict><key>HEXBOT_HOME</key><string>${xml(options.home)}</string><key>HEXBOT_SUPERVISOR</key><string>service</string><key>PATH</key><string>${xml(options.path)}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(options.logDir)}/service.log</string>
  <key>StandardErrorPath</key><string>${xml(options.logDir)}/service-error.log</string>
</dict></plist>
`
}

const rejectServiceText = (value: string): void => {
  if (value.includes('"') || value.includes('\r') || value.includes('\n'))
    throw new Error('The Windows service path contains a quote or newline.')
}

/** Bytes the installer and daemon recognize. Line endings are LF. */
export function windowsServiceScript(options: Pick<ServiceFileOptions, 'home' | 'path' | 'executable'>): string {
  rejectServiceText(options.home)
  rejectServiceText(options.path)
  rejectServiceText(options.executable)
  return `@echo off\nrem HEXBOT_SERVICE_SCRIPT\nset "HEXBOT_HOME=${options.home}"\nset "HEXBOT_SUPERVISOR=service"\nset "PATH=${options.path}"\n"${options.executable}" serve\n`
}

export function windowsTaskXml(command: string): string {
  rejectServiceText(command)
  const escaped = command.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Hexbot daemon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escaped}</Command>
    </Exec>
  </Actions>
</Task>
`
}

export function windowsTaskXmlBytes(command: string): Buffer {
  const xml = windowsTaskXml(command)
  const bytes = Buffer.alloc(2 + xml.length * 2)
  bytes.writeUInt16LE(0xfeff, 0)
  for (let i = 0; i < xml.length; i++) bytes.writeUInt16LE(xml.charCodeAt(i), 2 + i * 2)
  return bytes
}

export function systemdUnit(options: ServiceFileOptions): string {
  const quote = (value: string): string =>
    `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  return `[Unit]\nDescription=Hexbot daemon\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${quote(options.executable)} serve\nEnvironment=HEXBOT_HOME=${quote(options.home)}\nEnvironment=HEXBOT_SUPERVISOR=service\nEnvironment=PATH=${quote(options.path)}\nRestart=always\nStandardOutput=append:${options.logDir.replaceAll('%', '%%')}/service.log\nStandardError=append:${options.logDir.replaceAll('%', '%%')}/service-error.log\n\n[Install]\nWantedBy=default.target\n`
}
