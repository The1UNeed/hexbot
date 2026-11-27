use super::*;
use crate::services::{self, Staged};
use rusqlite::Connection;

fn trial(status: Status, attempts: u32) -> Trial {
    Trial {
        id: "u1".into(),
        from_version: "1.0.0".into(),
        to_version: "1.1.0".into(),
        from_executable: "/runtime/native/1.0.0-a/hexbot".into(),
        from_record: json!({}),
        to_executable: "/runtime/native/1.1.0-b/hexbot".into(),
        to_built_at: 200,
        snapshot: "/runtime/update-snapshots/u1".into(),
        attempts,
        status,
        reason: None,
        started_at: String::new(),
    }
}

#[test]
fn a_starting_build_decides_from_the_trial_file() {
    let to = Path::new("/runtime/native/1.1.0-b/hexbot");
    let other = Path::new("/runtime/native/1.1.0-c/hexbot");
    // The new build's first start is its trial; a second start is a crash loop.
    assert_eq!(
        decide(&trial(Status::Trying, 1), "1.1.0", Some(to)),
        Start::Trial
    );
    assert_eq!(
        decide(&trial(Status::Trying, 2), "1.1.0", Some(to)),
        Start::Fail("crashed while starting")
    );
    // A rollback that didn't finish switching is repeated, unless setup
    // selected another build meanwhile.
    assert_eq!(
        decide(&trial(Status::Failed, 1), "1.1.0", Some(to)),
        Start::Fail("didn't start")
    );
    assert_eq!(
        decide(&trial(Status::Failed, 1), "1.1.0", Some(other)),
        Start::Superseded
    );
    // The old build restores, whether the trial failed or never switched.
    for status in [Status::Failed, Status::Trying] {
        assert_eq!(decide(&trial(status, 1), "1.0.0", Some(to)), Start::Restore);
    }
    // Any other build leaves the snapshot alone.
    assert_eq!(
        decide(&trial(Status::Trying, 1), "1.2.0", None),
        Start::Superseded
    );
}

#[test]
fn update_ids_are_plain_names() {
    assert!(valid_id("2f6c1e0a-run_1"));
    for id in ["", "..", "../x", "a/b", "a b", &"x".repeat(65)] {
        assert!(!valid_id(id), "{id}");
    }
}

#[test]
fn an_update_is_refused_while_there_is_no_room_for_a_snapshot() {
    assert!(check_space(100, 100).is_ok());
    let error = check_space(10 * 1024 * 1024, 1024).unwrap_err();
    assert_eq!(error.code, 4216);
    assert!(error.message.contains("10 MB"), "{}", error.message);
    let home = tempfile::tempdir().unwrap();
    fs::write(home.path().join("hexbot.db"), vec![0; 300]).unwrap();
    fs::write(home.path().join("hexbot.db-wal"), vec![0; 100]).unwrap();
    fs::write(home.path().join(CONFIG), vec![0; 50]).unwrap();
    // Twice everything, so VACUUM INTO has room; missing files count as 0.
    assert_eq!(space_needed(home.path()), 900);
}

#[test]
fn the_next_launcher_never_inherits_a_bundle_s_paths() {
    let roots = vec![
        PathBuf::from("/home/u/.hexbot/runtime/native"),
        PathBuf::from("/private/home/u/.hexbot/runtime/native"),
    ];
    let os = |s: &str| OsString::from(s);
    let path = std::env::join_paths([
        "/private/home/u/.hexbot/runtime/native/1.0.0-a/bin",
        "/home/u/.hexbot/bin",
        "/usr/bin",
    ])
    .unwrap();
    let changes = launcher_env(
        [
            (
                os("HEXBOT_WEB_DIST"),
                os("/home/u/.hexbot/runtime/native/1.0.0-a/web"),
            ),
            (
                os("HEXBOT_BUNDLED_SKILLS"),
                os("/private/home/u/.hexbot/runtime/native/1.0.0-a/skills"),
            ),
            (
                os("HEXBOT_PI_EXECUTABLE"),
                os("/home/u/.hexbot/runtime/native/1.0.0-a/pi/hexbot-pi"),
            ),
            // A path the user set elsewhere stays.
            (os("HEXBOT_WEB_DIST_OTHER"), os("/srv/web")),
            (os("PATH"), path),
        ],
        &roots,
    );
    let kept = std::env::join_paths(["/home/u/.hexbot/bin", "/usr/bin"]).unwrap();
    assert_eq!(
        changes,
        vec![
            (os("HEXBOT_WEB_DIST"), None),
            (os("HEXBOT_BUNDLED_SKILLS"), None),
            (os("HEXBOT_PI_EXECUTABLE"), None),
            (os("PATH"), Some(kept)),
        ]
    );
    // A web app outside the runtime is the user's choice.
    assert!(launcher_env([(os("HEXBOT_WEB_DIST"), os("/srv/web"))], &roots).is_empty());
}

