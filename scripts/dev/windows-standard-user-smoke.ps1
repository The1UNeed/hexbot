# Run the real packaged lifecycle in a disposable Windows VM as a Users-only
# account. The administrator provisions the fixture; every tested action runs
# in the new account, including Task Scheduler registration and activation.
[CmdletBinding()]
param(
    [string]$Packages = 'windows-packages',
    [string]$Artifacts = $env:HEXBOT_SMOKE_ARTIFACTS,
    [ValidateRange(60, 3600)][int]$TimeoutSeconds = 900,
    [switch]$AllowLocalVm,
    [string]$ChildConfig
)

$ErrorActionPreference = 'Stop'

function Write-JsonFile($Path, $Value) {
    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding utf8
}

if ($ChildConfig) {
    $config = Get-Content -LiteralPath $ChildConfig -Raw | ConvertFrom-Json
    $childResult = @{ passed = $false; startedAt = [DateTime]::UtcNow.ToString('o') }
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $groups = @($identity.Groups | ForEach-Object Value)
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        $token = @{
            name = $identity.Name; sid = $identity.User.Value; groups = $groups
            administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
            interactive = $groups -contains 'S-1-5-4'
            sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
        }
        Write-JsonFile (Join-Path $config.artifacts 'standard-user-token.json') $token
        if ($token.sid -ne $config.sid -or $token.administrator -or $groups -contains 'S-1-5-32-544' -or $groups -notcontains 'S-1-5-32-545') {
            throw 'The lifecycle must run as the fresh Users-only account, with no Administrators SID in its token.'
        }
        if (-not $token.interactive) {
            throw 'The standard-user logon lacks an interactive token required by the per-user daemon task.'
        }
        & "$env:SystemRoot/System32/whoami.exe" /all | Set-Content (Join-Path $config.artifacts 'whoami.txt')
        try { & "$env:SystemRoot/System32/qwinsta.exe" 2>&1 | Out-File (Join-Path $config.artifacts 'logon-sessions.txt') }
        catch { $_ | Out-String | Out-File (Join-Path $config.artifacts 'logon-sessions.txt') }
        # CreateProcessWithLogon loads HKCU, but its inherited environment can
        # still name the runner's profile. Resolve this account's known folders.
        $env:USERPROFILE = [Environment]::GetFolderPath('UserProfile')
        $env:HOME = $env:USERPROFILE
        $env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
        $env:APPDATA = [Environment]::GetFolderPath('ApplicationData')
        if (-not $env:USERPROFILE -or $env:USERPROFILE -eq $config.runnerProfile) {
            throw 'The standard-user profile was not loaded; refusing to use the runner profile.'
        }
        $env:TEMP = Join-Path $config.directory 'tmp'
        $env:TMP = $env:TEMP
        $env:UV_CACHE_DIR = Join-Path $config.directory 'uv-cache'
        $env:PIP_CACHE_DIR = Join-Path $config.directory 'pip-cache'
        $env:XDG_CACHE_HOME = Join-Path $config.directory 'cache'
        $env:XDG_DATA_HOME = Join-Path $config.directory 'data'
        $env:HEXBOT_HOME = Join-Path $config.directory 'unused-home'
        $env:HEXBOT_SMOKE_ARTIFACTS = $config.artifacts
        $env:HEXBOT_SMOKE_REQUIRE_STANDARD_USER = '1'
        $env:PATH = "$(Split-Path $config.node);$PSHOME;$env:SystemRoot/System32;$env:SystemRoot/System32/WindowsPowerShell/v1.0;$env:PATH"
        foreach ($name in @('WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'HEXBOT_UPDATE_SIGNING_KEY', 'HEXBOT_UPDATE_SIGNING_KEY_NEXT', 'GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN')) {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
        New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
        # Trust only the public VM certificate. No private signing key or PFX
        # enters this account, and production trust stores are not involved.
        $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($config.certificate)
        foreach ($name in @('Root', 'TrustedPublisher')) {
            $store = [Security.Cryptography.X509Certificates.X509Store]::new($name, 'CurrentUser')
            $store.Open('ReadWrite')
            try { $store.Add($certificate) } finally { $store.Close() }
        }
        Set-Location $config.workspace
        & $config.node --version | Set-Content (Join-Path $config.artifacts 'node-version.txt')
        if ($LASTEXITCODE) { throw 'The private Node executable could not run as the standard user.' }
        & $config.node scripts/dev/windows-install-smoke.mjs $config.packages *> (Join-Path $config.artifacts 'install-lifecycle-output.log')
        $childResult.exitCode = $LASTEXITCODE
        if ($LASTEXITCODE) { throw "The packaged lifecycle failed as the standard user, exit $LASTEXITCODE." }
        $childResult.passed = $true
    } catch {
        $childResult.error = $_.ToString()
        $_ | Out-String | Set-Content (Join-Path $config.artifacts 'standard-user-error.log')
    } finally {
        $childResult.finishedAt = [DateTime]::UtcNow.ToString('o')
        Write-JsonFile (Join-Path $config.artifacts 'standard-user-child.json') $childResult
    }
    if ($childResult.passed) { exit 0 } else { exit 1 }
}

if ($env:OS -ne 'Windows_NT') { throw 'This harness requires a Windows VM.' }
if ($env:GITHUB_ACTIONS -ne 'true' -and -not $AllowLocalVm) {
    throw 'Use this harness in a disposable GitHub Windows VM, or explicitly pass -AllowLocalVm in another disposable VM.'
}
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The VM fixture provisioner needs administrator access to create the standard account. The tested lifecycle does not.'
}
$repository = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$packagesSource = (Resolve-Path $Packages).Path
if (-not $Artifacts) { $Artifacts = Join-Path $packagesSource 'evidence' }
$evidence = Join-Path ([IO.Path]::GetFullPath($Artifacts)) 'standard-user'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$name = "HexbotVm$([Guid]::NewGuid().ToString('N').Substring(0, 10))"
$directory = Join-Path $env:ProgramData "HexbotWindowsVmTests/$name"
$workspace = Join-Path $directory 'workspace'
$privatePackages = Join-Path $workspace 'windows-packages'
$privateArtifacts = Join-Path $directory 'artifacts'
$result = @{ passed = $false; account = $name; startedAt = [DateTime]::UtcNow.ToString('o'); cleanupErrors = @() }
$created = $false
$child = $null
$sid = $null
$secondaryLogon = $null

