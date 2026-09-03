export interface ServiceFileOptions { executable: string; home: string; path: string; logDir: string }

const xml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

export function launchdPlist(options: ServiceFileOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.hexbot.daemon</string>
  <key>ProgramArguments</key><array><string>${xml(options.executable)}</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict><key>HEXBOT_HOME</key><string>${xml(options.home)}</string><key>PATH</key><string>${xml(options.path)}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(options.logDir)}/service.log</string>
  <key>StandardErrorPath</key><string>${xml(options.logDir)}/service-error.log</string>
</dict></plist>
`
}

export function systemdUnit(options: ServiceFileOptions): string {
  const quote = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  return `[Unit]\nDescription=Hexbot daemon\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${quote(options.executable)} serve\nEnvironment=HEXBOT_HOME=${quote(options.home)}\nEnvironment=PATH=${quote(options.path)}\nRestart=always\nStandardOutput=append:${options.logDir}/service.log\nStandardError=append:${options.logDir}/service-error.log\n\n[Install]\nWantedBy=default.target\n`
}
