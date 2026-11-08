//! Pause real profile mutations at their write and catalog boundaries.
use super::*;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, mpsc};
use std::time::Duration;

struct Hooks {
    before_write: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
    configured: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
    blocked: Option<mpsc::Sender<bool>>,
}

pub(super) fn before_write(home: &Path) {
    let pause = hooks()
        .lock()
        .unwrap()
        .get_mut(home)
        .and_then(|h| h.before_write.take());
    if let Some((entered, resume)) = pause {
        let _ = entered.send(());
        let _ = resume.recv();
    }
}

fn hooks() -> &'static Mutex<HashMap<PathBuf, Hooks>> {
    static HOOKS: OnceLock<Mutex<HashMap<PathBuf, Hooks>>> = OnceLock::new();
    HOOKS.get_or_init(Default::default)
}

pub(crate) fn blocked(home: &Path) {
    if let Some(sender) = hooks()
        .lock()
        .unwrap()
        .get_mut(home)
        .and_then(|h| h.blocked.take())
    {
        let _ = sender.send(false);
    }
}

pub(super) fn configured(home: &Path) {
    let pause = hooks()
        .lock()
        .unwrap()
        .get_mut(home)
        .and_then(|h| h.configured.take());
    if let Some((entered, resume)) = pause {
        let _ = entered.send(());
        let _ = resume.recv();
    }
}

struct Pause {
    home: PathBuf,
    resume: Option<mpsc::Sender<()>>,
}

impl Drop for Pause {
    fn drop(&mut self) {
        if let Some(resume) = self.resume.take() {
            let _ = resume.send(());
        }
        hooks().lock().unwrap().remove(&self.home);
    }
}

fn concurrent_updates(method: &str) {
    let home = common::TestHome::new();
    let h = home.path();
    db::migrate(h).unwrap();
    crate::settings::update(h, "local", &json!({"workspace_dir":home.workspace()})).unwrap();
    create_bot(
        h,
        "local",
        &json!({"name":"owl", "description":"Initial", "tools":[]}),
    )
    .unwrap();
    let (entered, configured) = mpsc::channel();
    let (resume, release) = mpsc::channel();
    hooks().lock().unwrap().insert(
        h.into(),
        Hooks {
            before_write: None,
            configured: Some((entered, release)),
            blocked: None,
        },
    );

    std::thread::scope(|scope| {
        // Released before scope joins on an assertion failure as well.
        let mut pause = Pause {
            home: h.into(),
            resume: Some(resume),
        };
        let first = scope.spawn(|| {
            update_bot(
                h,
                "local",
                &json!({
                    "name":"owl", "description":"First", "model":"model-first",
                    "approval_mode":"manual", "tools":["files"]
                }),
            )
        });
        configured.recv_timeout(Duration::from_secs(10)).unwrap();
        let (finished, done) = mpsc::channel();
        hooks().lock().unwrap().get_mut(h).unwrap().blocked = Some(finished.clone());
        let second = scope.spawn(move || {
            let patch = if method == "profiles.configure" {
                json!({"name":"owl", "description":"Second", "model":"model-second"})
            } else {
                json!({"name":"owl", "description":"Second", "model":"model-second", "approval_mode":"off", "tools":[]})
            };
            let result = call(h, "local", method, &patch).unwrap();
            let _ = finished.send(true);
            result
        });
        // A second update must wait while the first has uncommitted profile
        // changes. Before the fix it finishes here and its profile is then
        // paired with the first update's late database commit.
        let overtook = done.recv_timeout(Duration::from_secs(10)).unwrap();
        pause.resume.take().unwrap().send(()).unwrap();
        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();

        let row = bot_row(h, "local", "owl").unwrap();
        let meta: Value = serde_yaml::from_str(
            &fs::read_to_string(profile(h, "owl").unwrap().join("profile.yaml")).unwrap(),
        )
        .unwrap();
        let cfg = config(h, "owl").unwrap();
        println!(
            "{}",
            json!({"method":method,"second_update_overtook":overtook,"catalog_description":row["description"],"profile_description":meta["description"],"model":cfg["model"]["default"],"catalog_approval_mode":row["approval_mode"],"profile_approval_mode":cfg["hexbot"]["approval_mode"]})
        );
        assert_eq!(row["description"], meta["description"]);
        assert_eq!(row["description"], "Second");
        assert_eq!(cfg["model"]["default"], "model-second");
        assert_eq!(row["approval_mode"], cfg["hexbot"]["approval_mode"]);
        assert!(
            !overtook,
            "a concurrent update passed the unfinished catalog commit"
        );
    });
}

