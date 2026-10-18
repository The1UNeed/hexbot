# Download and verify the terminal installer before running it.
# Keep execution inside this function so an incomplete download runs nothing.
function Invoke-HexbotBootstrap {
    param([string[]]$InstallerArguments)
    $ErrorActionPreference = 'Stop'
    if ($env:OS -ne 'Windows_NT') { throw 'Use https://hexbot.app/install.sh on macOS or Linux.' }
    $machine = $env:PROCESSOR_ARCHITEW6432
    if (-not $machine) { $machine = $env:PROCESSOR_ARCHITECTURE }
    if ($machine -ne 'AMD64') { throw 'The Windows installer requires an x64 computer.' }

    $base = $env:HEXBOT_UPDATE_URL
    if (-not $base) { $base = 'https://updates.hexbot.app' }
    $base = $base.TrimEnd('/')
    $origin = [Uri]$base
    $loopback = $origin.Scheme -eq 'http' -and $origin.IsLoopback -and -not $origin.IsDefaultPort
    if (-not $origin.IsAbsoluteUri -or $origin.UserInfo -or $origin.Query -or $origin.Fragment -or ($origin.Scheme -ne 'https' -and -not $loopback)) {
        throw 'HEXBOT_UPDATE_URL must be an HTTPS address.'
    }

    $track = $env:HEXBOT_TRACK
    foreach ($argument in $InstallerArguments) {
        if ($argument -eq '--nightly') { $track = 'nightly' }
        if ($argument -eq '--stable') { $track = 'stable' }
    }
    if ($track -and $track -notin @('stable', 'nightly')) { throw 'HEXBOT_TRACK must be stable or nightly.' }

    function Get-HexbotFile([string]$Address, [string]$Destination, [switch]$AllowMissing) {
        try {
            $response = Invoke-WebRequest -Uri $Address -OutFile $Destination -PassThru -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 60
            if ([int]$response.StatusCode -ne 200) { throw "Unexpected status for $Address" }
            return $true
        } catch {
            if ($AllowMissing -and $_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { return $false }
            throw
        }
    }

    $temporary = Join-Path ([IO.Path]::GetTempPath()) ('hexbot-install-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($temporary) | Out-Null
    try {
        if (-not $track) {
            if (Get-HexbotFile "$base/install/stable.json" (Join-Path $temporary 'manifest.json') -AllowMissing) { $track = 'stable' }
            else { $track = 'nightly' }
        }
        $index = Join-Path $temporary 'install.txt'
        Get-HexbotFile "$base/install/$track.txt" $index | Out-Null
        $entries = @(Get-Content -LiteralPath $index | Where-Object { $_ -match '^windows-x86_64(?:\s|$)' })
        if ($entries.Count -ne 1) { throw 'The Windows installer is not available on this track.' }
        if ($entries[0] -cnotmatch '^windows-x86_64\s+([0-9a-f]{64})\s+(\S+)\s*$') { throw 'The installer index is invalid.' }
        $checksum = $Matches[1]
        $address = $Matches[2]
        $download = [Uri]$address
        if (-not $download.IsAbsoluteUri -or $download.UserInfo -or $download.Query -or $download.Fragment -or $download.GetLeftPart([UriPartial]::Authority) -ne $origin.GetLeftPart([UriPartial]::Authority) -or -not $address.StartsWith("$base/", [StringComparison]::Ordinal)) {
            throw 'The installer URL must be on the update server.'
        }
        Write-Host "Downloading the Hexbot installer ($track)."
        $executable = Join-Path $temporary 'hexbot-install.exe'
        Get-HexbotFile $address $executable | Out-Null
        if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -cne $checksum) {
            throw 'The installer checksum does not match. Run the install command again.'
        }
        & $executable @InstallerArguments
        $status = $LASTEXITCODE
        if ($null -eq $status) { $status = 1 }
    } finally {
        Remove-Item -LiteralPath $temporary -Recurse -Force
    }
    exit $status
}

Invoke-HexbotBootstrap -InstallerArguments $args
