#[cfg(unix)]
use chrono::{Local, TimeZone};
use hexbot_core::{db, dreaming, runtime_store};

#[test]
fn scheduler_migration_keeps_existing_jobs_in_the_native_database() {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    let conn = runtime_store::open(home.path()).unwrap();
    conn.execute(
        "INSERT INTO native_jobs VALUES ('job','alice','owl','{}')",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO native_job_imports VALUES ('owl')", [])
        .unwrap();
    drop(conn);
    let conn = runtime_store::open(home.path()).unwrap();
    assert_eq!(
        conn.query_row("SELECT job_json FROM native_jobs WHERE id='job'", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "{}"
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM native_job_imports", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(
        !db::open(home.path())
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='native_jobs')",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap()
    );
}

#[cfg(unix)]
#[test]
fn cron_retains_existing_dst_rules() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "cron_dst_fixture", "--nocapture"])
        .env("TZ", "America/New_York")
        .env("HEXBOT_TEST_CRON_DST", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
#[test]
fn cron_dst_fixture() {
    if std::env::var_os("HEXBOT_TEST_CRON_DST").is_none() {
        return;
    }
    let before = Local
        .with_ymd_and_hms(2026, 3, 8, 1, 0, 0)
        .single()
        .unwrap()
        .timestamp() as f64;
    let schedule = dreaming::parse_schedule("30 2 * * *", before).unwrap();
    let next_day = Local
        .with_ymd_and_hms(2026, 3, 9, 2, 30, 0)
        .single()
        .unwrap()
        .timestamp() as f64;
    assert_eq!(
        dreaming::next_run(&schedule, before).unwrap(),
        Some(next_day)
    );
    let overlap = Local.with_ymd_and_hms(2026, 11, 1, 1, 30, 0);
    let a = overlap.earliest().unwrap().timestamp() as f64;
    let b = overlap.latest().unwrap().timestamp() as f64;
    let (first, second) = (a.min(b), a.max(b));
    assert!(second > first);
    let schedule = dreaming::parse_schedule("30 1 * * *", first).unwrap();
    assert_eq!(
        dreaming::next_run(&schedule, first - 1.0).unwrap(),
        Some(first)
    );
    assert_eq!(dreaming::next_run(&schedule, first).unwrap(), Some(second));
}
