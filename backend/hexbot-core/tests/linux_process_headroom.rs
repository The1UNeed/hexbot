#![cfg(target_os = "linux")]

use hexbot_core::credentials::{Confine, isolated_command, isolation_available};

#[tokio::test]
async fn linux_fallback_keeps_host_process_headroom() {
    if isolation_available() {
        // A fresh process avoids the cached sandbox probe and always covers the
        // fallback, including CI machines that have working bubblewrap.
        let bins = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/usr/bin/ps", bins.path().join("ps")).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "linux_fallback_keeps_host_process_headroom",
                "--nocapture",
            ])
            .env("PATH", bins.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let code = "import json,resource,subprocess,threading\nsubprocess.run(['/bin/true'],check=True)\nt=threading.Thread(target=lambda:None);t.start();t.join()\nprint(json.dumps(resource.getrlimit(resource.RLIMIT_NPROC)))";
    for mode in [Confine::Workspace, Confine::ReadOnly] {
        let result = isolated_command(home.path(), "/usr/bin/python3", &[], mode)
            .unwrap()
            .args(["-c", code])
            .output()
            .await
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let limits: [u64; 2] = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(limits[0], limits[1]);
        assert!(limits[0] > 512, "{limits:?}");
    }
}
