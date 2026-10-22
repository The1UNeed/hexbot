$ErrorActionPreference = 'Stop'
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
try {
    $task = $folder.GetTask($taskName)
    $definition = $task.Definition
    $action = $definition.Actions.Item(1)
    if ($definition.Actions.Count -ne 1 -or $action.Path -ine $expectedPowerShell -or $action.Arguments -cne $expectedArguments -or $definition.Principal.UserId -ine $expectedSid) {
        throw 'Windows task belongs to another installation; left it alone'
    }
    switch ($operation) {
        'state' { [int]$task.State }
        'stop' { if ([int]$task.State -eq 4) { $task.Stop(0) } }
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
    } else { throw }
}
