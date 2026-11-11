param(
  [Parameter(Mandatory=$true)][string]$Runtime,
  [string]$Probe,
  # The daemon, which the native probe runs as the sandbox helper.
  [string]$Hexbot,
  # The pinned BusyBox (scripts/desktop/stage-busybox.mjs), which the probes
  # find beside the daemon as the runtime has it.
  [string]$Busybox
)
$ErrorActionPreference = 'Stop'
$name = 'hexbot-security'
$password = ConvertTo-SecureString ([Guid]::NewGuid().ToString() + 'aA1!') -AsPlainText -Force
$user = New-LocalUser -Name $name -Password $password -AccountNeverExpires
$root = Join-Path $env:SystemDrive ('hexbot-security-' + [Guid]::NewGuid().ToString('N'))
try {
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
  New-Item -ItemType Directory -Path $root | Out-Null
  Copy-Item -LiteralPath $Runtime -Destination (Join-Path $root 'runtime') -Recurse
  Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $root 'node.exe')
  if ($Busybox) { Copy-Item -LiteralPath $Busybox -Destination (Join-Path $root 'busybox-staged.exe') }
  if ($Probe) {
    # The probe names a trusted Python in the bot's config; Auto and Manual
    # must refuse execute_code before it starts.
    (Get-Command python.exe).Source | Set-Content -LiteralPath (Join-Path $root 'python-path')
    if (-not $Hexbot) { throw 'The native probe needs the daemon as its sandbox helper' }
    Copy-Item -LiteralPath $Probe -Destination (Join-Path $root 'native-test.exe')
    Copy-Item -LiteralPath $Hexbot -Destination (Join-Path $root 'hexbot.exe')
  }
  New-Item -ItemType Directory -Path (Join-Path $root 'temp') | Out-Null
  @'
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Security tests must run without an administrator token'
  }
  # Start-Process -Credential passes on the administrator's environment; the
  # profile folders come from this user's own token instead, as the sandbox
  # and the Git settings it reads expect.
  $env:USERPROFILE = [Environment]::GetFolderPath('UserProfile')
  $env:HOME = $env:USERPROFILE
  $env:APPDATA = [Environment]::GetFolderPath('ApplicationData')
  $env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
  $env:TEMP = Join-Path $root 'temp'
  $env:TMP = $env:TEMP
  $env:HEXBOT_WINDOWS_NODE = Join-Path $root 'node.exe'
  # The runtime's shell beside the daemon, copied by this user so that it
  # owns it, as it owns an installed runtime: the sandbox changes its DACL.
  $staged = Join-Path $root 'busybox-staged.exe'
  if (Test-Path -LiteralPath $staged) {
    New-Item -ItemType Directory -Path (Join-Path $root 'bin') | Out-Null
    Copy-Item -LiteralPath $staged -Destination (Join-Path $root 'bin\busybox.exe')
    $env:HEXBOT_WINDOWS_BUSYBOX = Join-Path $root 'bin\busybox.exe'
  }
  & $env:HEXBOT_WINDOWS_NODE --test (Join-Path $root 'runtime/windows-security.test.mjs') (Join-Path $root 'runtime/windows-daemon-pi.test.mjs')
  $result = $LASTEXITCODE
  if (Test-Path (Join-Path $root 'native-test.exe')) {
    $env:HEXBOT_WINDOWS_PYTHON = (Get-Content (Join-Path $root 'python-path')).Trim()
    $env:HEXBOT_WINDOWS_HEXBOT = Join-Path $root 'hexbot.exe'
    & (Join-Path $root 'native-test.exe') --test-threads=1 --nocapture
    if ($LASTEXITCODE -ne 0) { $result = $LASTEXITCODE }
    # Every probe resets its home, so a Hexbot sandbox profile still
    # registered for this user is a leak.
    $mappings = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings'
    $left = @(Get-ChildItem -LiteralPath $mappings -ErrorAction SilentlyContinue |
      ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } |
      Where-Object { $_.DisplayName -eq 'Hexbot sandbox' -or $_.Moniker -like 'hexbot.sandbox.*' })
    if ($left.Count -gt 0) {
      Write-Error ('Leaked sandbox profiles: ' + (($left | ForEach-Object { $_.Moniker }) -join ', ')) -ErrorAction Continue
      $result = 1
    }
  }
} catch {
  Write-Error $_ -ErrorAction Continue
  $result = 1
}
Set-Content -LiteralPath (Join-Path $root 'exit-code') -Value $result
exit $result
'@ | Set-Content -LiteralPath (Join-Path $root 'run.ps1')
  # ACL setup is limited to disposable CI data, never a real user home.
  & icacls.exe $root /grant "*$($user.SID.Value):(OI)(CI)M" /T /Q
  if ($LASTEXITCODE -ne 0) { throw 'Cannot grant the test directory' }
  $credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $password)
  $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $process = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'run.ps1')) -Credential $credential -LoadUserProfile -WorkingDirectory $root -PassThru -RedirectStandardOutput (Join-Path $root 'stdout') -RedirectStandardError (Join-Path $root 'stderr')
  if (-not $process.WaitForExit(600000)) {
    & (Join-Path $env:SystemRoot 'System32/taskkill.exe') /PID $process.Id /T /F
    throw 'Standard-user probes timed out'
  }
  Get-Content -LiteralPath (Join-Path $root 'stdout')
  Get-Content -LiteralPath (Join-Path $root 'stderr')
  if (-not (Test-Path (Join-Path $root 'exit-code'))) { throw 'Standard-user probes did not finish' }
  if ([int](Get-Content (Join-Path $root 'exit-code')) -ne 0) { throw 'Standard-user probes failed' }
} finally {
  Remove-LocalUser -Name $name
  if (Test-Path $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
