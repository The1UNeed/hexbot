# Task Scheduler may return an account name even when XML specified its SID.
# Resolve through Windows identity APIs; never infer ownership from a name.
function Resolve-HexbotTaskSid([string]$identity) {
    if ([string]::IsNullOrWhiteSpace($identity)) { return $null }
    try {
        try { $sid = [Security.Principal.SecurityIdentifier]::new($identity) }
        catch {
            $sid = [Security.Principal.NTAccount]::new($identity).Translate([Security.Principal.SecurityIdentifier])
        }
        return $sid.Value
    } catch { return $null }
}
