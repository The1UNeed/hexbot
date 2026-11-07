#[path = "support/task_readiness.rs"]
mod task_readiness;
use task_readiness::Witness;
fn current() -> Witness {
    serde_json::from_value(serde_json::json!({"pid":3760,"created":"134371833630000000","executable":"C:\\managed\\hexbot.exe","selected":"C:\\managed\\hexbot.exe","owner":"S-1-5-21-500","expectedOwner":"S-1-5-21-500","parent":1072,"enginePid":1072,"instance":"instance-guid","taskPath":"\\task","expectedTaskPath":"\\task","recordHash":"a".repeat(64),"recordEpoch":"134371833640000000","identityPid":3760,"install":"home-id","expectedInstall":"home-id","live":true,"lockHeld":true})).unwrap()
}
#[test]
fn task_readiness_rejects_stale_dead_reused_and_unassociated_pids() {
    let good = current();
    assert!(good.ready(&[5124, 9192]));
    for case in 0..10 {
        let mut bad = good.clone();
        match case {
            0 => bad.pid = 5124, // Previous desktop's retained running record.
            1 => bad.live = false,
            2 => bad.executable = "C:\\foreign.exe".into(),
            3 => bad.owner = "another SID".into(),
            4 => bad.parent += 1,
            5 => bad.instance.clear(),
            6 => bad.task_path = "\\another task".into(),
            7 => bad.identity_pid += 1,
            8 => bad.install = "another home".into(),
            _ => bad.lock_held = false,
        }
        assert!(!bad.ready(&[5124, 9192]), "case {case}: {bad:?}");
    }
    assert!(good.retained(&good, &good.created, true));
    assert!(!good.retained(&good, "reused PID creation time", true));
    assert!(!good.retained(&good, &good.created, false));
    for case in 0..3 {
        let mut changed = good.clone();
        match case {
            0 => changed.record_hash = "b".repeat(64),
            1 => changed.record_epoch.push('1'),
            _ => changed.instance = "replacement-instance".into(),
        }
        assert!(!good.retained(&changed, &good.created, true));
    }
    // Old ready(previous) accepts the logged stale desktop record; new proof
    // rejects it even before checking the retained handle's exit event.
    let mut stale = good;
    stale.pid = 5124;
    assert!(stale.pid != 0);
    assert!(!stale.ready(&[5124]));
}
