function Test-HexbotLogPath($path, [bool]$directory) {
    try { $attributes = [IO.File]::GetAttributes($path) }
    catch [IO.FileNotFoundException] { return $false }
    catch [IO.DirectoryNotFoundException] { return $false }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        ((($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $directory)) {
        throw 'Hexbot service log path is not an ordinary directory/file'
    }
    return $true
}
function Ensure-HexbotServiceLogs {
    $canonicalHome = [HexbotFinalPath]::Resolve($env:HEXBOT_HOME)
    $logs = Join-Path $canonicalHome 'logs'
    if (!(Test-HexbotLogPath $logs $true)) { $null = [IO.Directory]::CreateDirectory($logs) }
    if (!(Test-HexbotLogPath $logs $true) -or [HexbotFinalPath]::Resolve($logs) -ine $logs) {
        throw 'Hexbot service log directory is outside its canonical home'
    }
    foreach ($name in @('service.log', 'service-error.log')) {
        $null = Test-HexbotLogPath (Join-Path $logs $name) $false
    }
    # Open without truncation while errors still terminate the script. Native
    # redirection under Continue must not turn failed logging into task success.
    foreach ($name in @('service.log', 'service-error.log')) {
        $stream = [IO.File]::Open((Join-Path $logs $name), 'OpenOrCreate', 'Write', 'ReadWrite,Delete')
        $stream.Dispose()
    }
}