fn rows(home: &Path) -> Vec<String> {
    let conn = Connection::open(home.join("hexbot.db")).unwrap();
    let mut stmt = conn.prepare("SELECT v FROM t ORDER BY v").unwrap();
    stmt.query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

#[test]
fn a_restore_puts_back_the_data_and_drops_the_new_build_s_log() {
    let home = tempfile::tempdir().unwrap();
    let home = home.path();
    let conn = Connection::open(home.join("hexbot.db")).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch("CREATE TABLE t(v TEXT); INSERT INTO t VALUES('old');")
        .unwrap();
    fs::write(home.join(CONFIG), "a: 1\n").unwrap();
    let snapshot = snapshot(home, "u1").unwrap();
    assert!(snapshot.join(COMPLETE).is_file());
    // The new build migrates and writes; its log is still open.
    conn.execute_batch("INSERT INTO t VALUES('new'); CREATE TABLE migrated(x);")
        .unwrap();
    fs::write(home.join(CONFIG), "a: 2\n").unwrap();
    // It also created a database the old build never had.
    Connection::open(home.join("hexbot-runtime.db"))
        .unwrap()
        .execute_batch("CREATE TABLE r(x);")
        .unwrap();
    assert!(home.join("hexbot.db-wal").exists());
    for _ in 0..2 {
        restore(home, &snapshot).unwrap();
        assert!(!home.join("hexbot.db-wal").exists());
        assert!(!home.join("hexbot.db-shm").exists());
        assert_eq!(rows(home), vec!["old"]);
        assert_eq!(fs::read_to_string(home.join(CONFIG)).unwrap(), "a: 1\n");
        assert!(!home.join("hexbot-runtime.db").exists());
    }
    // The new build never closed its connection cleanly.
    std::mem::forget(conn);
    // A snapshot without its marker is never used.
    fs::remove_file(snapshot.join(COMPLETE)).unwrap();
    assert_eq!(restore(home, &snapshot).unwrap_err().code, 5243);
}

/// A home whose runtime selects `from` (built at 100), with a database.
struct Home {
    dir: tempfile::TempDir,
    native: PathBuf,
}
impl Home {
    fn new(from: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let native = services::native_directory(dir.path()).unwrap();
        let home = Self { dir, native };
        let bundle = home.native.join(format!("{from}-a"));
        home.bundle(&bundle, from, 100);
        services::activate_native(&home.native, from, &bundle.join("hexbot")).unwrap();
        let conn = Connection::open(home.path().join("hexbot.db")).unwrap();
        conn.execute_batch("CREATE TABLE t(v TEXT); INSERT INTO t VALUES('old');")
            .unwrap();
        home
    }
    fn path(&self) -> &Path {
        self.dir.path()
    }
    fn bundle(&self, dir: &Path, version: &str, built_at: u64) -> Value {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("hexbot"), version).unwrap();
        let manifest = json!({"version":version,"builtAt":built_at});
        fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
        manifest
    }
    fn stage(&self, version: &str, built_at: u64) -> Staged {
        let dir = self.native.join(format!(".staged-{version}-x{built_at}"));
        let manifest = self.bundle(&dir, version, built_at);
        Staged {
            digests: services::staged_digests(&dir).unwrap(),
            dir,
            version: version.into(),
            entrypoint: "hexbot".into(),
            manifest,
        }
    }
    fn selected(&self) -> String {
        fs::read_to_string(services::selected_native_executable(self.path()).unwrap()).unwrap()
    }
    fn record(&self) -> Value {
        serde_json::from_slice(
            &fs::read(self.native.with_file_name("native-current.json")).unwrap(),
        )
        .unwrap()
    }
}

#[test]
fn a_failed_trial_rolls_back_to_the_old_build_and_its_data() {
    let current = crate::version();
    let home = Home::new(&current);
    let next = services::begin_update(home.path(), home.stage("99.0.0", 200), "u1").unwrap();
    // The switch happened, with the trial file and the snapshot written first.
    assert_eq!(home.selected(), "99.0.0");
    let trial = read_trial(home.path()).unwrap().unwrap();
    assert_eq!(trial.to_executable, next);
    assert_eq!((trial.status, trial.attempts), (Status::Trying, 0));
    assert_eq!(trial.from_version, current);
    assert!(trial.snapshot.join(COMPLETE).is_file());
    // The new build migrates, then fails.
    Connection::open(home.path().join("hexbot.db"))
        .unwrap()
        .execute_batch("INSERT INTO t VALUES('new');")
        .unwrap();
    mark_failed(home.path(), &trial, "crashed while starting").unwrap();
    assert_eq!(home.selected(), current);
    assert_eq!(home.record()["version"], json!(current));
    // The failed build's time stays the floor, so it is never tried again.
    assert_eq!(home.record()["builtAt"], json!(200));
    // The old build starts and restores before it opens a database.
    assert!(on_start(home.path()).unwrap().is_none());
    assert_eq!(rows(home.path()), vec!["old"]);
    assert!(read_trial(home.path()).unwrap().is_none());
    assert!(!trial.snapshot.exists());
    let outcome = outcome(home.path()).unwrap();
    assert_eq!(outcome["id"], "u1");
    assert_eq!(outcome["status"], "rolled-back");
    assert_eq!(outcome["reason"], "crashed while starting");
    assert_eq!(
        services::begin_update(home.path(), home.stage("99.0.0", 200), "u2")
            .unwrap_err()
            .code,
        4212
    );
    assert_eq!(home.selected(), current);
}