function Copy-Tree([string]$Source, [string]$Destination) {
    & "$env:SystemRoot/System32/robocopy.exe" $Source $Destination /E /XJ /NFL /NDL /NJH /NJS /NP /XD evidence | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Could not copy the private fixture: $Source, robocopy exit $LASTEXITCODE." }
}

function Owned-Tasks {
    if (-not $sid) { return @() }
    @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.Principal.UserId -in @($sid, $name, "$env:COMPUTERNAME\$name") })
}

try {
    $secondaryLogon = Get-Service seclogon
    $result.secondaryLogonBefore = @{ status = $secondaryLogon.Status.ToString(); startupType = $secondaryLogon.StartType.ToString() }
    if ($secondaryLogon.StartType -eq 'Disabled') { Set-Service seclogon -StartupType Manual }
    if ($secondaryLogon.Status -ne 'Running') { Start-Service seclogon }
    $password = 'Hex9!' + [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36))
    Write-Output "::add-mask::$password"
    $secure = ConvertTo-SecureString $password -AsPlainText -Force
    $user = New-LocalUser -Name $name -Password $secure -AccountNeverExpires -PasswordNeverExpires -Description 'Disposable Hexbot standard-user Windows VM test'
    $created = $true
    $sid = $user.SID.Value
    $result.sid = $sid
    $users = Get-LocalGroup -SID 'S-1-5-32-545'
    if (-not @(Get-LocalGroupMember -Group $users.Name | Where-Object SID -eq $user.SID)) {
        Add-LocalGroupMember -Group $users.Name -Member $user
    }
    $administrators = Get-LocalGroup -SID 'S-1-5-32-544'
    if (@(Get-LocalGroupMember -Group $administrators.Name | Where-Object SID -eq $user.SID)) {
        throw 'The disposable account unexpectedly belongs to Administrators.'
    }
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $acl = Get-Acl -LiteralPath $directory
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($owner in @($sid, 'S-1-5-18', 'S-1-5-32-544')) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($owner), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
    New-Item -ItemType Directory -Path $workspace, $privateArtifacts -Force | Out-Null
    # Copy a small, self-contained workspace. No ACL changes or write access to
    # the checkout, runner profile, pnpm store, or original packages are needed.
    Copy-Tree (Join-Path $repository 'scripts') (Join-Path $workspace 'scripts')
    Copy-Tree $packagesSource $privatePackages
    foreach ($file in @('apps/desktop/package.json', 'packaging/update-signing-key.pub', 'backend/hexbot-installer/target/debug/hexbot-install.exe')) {
        $destination = Join-Path $workspace $file
        New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $repository $file) -Destination $destination
    }
    $nodeSource = (Get-Command node.exe).Source
    $node = Join-Path $workspace 'tools/node.exe'
    New-Item -ItemType Directory -Path (Split-Path $node) -Force | Out-Null
    Copy-Item -LiteralPath $nodeSource -Destination $node
    $dependencyCode = 'const{createRequire}=require("node:module");const p=require("node:path");const r=createRequire(p.join(process.argv[1],"apps/desktop/package.json"));const t=r.resolve("@playwright/test/package.json");const w=createRequire(t).resolve("playwright/package.json");const c=createRequire(w).resolve("playwright-core/package.json");console.log(JSON.stringify(Object.fromEntries([["@playwright/test",t],["playwright",w],["playwright-core",c]].map(([n,f])=>[n,p.dirname(f)]))))'
    $dependencies = & $nodeSource -e $dependencyCode $repository | ConvertFrom-Json
    if ($LASTEXITCODE) { throw 'Could not resolve the GUI test dependencies.' }
    foreach ($dependency in $dependencies.PSObject.Properties) {
        Copy-Tree $dependency.Value (Join-Path $workspace "node_modules/$($dependency.Name)")
    }
    $versions = Get-Content (Join-Path $privatePackages 'versions.json') -Raw | ConvertFrom-Json
    $wrapper = Join-Path $privatePackages "installers/HexbotInstaller-$($versions.current)-windows-x86_64.exe"
    $signature = Get-AuthenticodeSignature -LiteralPath $wrapper
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
        throw 'The standard-user test requires the actual VM-signed windowed installer package.'
    }
    $certificate = Join-Path $directory 'vm-signing-public.cer'
    [IO.File]::WriteAllBytes($certificate, $signature.SignerCertificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    $config = Join-Path $directory 'config.json'
    Write-JsonFile $config @{ sid = $sid; directory = $directory; workspace = $workspace; node = $node; packages = $privatePackages; artifacts = $privateArtifacts; certificate = $certificate; runnerProfile = $env:USERPROFILE }
    $credential = [Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$name", $secure)
    $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $workspace 'scripts/dev/windows-standard-user-smoke.ps1')`"", '-ChildConfig', "`"$config`"")
    $launch = @{
        FilePath = Join-Path $PSHOME 'pwsh.exe'; ArgumentList = $arguments
        Credential = $credential; LoadUserProfile = $true; WorkingDirectory = $workspace; PassThru = $true
        RedirectStandardOutput = Join-Path $privateArtifacts 'launcher-output.log'
        RedirectStandardError = Join-Path $privateArtifacts 'launcher-error.log'
    }
    $privateEnvironment = @{}
    foreach ($variable in @('WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'HEXBOT_UPDATE_SIGNING_KEY', 'HEXBOT_UPDATE_SIGNING_KEY_NEXT', 'GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN')) {
        $privateEnvironment[$variable] = [Environment]::GetEnvironmentVariable($variable, 'Process')
        [Environment]::SetEnvironmentVariable($variable, $null, 'Process')
    }
    try { $child = Start-Process @launch }
    finally {
        foreach ($variable in $privateEnvironment.Keys) { [Environment]::SetEnvironmentVariable($variable, $privateEnvironment[$variable], 'Process') }
    }
    $result.processId = $child.Id
    if (-not $child.WaitForExit($TimeoutSeconds * 1000)) { throw "The standard-user lifecycle exceeded $TimeoutSeconds seconds." }
    $child.Refresh()
    $result.exitCode = $child.ExitCode
    $token = Get-Content (Join-Path $privateArtifacts 'standard-user-token.json') -Raw | ConvertFrom-Json
    $childResult = Get-Content (Join-Path $privateArtifacts 'standard-user-child.json') -Raw | ConvertFrom-Json
    if ($child.ExitCode -ne 0 -or -not $childResult.passed -or $token.sid -ne $sid -or $token.administrator -or $token.groups -contains 'S-1-5-32-544') {
        throw 'The real lifecycle did not pass with the verified standard-user token. See the captured child and Task Scheduler diagnostics.'
    }
    $result.passed = $true
} catch {
    $result.error = $_.ToString()
} finally {
    if ($created) {
        try {
            $tasks = @(Owned-Tasks)
            $diagnostics = @($tasks | ForEach-Object {
                $info = Get-ScheduledTaskInfo -TaskName $_.TaskName -TaskPath $_.TaskPath
                @{ name = $_.TaskName; path = $_.TaskPath; state = $_.State.ToString(); user = $_.Principal.UserId; logonType = $_.Principal.LogonType.ToString(); description = $_.Description; actions = @($_.Actions | Select-Object Execute, Arguments); lastTaskResult = $info.LastTaskResult; lastRunTime = $info.LastRunTime }
            })
            Write-JsonFile (Join-Path $evidence 'task-scheduler.json') $diagnostics
            foreach ($task in $tasks) {
                Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue
                Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -Confirm:$false
            }
        } catch { $result.cleanupErrors += "Task cleanup: $_" }
        try {
            # Every process using this fresh SID was started by this harness or
            # its daemon task. Never select processes by executable name.
            foreach ($process in Get-CimInstance Win32_Process) {
                $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction SilentlyContinue
                if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $sid) {
                    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
                }
            }
        } catch { $result.cleanupErrors += "Process cleanup: $_" }
        if ($child) { $child.Dispose() }
    }
    if ($secondaryLogon) {
        try {
            if ($result.secondaryLogonBefore.status -ne 'Running') { Stop-Service seclogon }
            Set-Service seclogon -StartupType $result.secondaryLogonBefore.startupType
        } catch { $result.cleanupErrors += "Logon service cleanup: $_" }
    }
    if ($created) {
        try {
            $profileDeadline = [DateTime]::UtcNow.AddSeconds(15)
            do {
                $accountProfile = Get-CimInstance Win32_UserProfile | Where-Object SID -eq $sid
                if (-not $accountProfile -or -not $accountProfile.Loaded) { break }
                if ([DateTime]::UtcNow -ge $profileDeadline) { throw "The fresh profile is still loaded: $($accountProfile.LocalPath), SID $sid." }
                Start-Sleep -Milliseconds 250
            } while ($true)
            if ($accountProfile) {
                if ($accountProfile.Special) { throw 'Refusing to remove a special Windows profile.' }
                $accountProfile | Remove-CimInstance
            }
            if (Get-CimInstance Win32_UserProfile | Where-Object SID -eq $sid) { throw 'The fresh Windows profile was not removed.' }
            Remove-LocalUser -Name $name
        } catch {
            Disable-LocalUser -Name $name -ErrorAction SilentlyContinue
            $result.cleanupErrors += "Account/profile cleanup: $_"
        }
    }
    try {
        if (Test-Path -LiteralPath $privateArtifacts) { Copy-Tree $privateArtifacts $evidence }
        if (-not $result.passed) {
            $temporary = Join-Path $directory 'tmp'
            if (Test-Path -LiteralPath $temporary) {
                Get-ChildItem -LiteralPath $temporary -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('install.json', 'native-current.json', 'native-running.json', 'daemon.xml', 'service.log', 'service-error.log') -and $_.Length -lt 16777216 } | Select-Object -First 200 | ForEach-Object {
                    $relative = $_.FullName.Substring($directory.Length).TrimStart('\', '/')
                    $destination = Join-Path $evidence "failed-state/$relative"
                    New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
                    Copy-Item -LiteralPath $_.FullName -Destination $destination
                }
            }
        }
        if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
    } catch { $result.cleanupErrors += "Fixture cleanup: $_" }
    if ($result.cleanupErrors.Count) { $result.passed = $false }
    $result.finishedAt = [DateTime]::UtcNow.ToString('o')
    Write-JsonFile (Join-Path $evidence 'standard-user-result.json') $result
}
$result | ConvertTo-Json -Depth 5
if (-not $result.passed) { throw 'Windows standard-user validation failed; see standard-user-result.json and the captured lifecycle/task logs.' }
exit 0
