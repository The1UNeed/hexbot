use std::{fs, path::Path};

use crate::{db, memory::MemoryStore};
use serde_json::json;

fn setup() -> (tempfile::TempDir, MemoryStore) {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    let conn = db::open(home.path()).unwrap();
    conn.execute_batch(
        "INSERT INTO users(id,display_name,role,created_at) VALUES ('alice','Alice','member',0),('bob','Bob','member',0);
         INSERT INTO bots(name,owner_id) VALUES ('owl','alice'),('fox','bob');"
    ).unwrap();
    let store = MemoryStore::new(home.path().to_path_buf()).with_managed_dir(None);
    (home, store)
}

fn write_config(home: &Path, text: &str) {
    let dir = home.join("profiles/owl");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("config.yaml"), text).unwrap();
}

#[test]
fn reads_existing_python_files_and_writes_compatible_locations() {
    let (home, store) = setup();
    assert_eq!(
        store.get_user("alice").unwrap(),
        json!({"text":"", "cap":2000, "updated_at":null})
    );
    assert_eq!(
        store.get_bot("alice", "owl").unwrap(),
        json!({"memory_md":"", "cap":2200})
    );
    let user = store.set_user("alice", "Tea and 中文").unwrap();
    assert!(user["updated_at"].as_f64().unwrap() > 0.0);
    assert_eq!(
        fs::read_to_string(home.path().join("users/alice/user.md")).unwrap(),
        "Tea and 中文"
    );
    store.set_bot("alice", "owl", "A note").unwrap();
    let memory = home.path().join("profiles/owl/memories/MEMORY.md");
    assert_eq!(fs::read_to_string(&memory).unwrap(), "A note");
    fs::write(memory, "Written by Python").unwrap();
    assert_eq!(
        store.get_bot("alice", "owl").unwrap()["memory_md"],
        "Written by Python"
    );
    assert_eq!(store.set_user("alice", "").unwrap()["text"], "");
}

#[test]
fn unicode_caps_count_codepoints_and_preserve_previous_content() {
    let (_home, store) = setup();
    let user = "🦉".repeat(2000);
    store.set_user("alice", &user).unwrap();
    assert_eq!(
        store
            .set_user("alice", &(user.clone() + "a"))
            .unwrap_err()
            .code,
        4221
    );
    assert_eq!(store.get_user("alice").unwrap()["text"], user);
    let memory = "界".repeat(2200);
    store.set_bot("alice", "owl", &memory).unwrap();
    assert_eq!(
        store
            .set_bot("alice", "owl", &(memory.clone() + "a"))
            .unwrap_err()
            .code,
        4221
    );
    assert_eq!(store.get_bot("alice", "owl").unwrap()["memory_md"], memory);
}

#[test]
fn enforces_active_identity_and_ownership_even_for_admins() {
    let (home, store) = setup();
    store.set_bot("alice", "owl", "private").unwrap();
    for caller in ["bob", "local", "missing"] {
        assert_eq!(store.get_bot(caller, "owl").unwrap_err().code, 4302);
        assert_eq!(
            store.set_bot(caller, "owl", "overwrite").unwrap_err().code,
            4302
        );
    }
    assert_eq!(store.get_user("missing").unwrap_err().code, 4302);
    assert_eq!(store.set_user("missing", "new").unwrap_err().code, 4302);
    assert_eq!(store.get_bot("alice", "unknown").unwrap_err().code, 4205);
    assert_eq!(
        store.set_bot("alice", "unknown", "new").unwrap_err().code,
        4205
    );
    assert!(!home.path().join("profiles/unknown").exists());
    db::open(home.path())
        .unwrap()
        .execute("UPDATE users SET disabled_at=1 WHERE id='alice'", [])
        .unwrap();
    assert_eq!(store.get_user("alice").unwrap_err().code, 4302);
    assert_eq!(store.set_user("alice", "x").unwrap_err().code, 4302);
    assert_eq!(store.get_bot("alice", "owl").unwrap_err().code, 4302);
    assert_eq!(store.set_bot("alice", "owl", "x").unwrap_err().code, 4302);
    assert_eq!(
        fs::read_to_string(home.path().join("profiles/owl/memories/MEMORY.md")).unwrap(),
        "private"
    );
}

