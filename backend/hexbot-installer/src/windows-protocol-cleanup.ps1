# Mutation boundary separate from the read-only NSIS registry collision check.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$commandKey='__COMMAND_KEY__'
$stage='parse-bindings';$decoded=$null;$candidates=@();$root=$null;$key=$null;$observedKind=$null
try {
    $inputJson=$env:HEXBOT_PROTOCOL_BINDINGS
    if(!$inputJson -or $inputJson.Length -gt 17000 -or !$inputJson.TrimStart().StartsWith('[') -or !$inputJson.TrimEnd().EndsWith(']')) { throw 'Invalid protocol binding JSON array' }
    # Windows PowerShell 5.1 emits a JSON array as one pipeline object. Assign
    # before array normalization so it cannot become a nested candidate array.
    $decoded=ConvertFrom-Json -InputObject $inputJson
    $candidates=@($decoded)
    $stage='validate-bindings'
    if($candidates.Count -lt 1 -or $candidates.Count -gt 2) { throw 'Invalid protocol binding count' }
    foreach($candidate in $candidates) {
        if($candidate -isnot [string] -or $candidate.Length -gt 4200 -or $candidate.IndexOfAny([char[]]"`r`n`0") -ge 0 -or
           !$candidate.EndsWith('" "%1"',[StringComparison]::Ordinal) -or $candidate[0] -ne '"') { throw 'Invalid protocol binding' }
    }
    $stage='open-registry'
    $root=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
    # One key handle for read/type/compare/delete. Never enumerate/delete a tree.
    $key=$root.OpenSubKey($commandKey,$true)
    $outcome='absent'
    $stage='read-command'
    if($key -and $key.GetValueNames() -contains '') {
        $outcome='preserved'
        $actual=$key.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $observedKind=$key.GetValueKind('').ToString()
        if(Test-HexbotProtocolBinding $actual $observedKind $candidates) {
            $stage='delete-command'
            $key.DeleteValue('',$false);$outcome='removed'
        }
    }
    $stage='result'
    @{outcome=$outcome} | ConvertTo-Json -Compress
} catch {
    $items=@(for($i=0;$i -lt [Math]::Min(2,$candidates.Count);$i++) {
        $item=$candidates[$i]
        @{type=$(if($null -eq $item){'null'}else{$item.GetType().FullName});
          utf16Units=$(if($item -is [string]){$item.Length});
          spelling=$(if($item -is [string]){$item.Substring(0,[Math]::Min(1024,$item.Length))});
          truncated=($item -is [string] -and $item.Length -gt 1024)}
    })
    $message=$_.Exception.Message
    $diagnostic=@{stage=$stage;key=$commandKey;psVersion=$PSVersionTable.PSVersion.ToString();
        decodedType=$(if($null -eq $decoded){'null'}else{$decoded.GetType().FullName});
        candidateArrayType=$candidates.GetType().FullName;candidateCount=$candidates.Count;candidates=$items;observedKind=$observedKind;
        errorType=$_.Exception.GetType().FullName;errorId=$_.FullyQualifiedErrorId;
        errorMessage=$message.Substring(0,[Math]::Min(1024,$message.Length));errorTruncated=($message.Length -gt 1024)}
    [Console]::Error.WriteLine(($diagnostic|ConvertTo-Json -Compress -Depth 5))
    throw
} finally { if($key){$key.Dispose()};if($root){$root.Dispose()} }
