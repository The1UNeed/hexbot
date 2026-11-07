# Pure predicates shared by native execution and portable contract tests.
function Test-HexbotNsisPrefix($path,$destinations) {
    if($null -eq $path -or $path -eq '') {return $false}
    if($path -isnot [string] -or $path.Length -gt 32768){throw 'Invalid process path'}
    foreach($destination in $destinations) {
        # Intentionally NO separator, exactly as the pinned NSIS macro.
        if($path.StartsWith($destination,'CurrentCultureIgnoreCase')) {return $true}
    }
    return $false
}
function Test-HexbotNsisImage($name,$image,$ownerName,$username,$ownerSid,$resolvedSid,$currentSid) {
    if(-not $name.Equals($image,[StringComparison]::OrdinalIgnoreCase)){return $false}
    if(!$ownerSid -or !$resolvedSid -or $ownerSid -ne $resolvedSid){throw 'Process owner SID could not be verified'}
    if(-not $ownerName.Equals($username,[StringComparison]::OrdinalIgnoreCase)){return $false}
    if($ownerSid -ne $currentSid){throw 'Ambiguous same-name process owner'}
    return $true
}