#[test]
fn honors_profile_config_caps_with_default_fallback() {
    let (home, store) = setup();
    for yaml in [
        "memory:\n  memory_char_limit: 3\n",
        "memory:\n  memory_char_limit: '3'\n",
        "memory:\n  memory_char_limit: 3.9\n",
    ] {
        write_config(home.path(), yaml);
        assert_eq!(store.set_bot("alice", "owl", "🦉界a").unwrap()["cap"], 3);
        assert_eq!(
            store.set_bot("alice", "owl", "four").unwrap_err().code,
            4221
        );
    }
    for yaml in [
        "memory: nope",
        "memory:\n  memory_char_limit: invalid\n",
        "{}",
    ] {
        write_config(home.path(), yaml);
        assert_eq!(store.get_bot("alice", "owl").unwrap()["cap"], 2200);
    }
    write_config(home.path(), "memory:\n  memory_char_limit: true\n");
    assert_eq!(store.get_bot("alice", "owl").unwrap()["cap"], 1);
    write_config(home.path(), "memory:\n  memory_char_limit: 0\n");
    store.set_bot("alice", "owl", "").unwrap();
    assert_eq!(store.set_bot("alice", "owl", "a").unwrap_err().code, 4221);
    write_config(home.path(), "memory:\n  memory_char_limit: -1\n");
    assert_eq!(store.set_bot("alice", "owl", "").unwrap_err().code, 4221);
}

#[test]
fn preserves_last_known_cap_on_broken_yaml_but_resets_on_removal() {
    let (home, store) = setup();
    write_config(home.path(), "[broken");
    assert_eq!(store.get_bot("alice", "owl").unwrap()["cap"], 2200);
    write_config(home.path(), "memory:\n  memory_char_limit: 3\n");
    store.set_bot("alice", "owl", "old").unwrap();
    write_config(home.path(), "[broken");
    assert_eq!(store.get_bot("alice", "owl").unwrap()["cap"], 3);
    assert_eq!(
        store.set_bot("alice", "owl", "four").unwrap_err().code,
        4221
    );
    fs::remove_file(home.path().join("profiles/owl/config.yaml")).unwrap();
    assert_eq!(store.get_bot("alice", "owl").unwrap()["cap"], 2200);
}

#[test]
fn managed_config_wins_at_the_leaf_and_bad_managed_config_is_ignored() {
    let (home, store) = setup();
    let managed = tempfile::tempdir().unwrap();
    let store = store.with_managed_dir(Some(managed.path().to_path_buf()));
    write_config(home.path(), "memory:\n  memory_char_limit: 100\n");
    for (config, expected) in [
        ("memory:\n  memory_char_limit: 2\n", 2),
        ("memory:\n  memory_enabled: false\n", 100),
        ("[broken", 100),
        ("memory: null", 100),
        ("memory:\n  memory_char_limit: invalid\n", 2200),
    ] {
        fs::write(managed.path().join("config.yaml"), config).unwrap();
        assert_eq!(store.get_bot("alice", "owl").unwrap()["cap"], expected);
    }
}

#[test]
fn first_read_applies_managed_cap_even_when_profile_config_cannot_load() {
    let (home, _) = setup();
    let managed = tempfile::tempdir().unwrap();
    fs::write(
        managed.path().join("config.yaml"),
        "memory:\n  memory_char_limit: 3\n",
    )
    .unwrap();
    for profile in [
        Some("[broken"),
        Some("null"),
        Some("{}"),
        Some("memory: null"),
        None,
    ] {
        if let Some(profile) = profile {
            write_config(home.path(), profile);
        } else {
            fs::remove_file(home.path().join("profiles/owl/config.yaml")).unwrap();
        }
        let store = MemoryStore::new(home.path().to_path_buf())
            .with_managed_dir(Some(managed.path().to_path_buf()));
        assert_eq!(store.get_bot("alice", "owl").unwrap()["cap"], 3);
        store.set_bot("alice", "owl", "old").unwrap();
        assert_eq!(
            store.set_bot("alice", "owl", "four").unwrap_err().code,
            4221
        );
        assert_eq!(store.get_bot("alice", "owl").unwrap()["memory_md"], "old");
    }
    // A directory at the config path gives a deterministic read error.
    fs::create_dir(home.path().join("profiles/owl/config.yaml")).unwrap();
    let store = MemoryStore::new(home.path().to_path_buf())
        .with_managed_dir(Some(managed.path().to_path_buf()));
    assert_eq!(store.get_bot("alice", "owl").unwrap()["cap"], 3);
    assert_eq!(
        store.set_bot("alice", "owl", "four").unwrap_err().code,
        4221
    );
}