#[test]
fn a_trial_that_starts_commits_and_cleans_up() {
    let home = Home::new("0.0.1");
    services::begin_update(home.path(), home.stage(&crate::version(), 200), "u1").unwrap();
    let guard = on_start(home.path()).unwrap().expect("on trial");
    // This start is counted before anything else runs.
    assert_eq!(read_trial(home.path()).unwrap().unwrap().attempts, 1);
    guard.commit().unwrap();
    guard.commit().unwrap();
    assert!(read_trial(home.path()).unwrap().is_none());
    assert!(!home.path().join("runtime/update-snapshots").exists());
    assert_eq!(outcome(home.path()).unwrap()["status"], "committed");
    assert_eq!(home.selected(), crate::version());
    // With no trial, a later start clears any snapshot a failure left.
    fs::create_dir_all(home.path().join("runtime/update-snapshots/old")).unwrap();
    assert!(on_start(home.path()).unwrap().is_none());
    assert!(!home.path().join("runtime/update-snapshots").exists());
}

#[test]
fn a_rollback_never_undoes_a_build_setup_selected_meanwhile() {
    let current = crate::version();
    let home = Home::new(&current);
    services::begin_update(home.path(), home.stage("99.0.0", 200), "u1").unwrap();
    let trial = read_trial(home.path()).unwrap().unwrap();
    let newer = home.native.join("99.1.0-c");
    home.bundle(&newer, "99.1.0", 300);
    services::activate_native(&home.native, "99.1.0", &newer.join("hexbot")).unwrap();
    mark_failed(home.path(), &trial, "didn't start").unwrap();
    assert_eq!(home.selected(), "99.1.0");
    assert_eq!(
        read_trial(home.path()).unwrap().unwrap().status,
        Status::Failed
    );
}

#[test]
fn an_update_that_fails_before_the_switch_runs_what_is_selected() {
    let current = crate::version();
    let home = Home::new(&current);
    // Setup published a newer build after this one was staged.
    let staged = home.stage("99.0.0", 200);
    let newer = home.native.join("99.1.0-c");
    home.bundle(&newer, "99.1.0", 300);
    services::activate_native(&home.native, "99.1.0", &newer.join("hexbot")).unwrap();
    let error = services::begin_update(home.path(), staged, "u1").unwrap_err();
    assert_eq!(error.code, 4212);
    assert!(read_trial(home.path()).unwrap().is_none());
    let next = abandon(home.path(), "u1", "99.0.0", &error.message).unwrap();
    assert_eq!(fs::read_to_string(next).unwrap(), "99.1.0");
    assert_eq!(outcome(home.path()).unwrap()["status"], "failed");
    assert!(!home.path().join("runtime/update-snapshots/u1").exists());
    // A staged file that changed is refused too.
    let staged = home.stage("99.2.0", 400);
    fs::write(staged.dir.join("hexbot"), "tampered").unwrap();
    assert_eq!(
        services::begin_update(home.path(), staged, "u2")
            .unwrap_err()
            .code,
        5243
    );
    assert_eq!(home.selected(), "99.1.0");
}

#[test]
fn a_switch_cut_off_between_record_and_link_is_repaired() {
    let current = crate::version();
    let home = Home::new(&current);
    let before = home.record();
    services::begin_update(home.path(), home.stage("99.0.0", 200), "u1").unwrap();
    let trial = read_trial(home.path()).unwrap().unwrap();
    // The record names the new build while the link still selects the old one.
    let link = home.native.with_file_name("native-executable");
    fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&trial.from_executable, &link).unwrap();
    assert_eq!(home.record()["version"], "99.0.0");
    let next = abandon(home.path(), "u1", "99.0.0", "exec failed").unwrap();
    assert_eq!(fs::read_to_string(next).unwrap(), current);
    assert_eq!(home.record()["version"], before["version"]);
    assert_eq!(home.record()["executable"], before["executable"]);
    assert_eq!(home.record()["builtAt"], json!(200));
}

#[test]
fn leftover_stages_go_only_at_start() {
    let home = Home::new("1.0.0");
    let staged = home.stage("1.1.0", 200);
    services::prune_current_native(home.path(), false).unwrap();
    assert!(staged.dir.is_dir());
    services::prune_current_native(home.path(), true).unwrap();
    assert!(!staged.dir.exists());
    assert_eq!(home.selected(), "1.0.0");
}

#[test]
fn an_unreadable_trial_file_never_stops_a_start() {
    let home = Home::new("1.0.0");
    fs::write(home.path().join("runtime/update-trial.json"), "{broken").unwrap();
    assert!(on_start(home.path()).unwrap().is_none());
    assert!(!home.path().join("runtime/update-trial.json").exists());
    assert!(home.path().join("runtime/update-trial.json.bad").is_file());
}