#[test]
fn bot_updates_keep_profile_and_catalog_in_the_same_order() {
    concurrent_updates("hexbot.bots.update");
}

#[test]
fn legacy_profile_updates_wait_for_bot_catalog_commits() {
    concurrent_updates("profiles.configure");
}

fn update_during_delete(method: &str, reuse: bool, public: bool) {
    let home = common::TestHome::new();
    let h = home.path();
    db::migrate(h).unwrap();
    crate::settings::update(h, "local", &json!({"workspace_dir":home.workspace()})).unwrap();
    create_bot(
        h,
        "local",
        &json!({"name":"owl", "description":"Original", "tools":[]}),
    )
    .unwrap();
    // Construct outside Tokio, so no background description tasks run at startup.
    let app = public.then(|| {
        crate::server::App::new(
            h.into(),
            "127.0.0.1:0".parse().unwrap(),
            h.join("unused-pi"),
            None,
        )
        .unwrap()
    });
    let runtime = public.then(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .unwrap()
    });
    let invoke = |method: &str, patch: &Value| {
        if let Some(app) = &app {
            runtime
                .as_ref()
                .unwrap()
                .block_on(app.call("local", method, patch))
        } else {
            call(h, "local", method, patch).unwrap()
        }
    };
    let (entered, before_write) = mpsc::channel();
    let (resume, release) = mpsc::channel();
    hooks().lock().unwrap().insert(
        h.into(),
        Hooks {
            before_write: Some((entered, release)),
            configured: None,
            blocked: None,
        },
    );

    std::thread::scope(|scope| {
        let mut pause = Pause {
            home: h.into(),
            resume: Some(resume),
        };
        let update = scope.spawn(|| {
            let patch = if method == "profiles.set_asset" {
                json!({"name":"owl", "asset":"avatar", "data":"data:image/png;base64,iVBORw0KGgo="})
            } else {
                json!({"name":"owl", "description":"Stale update", "model":"stale-model"})
            };
            invoke(method, &patch)
        });
        before_write.recv_timeout(Duration::from_secs(10)).unwrap();
        let (finished, done) = mpsc::channel();
        hooks().lock().unwrap().get_mut(h).unwrap().blocked = Some(finished.clone());
        let invoke = &invoke;
        let deletion = scope.spawn(move || {
            let result = invoke("hexbot.bots.delete", &json!({"name":"owl"})).and_then(|deleted| {
                assert_eq!(deleted["deleted"], true);
                assert!(!profile(h, "owl")?.exists());
                if reuse {
                    invoke(
                        "hexbot.bots.create",
                        &json!({"name":"owl", "description":"Replacement", "model":"replacement-model", "tools":[]}),
                    )?;
                }
                Ok(())
            });
            let _ = finished.send(true);
            result
        });
        // Completion or the update lock's blocked signal establishes the
        // ordering without timing or sleeps. Always release before joining.
        let deletion_overtook = done.recv_timeout(Duration::from_secs(10)).unwrap();
        pause.resume.take().unwrap().send(()).unwrap();
        let update_result = update.join().unwrap();
        deletion.join().unwrap().unwrap();
        let dir = profile(h, "owl").unwrap();
        let recreate = if !reuse {
            Some(create_bot(h, "local", &json!({"name":"owl", "tools":[]})))
        } else {
            None
        };
        let row = bot_row(h, "local", "owl").ok();
        let cfg = config(h, "owl").unwrap();
        println!(
            "{}",
            json!({"method":method,"reuse":reuse,"public":public,"deletion_overtook":deletion_overtook,
                "update_ok":update_result.is_ok(),"update_error":update_result.as_ref().err().map(|e|e.to_string()),
                "profile_exists":dir.exists(),"recreate_ok":recreate.as_ref().map(|r|r.is_ok()),
                "recreate_error":recreate.as_ref().and_then(|r|r.as_ref().err()).map(|e|e.to_string()),
                "description":row.as_ref().map(|r|&r["description"]),"model":cfg["model"]["default"],"avatar":avatar(h,"owl").unwrap()})
        );
        if reuse {
            assert_eq!(row.unwrap()["description"], "Replacement");
            assert_eq!(cfg["model"]["default"], "replacement-model");
            assert!(avatar(h, "owl").unwrap().is_null());
        } else {
            assert!(
                recreate.unwrap().is_ok(),
                "an update recreated a deleted bot's profile and blocked name reuse"
            );
        }
    });
}

#[test]
fn bot_update_cannot_recreate_a_deleted_profile() {
    update_during_delete("hexbot.bots.update", false, false);
}