// MemoryStore reads the environment, so the assertions run in a child copy of
// this test binary that has its own environment.
#[test]
fn profile_and_managed_caps_expand_environment_variables() {
    const TEST: &str = "memory::file_tests::profile_and_managed_caps_expand_environment_variables";
    if let Some(expected) = std::env::var_os("HEXBOT_TEST_EXPECTED_CAP") {
        let home = std::path::PathBuf::from(std::env::var_os("HEXBOT_TEST_HOME").unwrap());
        let store = MemoryStore::new(home);
        let expected: i64 = expected.to_str().unwrap().parse().unwrap();
        assert_eq!(store.get_bot("alice", "owl").unwrap()["cap"], expected);
        return;
    }
    let (home, _) = setup();
    let managed = tempfile::tempdir().unwrap();
    write_config(
        home.path(),
        "memory:\n  memory_char_limit: '${HEXBOT_TEST_USER_CAP}'\n",
    );
    for (managed_config, expected) in [
        ("{}", "100"),
        (
            "memory:\n  memory_char_limit: '${env: HEXBOT_TEST_MANAGED_CAP }'\n",
            "3",
        ),
    ] {
        fs::write(managed.path().join("config.yaml"), managed_config).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--test-threads=1"])
            .env_clear()
            .env("HEXBOT_TEST_HOME", home.path())
            .env("HEXBOT_TEST_EXPECTED_CAP", expected)
            .env("HERMES_MANAGED_DIR", home.path().join("wrong-managed"))
            .env("HEXBOT_MANAGED_DIR", managed.path())
            .env("HEXBOT_TEST_USER_CAP", "100")
            .env("HEXBOT_TEST_MANAGED_CAP", "3")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "{stdout}"
        );
    }
}

#[test]
fn rejects_path_traversal() {
    let (_home, store) = setup();
    for id in [
        "",
        ".",
        "..",
        "../bob",
        "/tmp/escape",
        "foo/bar",
        "foo\\bar",
        "bad\0id",
    ] {
        assert_eq!(store.get_user(id).unwrap_err().code, 4202);
        assert_eq!(store.set_user(id, "x").unwrap_err().code, 4202);
        assert_eq!(store.get_bot("alice", id).unwrap_err().code, 4202);
        assert_eq!(store.set_bot("alice", id, "x").unwrap_err().code, 4202);
    }
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_directories_files_and_config() {
    use std::os::unix::fs::symlink;
    let (home, store) = setup();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("user.md"), "secret").unwrap();
    fs::create_dir(home.path().join("users")).unwrap();
    symlink(outside.path(), home.path().join("users/alice")).unwrap();
    assert_eq!(store.get_user("alice").unwrap_err().code, 4202);
    assert_eq!(store.set_user("alice", "overwrite").unwrap_err().code, 4202);
    assert_eq!(
        fs::read_to_string(outside.path().join("user.md")).unwrap(),
        "secret"
    );
    let profile = home.path().join("profiles/owl");
    fs::create_dir_all(profile.join("memories")).unwrap();
    symlink(
        outside.path().join("missing"),
        profile.join("memories/MEMORY.md"),
    )
    .unwrap();
    assert_eq!(store.get_bot("alice", "owl").unwrap_err().code, 4202);
    assert_eq!(store.set_bot("alice", "owl", "new").unwrap_err().code, 4202);
    assert!(!outside.path().join("missing").exists());
    fs::remove_file(profile.join("memories/MEMORY.md")).unwrap();
    fs::write(
        outside.path().join("config.yaml"),
        "memory:\n  memory_char_limit: 9999",
    )
    .unwrap();
    symlink(
        outside.path().join("config.yaml"),
        profile.join("config.yaml"),
    )
    .unwrap();
    assert_eq!(store.get_bot("alice", "owl").unwrap_err().code, 4202);
    assert_eq!(store.set_bot("alice", "owl", "new").unwrap_err().code, 4202);
}

