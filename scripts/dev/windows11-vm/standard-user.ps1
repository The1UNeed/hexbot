$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$PSHOME\Modules"
$env:HEXBOT_TEST_MXC_EXECUTABLE = 'C:\Program Files\HexbotVmTools\wxc-exec.exe'
$env:HEXBOT_TEST_PYTHON = 'C:\Program Files\HexbotVmTools\python\python.exe'
$env:HEXBOT_WINDOWS_PROBE_DIR = "$PSScriptRoot\evidence"
$env:HEXBOT_REQUIRE_STANDARD_USER = '1'
$env:MXC_DACL_STATE_DIR = "$PSScriptRoot\unused-dacl-state"
$env:LOCALAPPDATA = "$PSScriptRoot\appdata"
$env:TEMP = "$PSScriptRoot\temp"
$env:TMP = $env:TEMP
& 'C:\Program Files\HexbotVmTools\node.exe' "$PSScriptRoot\probe.mjs" *> "$PSScriptRoot\standard-user.log"
exit $LASTEXITCODE