#[test]
fn legacy_update_cannot_recreate_a_deleted_profile() {
    update_during_delete("profiles.configure", false, false);
}

#[test]
fn bot_update_cannot_change_a_reused_name() {
    update_during_delete("hexbot.bots.update", true, false);
}

#[test]
fn legacy_update_cannot_change_a_reused_name() {
    update_during_delete("profiles.configure", true, false);
}

#[test]
fn legacy_avatar_cannot_recreate_a_deleted_profile() {
    update_during_delete("profiles.set_asset", false, false);
}

#[test]
fn legacy_avatar_cannot_change_a_reused_name() {
    update_during_delete("profiles.set_asset", true, false);
}

#[test]
fn public_update_cannot_change_a_reused_name() {
    update_during_delete("hexbot.bots.update", true, true);
}

#[test]
fn public_legacy_update_cannot_change_a_reused_name() {
    update_during_delete("profiles.configure", true, true);
}

#[test]
fn public_avatar_cannot_change_a_reused_name() {
    update_during_delete("profiles.set_asset", true, true);
}

fn invalid_legacy_field(key: &str) {
    for invalid in [json!(true), json!([12]), Value::Null, json!("bad")] {
        let home = common::TestHome::new();
        let h = home.path();
        db::migrate(h).unwrap();
        create_bot(
            h,
            "local",
            &json!({"name":"owl", "model":"original-model", "persona":"Original soul", "description":"Original description", "tools":[]}),
        )
        .unwrap();
        let dir = profile(h, "owl").unwrap();
        let before_config = fs::read(dir.join("config.yaml")).unwrap();
        let before_soul = fs::read(dir.join("SOUL.md")).unwrap();
        let before_meta = fs::read(dir.join("profile.yaml")).unwrap();
        let before_row = bot_row(h, "local", "owl").unwrap();
        let mut patch = json!({"name":"owl", "model":"changed-model", "soul":"Changed soul", "description":"Changed description"});
        patch[key] = invalid.clone();
        let error = call(h, "local", "profiles.configure", &patch)
            .unwrap()
            .unwrap_err();
        println!(
            "{}",
            json!({"invalid_field":key,"invalid":invalid,"error_code":error.code,
                "model":config(h,"owl").unwrap()["model"]["default"],
                "soul":fs::read_to_string(dir.join("SOUL.md")).unwrap(),
                "profile_description":serde_yaml::from_slice::<Value>(&fs::read(dir.join("profile.yaml")).unwrap()).unwrap()["description"],
                "catalog_description":bot_row(h,"local","owl").unwrap()["description"]})
        );
        assert_eq!(error.code, 4202);
        assert_eq!(fs::read(dir.join("config.yaml")).unwrap(), before_config);
        assert_eq!(fs::read(dir.join("SOUL.md")).unwrap(), before_soul);
        assert_eq!(fs::read(dir.join("profile.yaml")).unwrap(), before_meta);
        assert_eq!(bot_row(h, "local", "owl").unwrap(), before_row);
    }
}

#[test]
fn invalid_disabled_skills_cannot_partially_configure_a_profile() {
    invalid_legacy_field("disabled_skills");
}

#[test]
fn invalid_enabled_toolsets_cannot_partially_configure_a_profile() {
    invalid_legacy_field("enabled_toolsets");
}

#[test]
fn legacy_string_lists_are_applied_with_the_other_profile_fields() {
    let home = common::TestHome::new();
    let h = home.path();
    db::migrate(h).unwrap();
    create_bot(h, "local", &json!({"name":"owl", "tools":[]})).unwrap();
    let result = call(
        h,
        "local",
        "profiles.configure",
        &json!({"name":"owl", "model":"changed-model", "soul":"Changed soul", "description":"Changed description",
            "disabled_skills":["one","two"], "enabled_toolsets":["file","terminal"]}),
    )
    .unwrap()
    .unwrap();
    let cfg = config(h, "owl").unwrap();
    assert_eq!(result["applied"]["skills"], true);
    assert_eq!(result["applied"]["tools"], true);
    assert_eq!(cfg["model"]["default"], "changed-model");
    assert_eq!(cfg["skills"]["disabled"], json!(["one", "two"]));
    assert_eq!(
        cfg["tools"]["enabled_toolsets"],
        json!(["file", "terminal"])
    );
    assert_eq!(
        fs::read_to_string(profile(h, "owl").unwrap().join("SOUL.md")).unwrap(),
        "Changed soul"
    );
    assert_eq!(
        bot_row(h, "local", "owl").unwrap()["description"],
        "Changed description"
    );
}
