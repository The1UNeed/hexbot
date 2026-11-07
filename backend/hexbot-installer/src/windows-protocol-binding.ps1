# Pure comparison shared by the cleanup boundary and portable protocol tests.
function Test-HexbotProtocolBinding($actual,$kind,$candidates) {
    if($kind -cne 'String' -or $actual -isnot [string] -or $actual.Length -gt 4200 -or
       $actual.IndexOfAny([char[]]"`r`n`0") -ge 0 -or !$actual.EndsWith('" "%1"',[StringComparison]::Ordinal)) { return $false }
    foreach($candidate in $candidates) {
        if($actual.Substring(0,$actual.Length-5).Equals($candidate.Substring(0,$candidate.Length-5),[StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}
