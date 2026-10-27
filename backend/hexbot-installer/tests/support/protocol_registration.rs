//! Own the initially absent fixed handler only on the explicitly disposable CI user.
use serde_json::Value;
use std::process::Command;
pub struct Protocol;
impl Protocol {
    pub fn new() -> Self {
        assert_eq!(
            std::env::var("HEXBOT_WINDOWS_NSIS_PROBE").as_deref(),
            Ok("1")
        );
        assert_eq!(
            Self::run("snapshot", ""),
            Value::Null,
            "Disposable protocol fixture requires an initially absent handler"
        );
        Self::run("init", "");
        Self
    }
    fn run(action: &str, value: &str) -> Value {
        let script = r#"$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$r=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
$p='Software\Classes\hexbot'
try{
 if($env:TEST_PROTOCOL_ACTION -eq 'clear'){$r.DeleteSubKeyTree($p,$false);'null';exit}
 if($env:TEST_PROTOCOL_ACTION -eq 'init'){$k=$r.CreateSubKey($p);try{$k.SetValue('fixture','owned disposable protocol');foreach($child in @('DefaultIcon','shell\edit\command')){$v=$k.CreateSubKey($child);try{$v.SetValue('','keep unrelated value')}finally{$v.Dispose()}}}finally{$k.Dispose()}}
 if($env:TEST_PROTOCOL_ACTION -eq 'set'){$k=$r.CreateSubKey($p+'\shell\open\command');try{$k.SetValue('',$env:TEST_PROTOCOL_VALUE,[Microsoft.Win32.RegistryValueKind]::String)}finally{$k.Dispose()}}
 function Snapshot($key){$values=@{};foreach($name in $key.GetValueNames()){$values[$name]=@{kind=$key.GetValueKind($name).ToString();value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}};$children=@{};foreach($name in $key.GetSubKeyNames()){$child=$key.OpenSubKey($name);try{$children[$name]=Snapshot $child}finally{$child.Dispose()}};return @{values=$values;children=$children}}
 $k=$r.OpenSubKey($p);try{if($k){Snapshot $k|ConvertTo-Json -Compress -Depth 15}else{'null'}}finally{if($k){$k.Dispose()}}
}finally{$r.Dispose()}"#;
        let output = Command::new(
            std::path::Path::new(&std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        )
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("TEST_PROTOCOL_ACTION", action)
        .env("TEST_PROTOCOL_VALUE", value)
        .output()
        .unwrap();
        assert!(
            output.status.success(),
            "protocol fixture {action}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    pub fn snapshot(&self) -> Value {
        Self::run("snapshot", "")
    }
    pub fn command(&self) -> Option<String> {
        self.snapshot()["children"]["shell"]["children"]["open"]["children"]["command"]["values"][""]["value"].as_str().map(str::to_owned)
    }
    pub fn set(&self, value: &str) {
        Self::run("set", value);
    }
    pub fn assert_other_values(&self) {
        let value = self.snapshot();
        assert_eq!(
            value["values"]["fixture"]["value"],
            "owned disposable protocol"
        );
        assert_eq!(
            value["children"]["DefaultIcon"]["values"][""]["value"],
            "keep unrelated value"
        );
        assert_eq!(
            value["children"]["shell"]["children"]["edit"]["children"]["command"]["values"][""]["value"],
            "keep unrelated value"
        );
    }
}
impl Drop for Protocol {
    fn drop(&mut self) {
        let result = std::panic::catch_unwind(|| Self::run("clear", ""));
        if result.is_err() && !std::thread::panicking() {
            panic!("Could not restore owned protocol fixture")
        }
    }
}
