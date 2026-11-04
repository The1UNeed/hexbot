# Runs the Windows sandbox tests as a new local standard user, against real
# AppContainers, ACLs, sockets and processes. Only disposable CI data is used.
param(
  [Parameter(Mandatory=$true)][string]$Probe,
  [Parameter(Mandatory=$true)][string]$Hexbot
)
$ErrorActionPreference = 'Stop'
$name = 'hexbot-sandbox'
$password = ConvertTo-SecureString ([Guid]::NewGuid().ToString() + 'aA1!') -AsPlainText -Force
$user = New-LocalUser -Name $name -Password $password -AccountNeverExpires
$root = Join-Path $env:SystemDrive ('hexbot-sandbox-' + [Guid]::NewGuid().ToString('N'))
try {
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
  New-Item -ItemType Directory -Path $root | Out-Null
  Copy-Item -LiteralPath $Probe -Destination (Join-Path $root 'sandbox-test.exe')
  Copy-Item -LiteralPath $Hexbot -Destination (Join-Path $root 'hexbot.exe')
  Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $root 'node.exe')
  New-Item -ItemType Directory -Path (Join-Path $root 'temp') | Out-Null
  @'
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Sandbox tests must run without an administrator token'
  }
  # Start-Process -Credential passes on the administrator's environment; the
  # profile folders come from this user's own token instead.
  $env:USERPROFILE = [Environment]::GetFolderPath('UserProfile')
  $env:HOME = $env:USERPROFILE
  $env:APPDATA = [Environment]::GetFolderPath('ApplicationData')
  $env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
  $env:TEMP = Join-Path $root 'temp'
  $env:TMP = $env:TEMP
  $env:HEXBOT_WINDOWS_HEXBOT = Join-Path $root 'hexbot.exe'
  $env:HEXBOT_WINDOWS_NODE = Join-Path $root 'node.exe'
  # One test at a time, and one stream for the tests and the commands they
  # contain, so a contained command's errors sit beside the test that ran it.
  # The root has no spaces, so cmd needs no quotes inside its command.
  $test = Join-Path $root 'sandbox-test.exe'
  & (Join-Path $env:SystemRoot 'System32\cmd.exe') /d /c "$test --test-threads=1 --nocapture 2>&1"
  $result = $LASTEXITCODE
  # Every test resets its home and the probe deletes its profile, so a Hexbot
  # profile still registered for this user is a leak.
  $mappings = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings'
  $left = @(Get-ChildItem -LiteralPath $mappings -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } |
    Where-Object { $_.DisplayName -eq 'Hexbot sandbox' -or $_.Moniker -like 'hexbot.sandbox.*' })
  if ($left.Count -gt 0) {
    Write-Error ('Leaked sandbox profiles: ' + (($left | ForEach-Object { $_.Moniker }) -join ', ')) -ErrorAction Continue
    $result = 1
  }
} catch {
  Write-Error $_ -ErrorAction Continue
  $result = 1
}
Set-Content -LiteralPath (Join-Path $root 'exit-code') -Value $result
exit $result
'@ | Set-Content -LiteralPath (Join-Path $root 'run.ps1')
  & icacls.exe $root /grant "*$($user.SID.Value):(OI)(CI)M" /T /Q
  if ($LASTEXITCODE -ne 0) { throw 'Cannot grant the test directory' }
  $credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $password)
  $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $process = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'run.ps1')) -Credential $credential -LoadUserProfile -WorkingDirectory $root -PassThru -RedirectStandardOutput (Join-Path $root 'stdout') -RedirectStandardError (Join-Path $root 'stderr')
  if (-not $process.WaitForExit(600000)) {
    & (Join-Path $env:SystemRoot 'System32/taskkill.exe') /PID $process.Id /T /F
    throw 'Sandbox tests timed out'
  }
  Get-Content -LiteralPath (Join-Path $root 'stdout')
  Get-Content -LiteralPath (Join-Path $root 'stderr')
  if (-not (Test-Path (Join-Path $root 'exit-code'))) { throw 'Sandbox tests did not finish' }
  if ([int](Get-Content (Join-Path $root 'exit-code')) -ne 0) { throw 'Sandbox tests failed' }
} finally {
  Remove-LocalUser -Name $name
  if (Test-Path $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
