//! Native control for the pinned availability probes on the actual I386 and
//! AMD64 Windows PowerShell hosts. Test-only: production never sets a policy
//! or edits the module path. Runs before any package or download work.
use super::*;

fn probe(
    program: &std::path::Path,
    script: &str,
    policy: &str,
    ambient: bool,
) -> std::process::Output {
    let mut command = std::process::Command::new(program);
    command
        .args(["-NoProfile", "-NonInteractive", "-C", script])
        .env("PSExecutionPolicyPreference", policy);
    if !ambient {
        // Windows PowerShell builds its default module path (about_PSModulePath).
        command.env_remove("PSModulePath");
    }
    output(command).unwrap()
}

fn report(output: &std::process::Output) -> serde_json::Value {
    let text = |bytes: &[u8]| {
        String::from_utf8_lossy(bytes)
            .chars()
            .take(2048)
            .collect::<String>()
    };
    serde_json::json!({"status":output.status.code(),"stdout":text(&output.stdout),"stderr":text(&output.stderr)})
}

const MODULES: &str = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$m=@(Get-Module -ListAvailable Microsoft.PowerShell.Security|ForEach-Object{@{version=[string]$_.Version;path=$_.Path}});try{Import-Module Microsoft.PowerShell.Security -ErrorAction Stop;$i='imported'}catch{$i=$_.Exception.Message};@{psHome=$PSHOME;is64=[Environment]::Is64BitProcess;modulePath=$env:PSModulePath;security=$m;import=$i}|ConvertTo-Json -Compress -Depth 4";

#[test]
fn pinned_probes_follow_policy_on_both_native_hosts_with_default_modules() {
    let mut failures = Vec::new();
    for machine in [Machine::I386, Machine::Amd64] {
        let program = host(machine).unwrap();
        for (policy, policy_ok) in [("RemoteSigned", true), ("Restricted", false)] {
            let available = probe(&program, AVAILABLE_PROBE, policy, false);
            let policy_probe = probe(&program, POLICY_PROBE, policy, false);
            // The unmodified environment is evidence only, never asserted.
            let ambient = probe(&program, POLICY_PROBE, policy, true);
            let record = serde_json::json!({"machine":format!("{machine:?}"),"program":program,"policy":policy,"available":report(&available),"policyProbe":report(&policy_probe),"ambientPolicyProbe":report(&ambient)});
            eprintln!("Native NSIS probe host control: {record}");
            let failed = (policy_ok && !available.status.success())
                || policy_probe.status.code() != Some(if policy_ok { 0 } else { 1 });
            if failed {
                let modules = probe(&program, MODULES, policy, false);
                failures.push(serde_json::json!({"record":record,"modules":report(&modules)}));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "Pinned probe host control failed: {}",
        serde_json::Value::from(failures)
    );
}
