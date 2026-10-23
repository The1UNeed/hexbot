//! Disposable CI registrations only. Assert absence before assuming cleanup authority.
use serde_json::{Value, json};
use std::{path::Path, process::Command};
pub struct Registration {
    guid: String,
}
impl Registration {
    pub fn new(id: &str) -> Self {
        assert_eq!(
            std::env::var("HEXBOT_WINDOWS_NSIS_PROBE").as_deref(),
            Ok("1")
        );
        let source = include_str!("../../src/windows_nsis.rs");
        let rest = source.split(&format!("\"{id}\"")).nth(1).unwrap();
        let guid = rest.split('"').nth(1).unwrap().to_owned();
        let fixture = Self { guid };
        let before = fixture.snapshot();
        if before
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["install"] == true || e["uninstall"] == true)
        {
            // Do not run Drop with authority over an existing registration.
            std::mem::forget(fixture);
            panic!("Disposable NSIS identity must initially be unregistered: {before}");
        }
        fixture
    }
    fn run(&self, action: &str, data: Value) -> Value {
        let script = r#"
$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$guid=$env:HEXBOT_NSIS_GUID;$data=$env:HEXBOT_NSIS_DATA|ConvertFrom-Json
$result=@(foreach($scope in @('CurrentUser','LocalMachine')) {
 $root=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$scope,[Microsoft.Win32.RegistryView]::Registry64)
 $keys=@("Software\$guid","Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid")
 try {
  if($env:HEXBOT_NSIS_ACTION -eq 'clear' -or ($env:HEXBOT_NSIS_ACTION -eq 'restore' -and !$data.$scope.install)) {foreach($path in $keys){$root.DeleteSubKeyTree($path,$false)}}
  elseif($env:HEXBOT_NSIS_ACTION -eq 'restore' -or ($env:HEXBOT_NSIS_ACTION -eq 'edit' -and $data.scope -eq $scope)) {
   $record=if($env:HEXBOT_NSIS_ACTION -eq 'restore'){$data.$scope}else{$data}
   $a=$root.CreateSubKey($keys[0]);$b=$root.CreateSubKey($keys[1]);try{$a.SetValue('InstallLocation',[string]$record.location);$b.SetValue('UninstallString',[string]$record.command)}finally{$a.Dispose();$b.Dispose()}
  }
  $a=$root.OpenSubKey($keys[0]);$b=$root.OpenSubKey($keys[1]);try{@{scope=$scope;install=($null -ne $a);uninstall=($null -ne $b);location=$(if($a){$a.GetValue('InstallLocation')});command=$(if($b){$b.GetValue('UninstallString')})}}finally{if($a){$a.Dispose()};if($b){$b.Dispose()}}
 } finally {$root.Dispose()}
});ConvertTo-Json -InputObject $result -Compress
"#;
        let output = Command::new(
            Path::new(&std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        )
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("HEXBOT_NSIS_GUID", &self.guid)
        .env("HEXBOT_NSIS_ACTION", action)
        .env("HEXBOT_NSIS_DATA", data.to_string())
        .output()
        .unwrap();
        assert!(
            output.status.success(),
            "NSIS fixture {action}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    pub fn snapshot(&self) -> Value {
        self.run("snapshot", Value::Null)
    }
    pub fn edit(&self, scope: &str, location: &Path, command: &str) {
        self.run(
            "edit",
            json!({"scope":scope,"location":location,"command":command}),
        );
    }
    pub fn restore(&self, before: &Value) {
        let mut data = serde_json::Map::new();
        for entry in before.as_array().unwrap() {
            data.insert(entry["scope"].as_str().unwrap().into(), entry.clone());
        }
        self.run("restore", data.into());
    }
    pub fn assert_absent(&self) {
        assert!(
            self.snapshot()
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["install"] == false && e["uninstall"] == false)
        );
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            self.run("clear", Value::Null);
        } else {
            let _ = std::panic::catch_unwind(|| self.run("clear", Value::Null));
        }
    }
}
