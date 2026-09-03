import { describe, expect, it } from 'vitest'
import { launchdPlist, systemdUnit } from './service-files'

const options = { executable: '/home/me/.hexbot/runtime/venv/bin/hexbot', home: '/home/me/.hexbot', path: '/home/me/.hexbot/bin:/usr/bin', logDir: '/home/me/.hexbot/logs' }
describe('service files', () => {
  it('renders launchd configuration', () => { expect(launchdPlist(options)).toMatchInlineSnapshot(`
"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.hexbot.daemon</string>
  <key>ProgramArguments</key><array><string>/home/me/.hexbot/runtime/venv/bin/hexbot</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict><key>HEXBOT_HOME</key><string>/home/me/.hexbot</string><key>PATH</key><string>/home/me/.hexbot/bin:/usr/bin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/home/me/.hexbot/logs/service.log</string>
  <key>StandardErrorPath</key><string>/home/me/.hexbot/logs/service-error.log</string>
</dict></plist>
"
`) })
  it('renders systemd configuration', () => { expect(systemdUnit(options)).toMatchInlineSnapshot(`
"[Unit]
Description=Hexbot daemon
After=network.target

[Service]
Type=simple
ExecStart="/home/me/.hexbot/runtime/venv/bin/hexbot" serve
Environment=HEXBOT_HOME="/home/me/.hexbot"
Environment=PATH="/home/me/.hexbot/bin:/usr/bin"
Restart=always
StandardOutput=append:/home/me/.hexbot/logs/service.log
StandardError=append:/home/me/.hexbot/logs/service-error.log

[Install]
WantedBy=default.target
"
`) })
})
