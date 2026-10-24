$ErrorActionPreference = 'Stop'
# Diagnostics are opt-in for the disposable CI user, never ordinary service logs.
function Describe-HexbotTaskValue($value) {
    $text = [string]$value
    @{ value = $text.Substring(0, [Math]::Min(512, $text.Length)); length = $text.Length; type = $(if ($null -eq $value) { 'null' } else { $value.GetType().FullName }) }
}
function Write-HexbotTaskDiagnostic($reason) {
    if ($env:HEXBOT_WINDOWS_SERVICE_PROBE -cne '1') { return }
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $details = [ordered]@{
        reason = $reason; operation = $operation; task = $taskName; state = [int]$task.State
        count = (Describe-HexbotTaskValue $definition.Actions.Count)
        actionContext = (Describe-HexbotTaskValue $definition.Actions.Context)
        principalId = (Describe-HexbotTaskValue $definition.Principal.Id)
        logonType = [int]$definition.Principal.LogonType; runLevel = [int]$definition.Principal.RunLevel
        program = @{ actual = (Describe-HexbotTaskValue $action.Path); expected = (Describe-HexbotTaskValue $expectedPowerShell); matches = ($action.Path -ieq $expectedPowerShell) }
        arguments = @{ actual = (Describe-HexbotTaskValue $action.Arguments); expected = (Describe-HexbotTaskValue $expectedArguments); matches = ($action.Arguments -ceq $expectedArguments) }
        principal = @{ actual = (Describe-HexbotTaskValue $definition.Principal.UserId); expected = (Describe-HexbotTaskValue $expectedSid); resolved = (Describe-HexbotTaskValue $principalSid); matches = ($principalSid -ceq $expectedSid) }
        home = @{ actual = (Describe-HexbotTaskValue $definition.RegistrationInfo.Description); expected = (Describe-HexbotTaskValue $expectedOwner); legacyScriptOwned = $allowLegacy }
    }
    [Console]::Error.WriteLine('Hexbot task ownership diagnostic: ' + ($details | ConvertTo-Json -Depth 5 -Compress))
}
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
try {
    $task = $folder.GetTask($taskName)
    $definition = $task.Definition
    $action = $definition.Actions.Item(1)
    $principalSid = Resolve-HexbotTaskSid $definition.Principal.UserId
    if ($definition.Actions.Count -ne 1 -or $action.Path -ine $expectedPowerShell -or $action.Arguments -cne $expectedArguments -or $principalSid -cne $expectedSid) {
        Write-HexbotTaskDiagnostic 'principal/action mismatch'
        throw 'Windows task belongs to another installation; left it alone'
    }
    # A fixed per-user script path/SID alone cannot identify HEXBOT_HOME.
    # Legacy definitions require their still-owned script; new definitions
    # retain the home binding even if that script was deleted/interrupted.
    $owner = [string]$definition.RegistrationInfo.Description
    if ($owner -cne $expectedOwner -and (-not $allowLegacy -or -not [string]::IsNullOrEmpty($owner))) {
        Write-HexbotTaskDiagnostic 'home mismatch'
        throw 'Windows task has no matching home ownership context; left it alone'
    }
    switch ($operation) {
        'state' { [int]$task.State }
        'instances' {
            $registered = $task.GetInstances(0)
            if ($registered.Count -gt 16) { throw 'Too many Windows task instances' }
            $engines = @(for ($index=1; $index -le $registered.Count; $index++) {
                $instance = $registered.Item($index)
                if ([int]$instance.State -eq 4) {
                    $engine = [uint32]$instance.EnginePID
                    if ($engine -eq 0) { throw 'Running Windows task has no engine identity' }
                    $engine
                }
            })
            ConvertTo-Json -InputObject @{state=[int]$task.State;engines=$engines} -Compress
        }
        'stop' {
            # State is only a snapshot, particularly after definition updates.
            # Ask the verified scheduler object to stop all of its instances.
            try { $task.Stop(0) } catch {
                $stopError = $_.Exception
                while ($stopError.InnerException) { $stopError = $stopError.InnerException }
                # SCHED_E_TASK_NOT_RUNNING is the one harmless stop race.
                if ($stopError.HResult -ne -2147216629) { throw }
            }
        }
        'diagnose' { Get-HexbotTaskDiagnostic }
        'delete' { $folder.DeleteTask($taskName, 0) }
        default { throw 'Unknown task operation' }
    }
} catch {
    $exception = $_.Exception
    while ($exception.InnerException) { $exception = $exception.InnerException }
    # HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND). Other failures, including
    # access denied, must retain the owned script/XML for recovery.
    if ($exception.HResult -eq -2147024894) {
        if ($operation -eq 'state') { 'missing' }
        elseif ($operation -eq 'instances') { '{"state":null,"engines":[]}' }
    } else { throw }
}