#[test]
fn concurrent_conversations_append_without_losing_either_memory() {
    use std::sync::{Arc, Barrier};
    let (home, store) = setup();
    store.set_bot("alice", "owl", "original\n").unwrap();
    let start = Arc::new(Barrier::new(3));
    std::thread::scope(|scope| {
        for session in ["first", "second"] {
            let start = start.clone();
            // Like independent runtime sessions, neither store shares an instance.
            let store = MemoryStore::new(home.path().to_owned()).with_managed_dir(None);
            scope.spawn(move || {
                for index in 0..20 {
                    start.wait();
                    store
                        .update_bot("alice", "owl", |current| {
                            Ok(format!("{current}{session}-{index}-界\n"))
                        })
                        .unwrap();
                    start.wait();
                }
            });
        }
        for _ in 0..20 {
            start.wait();
            start.wait();
        }
    });
    let result = store.get_bot("alice", "owl").unwrap();
    let lines = result["memory_md"]
        .as_str()
        .unwrap()
        .lines()
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 41);
    assert_eq!(lines[0], "original");
    for session in ["first", "second"] {
        for index in 0..20 {
            assert!(lines.contains(&format!("{session}-{index}-界").as_str()));
        }
    }
}

#[test]
fn atomic_memory_edits_keep_unicode_caps_and_leave_failed_edits_unwritten() {
    let (home, store) = setup();
    write_config(home.path(), "memory:\n  memory_char_limit: 3\n");
    store.set_bot("alice", "owl", "界").unwrap();
    assert_eq!(
        store
            .update_bot("alice", "owl", |current| Ok(format!("{current}🦉é")))
            .unwrap()["memory_md"],
        "界🦉é"
    );
    assert_eq!(
        store
            .update_bot("alice", "owl", |current| Ok(format!("{current}a")))
            .unwrap_err()
            .code,
        4221
    );
    assert_eq!(
        store
            .update_bot("alice", "owl", |_| Err(crate::Error::new(
                4202,
                "missing text"
            )))
            .unwrap_err()
            .code,
        4202
    );
    assert_eq!(
        store
            .update_bot("bob", "owl", |_| panic!("unauthorized editor must not run"))
            .unwrap_err()
            .code,
        4302
    );
    assert_eq!(store.get_bot("alice", "owl").unwrap()["memory_md"], "界🦉é");
}

#[test]
fn added_entries_are_stamped_per_line_and_kept_when_already_stamped() {
    use crate::memory::stamp_entries;
    assert_eq!(
        stamp_entries("Likes tea.", "2026-10"),
        "Likes tea. [2026-10]"
    );
    assert_eq!(
        stamp_entries(
            "Met in 2024. [2024-05]\n## Work\n\n  Ships on Fridays.  \n界🦉é\n",
            "2026-10"
        ),
        "Met in 2024. [2024-05]\n## Work\n\n  Ships on Fridays. [2026-10]\n界🦉é [2026-10]"
    );
    // Only a trailing [YYYY-MM] counts as a stamp.
    assert_eq!(
        stamp_entries("[2024-05] early\nv[2024-5]\n[2024-05].", "2026-10"),
        "[2024-05] early [2026-10]\nv[2024-5] [2026-10]\n[2024-05]. [2026-10]"
    );
    assert_eq!(stamp_entries("", "2026-10"), "");
}

#[test]
fn replacements_restamp_only_the_lines_they_touch() {
    use crate::memory::restamp_span;
    let text = "Likes tea. [2024-05]\n## Work\nShips on Fridays. [2024-05] [2025-01]\nUndated";
    // "tea" -> "coffee" touches the first line, whose old stamp is refreshed.
    assert_eq!(
        restamp_span(&text.replacen("tea", "coffee", 1), 6..12, "2026-10"),
        "Likes coffee. [2026-10]\n## Work\nShips on Fridays. [2024-05] [2025-01]\nUndated"
    );
    // Doubled stamps collapse into one, and a heading in the span stays bare.
    let at = text.find("## Work").unwrap();
    let new = "## Work\nShips on Mondays. [2020-01]";
    assert_eq!(
        restamp_span(
            &text.replacen("## Work\nShips on Fridays. [2024-05] [2025-01]", new, 1),
            at..at + new.len(),
            "2026-10"
        ),
        "Likes tea. [2024-05]\n## Work\nShips on Mondays. [2026-10]\nUndated"
    );
    // New text that ends with a newline does not reach into the next line.
    let at = text.find("Undated").unwrap();
    let replaced = text.replacen("Undated", "Dated\n", 1) + "Next";
    assert_eq!(
        restamp_span(&replaced, at..at + 6, "2026-10"),
        "Likes tea. [2024-05]\n## Work\nShips on Fridays. [2024-05] [2025-01]\nDated [2026-10]\nNext"
    );
    // An empty replacement is a removal.
    assert_eq!(restamp_span(text, 6..6, "2026-10"), text);
}

