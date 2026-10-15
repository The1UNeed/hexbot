//! Pause the actual first native call between its deletion check and polling.
use super::*;
use crate::{catalog, runtime_store, server::App};
use tokio::sync::oneshot;

type Pause = (oneshot::Sender<()>, oneshot::Receiver<()>);
type Pauses = std::sync::Mutex<HashMap<(PathBuf, bool), Pause>>;
fn pauses() -> &'static Pauses {
    static PAUSES: OnceLock<Pauses> = OnceLock::new();
    PAUSES.get_or_init(Default::default)
}
pub(super) async fn checked(home: &Path) {
    pause(home, false).await;
}
pub(super) async fn ready(home: &Path) {
    pause(home, true).await;
}
async fn pause(home: &Path, ready: bool) {
    let pause = pauses().lock().unwrap().remove(&(home.into(), ready));
    if let Some((entered, release)) = pause {
        let _ = entered.send(());
        let _ = release.await;
    }
}
fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
fn fixture() -> (common::TestHome, Arc<App>, String) {
    let home = common::TestHome::new();
    let h = home.path();
    let pi = h.join("pi.cjs");
    fs::write(&pi, r#"#!/usr/bin/env node
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const c=JSON.parse(line);
  if(c.type!=='extension_ui_response') process.stdout.write(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{}})+'\n');
});
"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&pi, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let app = App::new(h.into(), "127.0.0.1:0".parse().unwrap(), pi, None).unwrap();
    let made = catalog::call(
        h,
        "local",
        "hexbot.bots.create",
        &json!({"name":"owl","description":"Fixture"}),
    )
    .unwrap()
    .unwrap();
    let stored = made["section"]["id"].as_str().unwrap().to_owned();
    fs::write(h.join("profiles/owl/config.yaml"), "tools:\n  enabled_toolsets: [tts]\ntts:\n  provider: fixture\n  providers:\n    fixture:\n      type: command\n      command: /bin/sh\n      args: ['-c', 'cat >/dev/null; printf audio > \"$HEXBOT_TTS_OUTPUT\"']\n").unwrap();
    runtime_store::open(h)
        .unwrap()
        .execute(
            "INSERT INTO native_sessions VALUES(?,'local','owl','frozen',?)",
            rusqlite::params![stored, json!({"cwd":home.workspace()}).to_string()],
        )
        .unwrap();
    (home, app, stored)
}
async fn paused_call(
    home: &Path,
    stored: &str,
    ready_to_poll: bool,
) -> (tokio::task::JoinHandle<Result<Value>>, oneshot::Sender<()>) {
    let (entered, ready) = oneshot::channel();
    let (release, resume) = oneshot::channel();
    pauses()
        .lock()
        .unwrap()
        .insert((home.into(), ready_to_poll), (entered, resume));
    let home = home.to_owned();
    let stored = stored.to_owned();
    let call = tokio::spawn(async move {
        call(
            &home,
            "local",
            "owl",
            &stored,
            "text_to_speech",
            &json!({"text":"fixture"}),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), ready)
        .await
        .unwrap()
        .unwrap();
    (call, release)
}

#[test]
fn first_native_call_cannot_run_after_retained_public_delete() {
    first_native_speech_call(false);
}
#[test]
fn first_native_call_cannot_run_after_purged_public_delete() {
    first_native_speech_call(true);
}
fn first_native_speech_call(purge: bool) {
    let (home, app, stored) = fixture();
    run(async {
        let (call, release) = paused_call(home.path(), &stored, false).await;
        assert_eq!(
            app.call(
                "local",
                "hexbot.sections.delete",
                &json!({"id":stored,"purge_memory":purge})
            )
            .await
            .unwrap(),
            json!({"deleted":true})
        );
        release.send(()).unwrap();
        let result = call.await.unwrap();
        assert!(
            !home.path().join("profiles/owl/artifacts/audio").exists(),
            "cancelled request was polled: {result:?}"
        );
        assert_eq!(result.unwrap_err().code, 5201);
        assert_eq!(
            speech_call(home.path(), &stored).await.unwrap_err().code,
            4001
        );
        app.shutdown().await;
    });
}
async fn speech_call(home: &Path, stored: &str) -> Result<Value> {
    call(
        home,
        "local",
        "owl",
        stored,
        "text_to_speech",
        &json!({"text":"fixture"}),
    )
    .await
}

#[test]
fn ready_native_cancellation_precedes_effects_and_healthy_close_reopens() {
    // Both branches can be ready. The request creates its output directory on
    // its first poll, before awaiting the local speech subprocess.
    for _ in 0..32 {
        let (home, app, stored) = fixture();
        run(async {
            let (call, release) = paused_call(home.path(), &stored, true).await;
            close_session(home.path(), &stored).await;
            release.send(()).unwrap();
            let result = call.await.unwrap();
            assert!(
                !home.path().join("profiles/owl/artifacts/audio").exists(),
                "ready cancellation lost to request polling: {result:?}"
            );
            assert_eq!(result.unwrap_err().code, 5201);
            let reopened = speech_call(home.path(), &stored).await.unwrap();
            assert_eq!(
                fs::read(reopened["file_path"].as_str().unwrap()).unwrap(),
                b"audio"
            );
            close_session(home.path(), &stored).await;
            app.shutdown().await;
        });
    }
}

#[test]
fn native_stop_and_session_close_cancel_then_allow_healthy_reopen() {
    for stop in [false, true] {
        let (home, app, stored) = fixture();
        run(async {
            // Let Runtime create complete frozen options for this Pi control.
            runtime_store::open(home.path())
                .unwrap()
                .execute("DELETE FROM native_sessions WHERE stored_id=?", [&stored])
                .unwrap();
            app.call("local", "hexbot.sections.open", &json!({"id":stored}))
                .await
                .unwrap();
            let frozen = common::rows(
                &runtime_store::open(home.path()).unwrap(),
                "SELECT prompt,options FROM native_sessions WHERE stored_id=?",
                &[&stored],
            )
            .unwrap();
            let (call, release) = paused_call(home.path(), &stored, true).await;
            if stop {
                assert!(
                    app.runtime
                        .interrupt_stored("local", &stored)
                        .await
                        .unwrap()
                );
            } else {
                app.call("local", "hexbot.sections.close", &json!({"id":stored}))
                    .await
                    .unwrap();
            }
            release.send(()).unwrap();
            assert_eq!(call.await.unwrap().unwrap_err().code, 5201);
            assert!(!home.path().join("profiles/owl/artifacts/audio").exists());
            app.call("local", "hexbot.sections.open", &json!({"id":stored}))
                .await
                .unwrap();
            let result = speech_call(home.path(), &stored).await.unwrap();
            assert_eq!(
                fs::read(result["file_path"].as_str().unwrap()).unwrap(),
                b"audio"
            );
            assert_eq!(
                common::rows(
                    &runtime_store::open(home.path()).unwrap(),
                    "SELECT prompt,options FROM native_sessions WHERE stored_id=?",
                    &[&stored]
                )
                .unwrap(),
                frozen
            );
            app.shutdown().await;
        });
    }
}

#[test]
fn closing_unopened_native_session_checks_owner() {
    let (home, app, stored) = fixture();
    run(async {
        let (call, release) = paused_call(home.path(), &stored, true).await;
        assert_eq!(
            app.runtime
                .close_stored("bob", &stored)
                .await
                .unwrap_err()
                .code,
            4302
        );
        release.send(()).unwrap();
        let result = call.await.unwrap().unwrap();
        assert_eq!(
            fs::read(result["file_path"].as_str().unwrap()).unwrap(),
            b"audio"
        );
        app.runtime.close_stored("local", &stored).await.unwrap();
        app.shutdown().await;
    });
}
