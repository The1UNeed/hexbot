$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = 'C:\HexbotVm'
$evidence = "$root\evidence"
$manifest = Get-Content "$root\downloads.json" -Raw | ConvertFrom-Json
function Beacon([string]$stage) {
    try { Invoke-WebRequest -UseBasicParsing -Uri ('http://10.0.2.2:15986/beacon/' + $stage) -TimeoutSec 5 } catch { }
}
function Set-Phase([string]$phase, [string]$message) {
    Beacon ('phase-' + $phase)
    $state = @{ phase = $phase; message = $message; time = [DateTime]::UtcNow.ToString('o') }
    $state | ConvertTo-Json | Set-Content "$root\state.next.json"
    Move-Item "$root\state.next.json" "$root\state.json" -Force
}
# Re-assert WinRM reachability: servicing can reset the network profile or the
# firewall rules the bootstrap configured, and the host needs the state file.
try {
    Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private
    Get-NetFirewallRule -Name 'WINRM-HTTP-In-TCP*' | Set-NetFirewallRule -RemoteAddress 10.0.2.2 -Profile Any
    Beacon 'guest-winrm-reasserted'
} catch {
    Beacon ('guest-winrm-reassert-error-' + ($_.Exception.Message -replace '[^A-Za-z0-9]', '-'))
}
try {
try {
    $phase = ''
    if (Test-Path "$root\state.json") {
        $phase = (Get-Content "$root\state.json" -Raw | ConvertFrom-Json).phase
        if (-not $phase) { $phase = '' }
    }
} catch {
    # A forced restart can leave the state file short. A guest whose validation
    # task is running again is definitionally past patching, so resume there.
    Beacon ('state-parse-error-length-' + (Get-Item "$root\state.json" -ErrorAction SilentlyContinue).Length)
    $phase = 'rebooting'
}
    if ($phase -eq 'passed' -or $phase -eq 'failed') { exit }
    # 'rebooting' resumes here after the update restart. 'testing' also
    # resumes in place after an unexpected reboot instead of re-patching.
    if ($phase -notin @('rebooting', 'testing')) {
        Set-Phase 'patching' 'Downloading the pinned Microsoft checkpoint and cumulative update'
        $packages = "$root\packages"
        New-Item -ItemType Directory -Path $packages -Force | Out-Null
        foreach ($update in $manifest.updates) {
            $file = Join-Path $packages $update.name
            foreach ($attempt in 1..3) {
                try {
                    Invoke-WebRequest -UseBasicParsing -Uri $update.url -OutFile $file -TimeoutSec 1200
                    break
                } catch {
                    if ($attempt -eq 3) { throw }
                    Start-Sleep -Seconds 10
                }
            }
            if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $update.sha256) {
                throw "The pinned update checksum does not match: $($update.name)"
            }
        }
        # Microsoft's method 2 installs the target and discovers any required
        # checkpoint in the same directory. An already superseded checkpoint
        # must not be forced onto the newer evaluation image separately.
        $target = Join-Path $packages $manifest.updates[-1].name
        & dism.exe /Online /Add-Package "/PackagePath:$target" /Quiet /NoRestart "/LogPath:$evidence\update.log"
        if ($LASTEXITCODE -notin @(0, 3010)) { throw "The Windows update failed with exit code $LASTEXITCODE" }
        Remove-Item -LiteralPath $packages -Recurse -Force
        Set-Phase 'rebooting' 'The pinned update is installed; restarting Windows'
        # Give the state file a moment before the forced restart.
        Start-Sleep -Seconds 2
        Restart-Computer -Force
        exit
    }

    Set-Phase 'testing' 'Checking Windows 11 x64, Secure Boot, TPM, and standard-user containment'
    $os = Get-CimInstance Win32_OperatingSystem
    $version = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    Beacon ('build-' + $version.CurrentBuildNumber + '-ubr-' + $version.UBR)
    if ($version.CurrentBuildNumber -ne '26300' -or [int]$version.UBR -lt 9711) {
        # Servicing can commit the cumulative update on a second restart.
        $restarts = 0
        if (Test-Path "$root\update-restarts") { $restarts = [int](Get-Content "$root\update-restarts" -Raw) }
        if ($restarts -ge 2) { throw "The pinned Windows cumulative update is missing after $restarts extra restarts (build $($version.CurrentBuildNumber) UBR $($version.UBR))" }
        $restarts++
        Set-Content "$root\update-restarts" $restarts
        Set-Phase 'rebooting' 'The update needs another restart to finish committing'
        Start-Sleep -Seconds 2
        Restart-Computer -Force
        exit
    }
    $secureBoot = Confirm-SecureBootUEFI
    $tpm = Get-Tpm
    $machine = @{
        caption = $os.Caption; productType = $os.ProductType; architecture = $env:PROCESSOR_ARCHITECTURE
        build = $version.CurrentBuildNumber; revision = $version.UBR; displayVersion = $version.DisplayVersion
        secureBoot = $secureBoot; tpmPresent = $tpm.TpmPresent; tpmReady = $tpm.TpmReady
    }
    $machine | ConvertTo-Json | Set-Content "$evidence\machine.json"
    if ($os.ProductType -ne 1 -or $os.Caption -notmatch 'Windows 11' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
        throw 'This proof requires the native Windows 11 x64 client kernel'
    }
    if (!$secureBoot -or !$tpm.TpmPresent -or !$tpm.TpmReady) { throw 'Secure Boot and a ready TPM are required' }

    $tools = 'C:\Program Files\HexbotVmTools'
    New-Item -ItemType Directory -Path "$tools\python" -Force | Out-Null
    Copy-Item "$root\node.exe", "$root\wxc-exec.exe" -Destination $tools
    Expand-Archive -LiteralPath "$root\python.zip" -DestinationPath "$tools\python" -Force
    $mxc = "$tools\wxc-exec.exe"
    if ((Get-FileHash -LiteralPath $mxc -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.mxc.executableSha256) { throw 'The pinned MXC executable checksum does not match' }
    $signature = Get-AuthenticodeSignature -LiteralPath $mxc
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
        throw 'The MXC executable must have a trusted Microsoft signature'
    }
    @{
        version = '1.0.1'; architecture = 'x64'; sha256 = $manifest.mxc.executableSha256
        signatureStatus = $signature.Status.ToString(); signer = $signature.SignerCertificate.Subject
    } | ConvertTo-Json | Set-Content "$evidence\candidate.json"

    $name = 'HexbotPsecUser'
    $bytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    $password = 'aA1!' + [Convert]::ToBase64String($bytes)
    $secure = ConvertTo-SecureString $password -AsPlainText -Force
    $account = $null
    $child = $null
    $fixture = 'C:\HexbotPsecUser'
    $fixture = 'C:\HexbotPsecUser'
    # A testing phase interrupted by an unexpected reboot can leave its
    # disposable account and fixture behind; clear them so a resumed run
    # starts clean instead of failing at user creation.
    try { if (Get-LocalUser -Name $name -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $name } } catch { }
    if (Test-Path $fixture) { try { Remove-Item -LiteralPath $fixture -Recurse -Force } catch { } }
    try {
        $account = New-LocalUser -Name $name -Password $secure -AccountNeverExpires -PasswordNeverExpires -Description 'Disposable Hexbot PSEC validation'
        Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account
        New-Item -ItemType Directory -Path $fixture | Out-Null
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in @($account.SID.Value, 'S-1-5-18', 'S-1-5-32-544')) {
            $principal = [Security.Principal.SecurityIdentifier]::new($sid)
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
        }
        Set-Acl -LiteralPath $fixture -AclObject $acl
        Copy-Item "$root\probe.mjs", "$root\standard-user.ps1" -Destination $fixture
        Copy-Item "$root\fixtures" -Destination $fixture -Recurse
        New-Item -ItemType Directory -Path "$fixture\temp", "$fixture\appdata" | Out-Null
        $credential = [Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$name", $secure)
        $child = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "$fixture\standard-user.ps1") -WorkingDirectory $fixture -Credential $credential -LoadUserProfile -PassThru
        if (!$child.WaitForExit(900000)) { throw 'The standard-user containment proof exceeded fifteen minutes' }
        if ($child.ExitCode -ne 0) { throw "The standard-user containment proof failed with exit code $($child.ExitCode)" }
    } finally {
        if ($child -and !$child.HasExited) { & taskkill.exe /PID $child.Id /T /F | Out-Null }
        if (Test-Path "$fixture\evidence") { Copy-Item "$fixture\evidence" -Destination "$evidence\standard-user" -Recurse -Force }
        if (Test-Path "$fixture\standard-user.log") { Copy-Item "$fixture\standard-user.log" -Destination $evidence }
        if ($account) { Remove-LocalUser -Name $name }
    }
    Set-Phase 'passed' 'The full PSEC candidate passed under a standard Windows 11 x64 user'
} catch {
    Beacon ('guest-error-' + ($_.Exception.Message -replace '[^A-Za-z0-9]', '-'))
    Set-Phase 'failed' $_.Exception.Message
} finally {
    if (Test-Path "$root\state.json") { Copy-Item "$root\state.json" "$evidence\state.json" -Force }
    try {
        Compress-Archive -Path "$evidence\*" -DestinationPath "$root\guest-evidence.zip" -Force
        try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'http://10.0.2.2:15986/post/guest-evidence.zip' -InFile "$root\guest-evidence.zip" -ContentType 'application/octet-stream' -TimeoutSec 120 } catch { Beacon 'evidence-post-error' }
    } catch { Beacon ('evidence-zip-error-' + ($_.Exception.Message -replace '[^A-Za-z0-9]', '-')) }
}