/// Notes go to today's file, one line per note and without a month stamp,
/// capped per day with an error the bot can act on. Reads take a day or a
/// range; the user's edits and deletions work per day.
#[test]
fn notes_append_to_today_cap_the_day_and_read_by_date() {
    use crate::memory::{NOTE_DAY_CAP, fix_today, parse_note_date};
    let (home, store) = setup();
    let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap();
    fix_today(today);
    let yesterday = today.pred_opt().unwrap();
    let noted = store
        .add_note(
            "alice",
            "owl",
            "  Looked at the Q3 export.\n",
            |old, new| {
                assert_eq!(old, "");
                assert_eq!(new, "Looked at the Q3 export.");
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(noted["date"], today.to_string());
    assert_eq!(noted["cap"], NOTE_DAY_CAP);
    assert_eq!(noted["noted"], true);
    assert_eq!(noted["length"], "Looked at the Q3 export.".chars().count());
    assert!(noted.get("notes_md").is_none());
    store
        .add_note("alice", "owl", "Vendor column is stale.", |_, _| Ok(()))
        .unwrap();
    let file = home
        .path()
        .join(format!("profiles/owl/memories/notes/{today}.md"));
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "Looked at the Q3 export.\nVendor column is stale."
    );
    assert_eq!(
        store
            .add_note("alice", "owl", "  \n", |_, _| Ok(()))
            .unwrap_err()
            .code,
        4202
    );
    // The check sees the day as it would be written and can refuse it.
    assert_eq!(
        store
            .add_note("alice", "owl", "bad", |_, _| Err(crate::Error::new(
                4202, "no"
            )))
            .unwrap_err()
            .code,
        4202
    );
    let full = store
        .add_note("alice", "owl", &"界".repeat(4000), |_, _| Ok(()))
        .unwrap_err();
    assert_eq!(full.code, 4221);
    assert!(full.message.contains("the cap is 4000"), "{}", full.message);
    assert!(full.message.contains("fold what matters into memory"));
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "Looked at the Q3 export.\nVendor column is stale."
    );
    fs::write(
        home.path()
            .join(format!("profiles/owl/memories/notes/{yesterday}.md")),
        "Set up the export.",
    )
    .unwrap();
    assert_eq!(
        store.get_notes("alice", "owl", yesterday, today).unwrap(),
        json!({
            "notes": [
                {"date": yesterday.to_string(), "text": "Set up the export."},
                {"date": today.to_string(), "text": "Looked at the Q3 export.\nVendor column is stale."}
            ],
            "from": yesterday.to_string(),
            "to": today.to_string(),
            "cap": NOTE_DAY_CAP
        })
    );
    assert_eq!(
        store
            .get_notes("alice", "owl", yesterday, yesterday)
            .unwrap()["notes"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let listed = store.list_notes("alice", "owl").unwrap();
    assert_eq!(listed["retention_days"], 30);
    assert_eq!(listed["today"], today.to_string());
    assert_eq!(listed["days"][0]["date"], today.to_string());
    assert_eq!(listed["days"][1]["date"], yesterday.to_string());
    // The user's edit is written as given; an empty edit removes the day.
    let edited = store
        .set_notes(
            "alice",
            "owl",
            yesterday,
            "Set up the export, twice.",
            Some("Set up the export."),
        )
        .unwrap();
    assert_eq!(edited["text"], "Set up the export, twice.");
    // The editor loaded an older text: the bot's note since is kept.
    let stale = store
        .set_notes(
            "alice",
            "owl",
            yesterday,
            "Set up the export, thrice.",
            Some("Set up the export."),
        )
        .unwrap_err();
    assert_eq!(stale.code, 4209);
    assert!(
        stale.message.contains("since you opened them"),
        "{}",
        stale.message
    );
    assert_eq!(
        store
            .set_notes("alice", "owl", yesterday, &"x".repeat(4001), None)
            .unwrap_err()
            .code,
        4221
    );
    store
        .set_notes("alice", "owl", yesterday, "  ", None)
        .unwrap();
    assert_eq!(
        store.list_notes("alice", "owl").unwrap()["days"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.delete_notes("alice", "owl", today, None).unwrap(),
        json!({"date": today.to_string(), "deleted": true})
    );
    assert!(!file.exists());
    store.delete_notes("alice", "owl", today, None).unwrap();
    // Notes are the owner's, like memory.
    for caller in ["bob", "missing"] {
        assert_eq!(
            store
                .add_note(caller, "owl", "x", |_, _| Ok(()))
                .unwrap_err()
                .code,
            4302
        );
        assert_eq!(store.list_notes(caller, "owl").unwrap_err().code, 4302);
        assert_eq!(
            store
                .get_notes(caller, "owl", today, today)
                .unwrap_err()
                .code,
            4302
        );
        assert_eq!(
            store
                .delete_notes(caller, "owl", today, None)
                .unwrap_err()
                .code,
            4302
        );
    }
    assert_eq!(
        parse_note_date("2026-10-06").unwrap().to_string(),
        "2026-10-06"
    );
    for bad in ["2026-10-6", "2026-13-01", "../x", "today", ""] {
        assert_eq!(parse_note_date(bad).unwrap_err().code, 4202, "{bad}");
    }
}

#[test]
fn note_ranges_name_days_and_bound_one_read() {
    use crate::memory::parse_note_range;
    let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap();
    let day = |text: &str| chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap();
    assert_eq!(parse_note_range("today", today).unwrap(), (today, today));
    assert_eq!(
        parse_note_range(" yesterday ", today).unwrap(),
        (day("2026-10-06"), day("2026-10-06"))
    );
    assert_eq!(
        parse_note_range("2026-10-01", today).unwrap(),
        (day("2026-10-01"), day("2026-10-01"))
    );
    assert_eq!(
        parse_note_range("2026-10-01..2026-10-07", today).unwrap(),
        (day("2026-10-01"), day("2026-10-07"))
    );
    assert_eq!(
        parse_note_range("2026-09-30..2026-10-07", today)
            .unwrap_err()
            .message,
        "Read at most 7 days of notes at a time."
    );
    for bad in ["2026-10-07..2026-10-01", "last week", "2026-10-01..", ""] {
        assert_eq!(
            parse_note_range(bad, today).unwrap_err().code,
            4202,
            "{bad}"
        );
    }
}

/// Retention removes only note files older than 30 days; a file that is not
/// named like a day, and a day inside the window, stay where they are.
#[test]
fn pruning_removes_only_old_note_files() {
    use crate::memory::{notes_from, prune_notes};
    let (home, _store) = setup();
    let dir = home.path().join("profiles/owl/memories/notes");
    fs::create_dir_all(&dir).unwrap();
    let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap();
    for (name, text) in [
        ("2026-09-06.md", "thirty-one days ago"),
        ("2026-09-07.md", "thirty days ago"),
        ("2026-10-07.md", "today"),
        ("README.md", "not a day"),
        ("2026-08-01.txt", "not notes"),
    ] {
        fs::write(dir.join(name), text).unwrap();
    }
    fs::create_dir(dir.join("2026-01-01.md")).unwrap();
    assert_eq!(
        prune_notes(home.path(), "owl", today).unwrap(),
        [chrono::NaiveDate::from_ymd_opt(2026, 9, 6).unwrap()]
    );
    assert!(!dir.join("2026-09-06.md").exists());
    for kept in [
        "2026-09-07.md",
        "2026-10-07.md",
        "README.md",
        "2026-08-01.txt",
        "2026-01-01.md",
    ] {
        assert!(dir.join(kept).exists(), "{kept}");
    }
    assert_eq!(prune_notes(home.path(), "owl", today).unwrap(), []);
    let since = notes_from(
        home.path(),
        "owl",
        chrono::NaiveDate::from_ymd_opt(2026, 9, 7).unwrap(),
    )
    .unwrap();
    assert_eq!(
        since
            .iter()
            .map(|(date, text)| (date.to_string(), text.as_str()))
            .collect::<Vec<_>>(),
        [
            ("2026-09-07".to_owned(), "thirty days ago"),
            ("2026-10-07".to_owned(), "today")
        ]
    );
    assert!(notes_from(home.path(), "fox", today).unwrap().is_empty());
    assert_eq!(
        prune_notes(home.path(), "../owl", today).unwrap_err().code,
        4202
    );
}

#[test]
fn notes_delete_checks_expected_and_set_refuses_future_days() {
    let (_home, store) = setup();
    let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap();
    crate::memory::fix_today(today);
    store
        .add_note("alice", "owl", "Plan", |_, _| Ok(()))
        .unwrap();
    store
        .add_note("alice", "owl", "New note", |_, _| Ok(()))
        .unwrap();
    assert_eq!(
        store
            .delete_notes("alice", "owl", today, Some("Plan"))
            .unwrap_err()
            .code,
        4209
    );
    assert_eq!(
        store.get_notes("alice", "owl", today, today).unwrap()["notes"][0]["text"],
        "Plan\nNew note"
    );
    store
        .delete_notes("alice", "owl", today, Some("Plan\nNew note"))
        .unwrap();
    assert!(
        store.list_notes("alice", "owl").unwrap()["days"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .set_notes("alice", "owl", today.succ_opt().unwrap(), "Future", None)
            .unwrap_err()
            .code,
        4202
    );
}

#[test]
fn reading_or_listing_notes_prunes_days_without_dreaming_or_appending() {
    let (home, store) = setup();
    let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap();
    crate::memory::fix_today(today);
    let dir = home.path().join("profiles/owl/memories/notes");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("2026-09-07.md"), "Keep").unwrap();
    for list in [true, false] {
        fs::write(dir.join("2026-09-06.md"), "Old").unwrap();
        if list {
            store.list_notes("alice", "owl").unwrap();
        } else {
            store.get_notes("alice", "owl", today, today).unwrap();
        }
        assert!(!dir.join("2026-09-06.md").exists());
        assert!(dir.join("2026-09-07.md").exists());
    }
}

#[cfg(unix)]
#[test]
fn notes_reject_symlinked_directories_before_reading_or_pruning() {
    use crate::memory::{notes_from, prune_notes};
    use std::os::unix::fs::symlink;
    let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap();
    crate::memory::fix_today(today);
    for component in [
        "profiles/owl",
        "profiles/owl/memories",
        "profiles/owl/memories/notes",
    ] {
        let (home, store) = setup();
        let dir = home.path().join("profiles/owl/memories/notes");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("2026-09-01.md"), "Private").unwrap();
        let original = home.path().join(component);
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("moved");
        fs::rename(&original, &target).unwrap();
        symlink(&target, &original).unwrap();
        assert_eq!(
            notes_from(home.path(), "owl", today).unwrap_err().code,
            4202
        );
        assert_eq!(
            prune_notes(home.path(), "owl", today).unwrap_err().code,
            4202
        );
        assert_eq!(store.list_notes("alice", "owl").unwrap_err().code, 4202);
        assert_eq!(
            fs::read_to_string(dir.join("2026-09-01.md")).unwrap(),
            "Private"
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn a_prune_failure_does_not_fail_an_append_that_was_saved() {
    let (home, store) = setup();
    let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap();
    crate::memory::fix_today(today);
    let dir = home.path().join("profiles/owl/memories/notes");
    fs::create_dir_all(&dir).unwrap();
    let old = dir.join("2026-09-01.md");
    fs::write(&old, "Old note").unwrap();
    // An immutable old file blocks pruning without blocking today's write.
    let flag = |value| {
        std::process::Command::new("chflags")
            .arg(value)
            .arg(&old)
            .status()
            .unwrap()
    };
    assert!(flag("uchg").success());
    let prune = crate::memory::prune_notes(home.path(), "owl", today);
    let saved = store.add_note("alice", "owl", "Saved once", |_, _| Ok(()));
    assert!(flag("nouchg").success());
    assert!(prune.is_err());
    assert_eq!(saved.unwrap()["noted"], true);
    assert_eq!(
        fs::read_to_string(dir.join(format!("{today}.md"))).unwrap(),
        "Saved once"
    );
}

#[test]
fn concurrent_pruning_tolerates_already_removed_files() {
    let (home, _store) = setup();
    let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap();
    let dir = home.path().join("profiles/owl/memories/notes");
    fs::create_dir_all(&dir).unwrap();
    for back in 31..131 {
        fs::write(
            dir.join(format!("{}.md", today - chrono::Days::new(back))),
            "Old",
        )
        .unwrap();
    }
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let prune = || {
            barrier.wait();
            crate::memory::prune_notes(home.path(), "owl", today).unwrap();
        };
        scope.spawn(prune);
        scope.spawn(prune);
    });
    assert_eq!(fs::read_dir(dir).unwrap().count(), 0);
}
