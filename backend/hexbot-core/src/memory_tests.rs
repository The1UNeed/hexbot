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
    // Code fences and rules are markup, not entries.
    assert_eq!(
        stamp_entries("```sh\nls\n```\n---\n--\n- - -", "2026-10"),
        "```sh\nls [2026-10]\n```\n---\n-- [2026-10]\n- - -"
    );
    let markup = "  ## Work\n  ```rust\n  ```\n~~~sh\n~~~\n***\n_ _ _\n  - - -  ";
    assert_eq!(stamp_entries(markup, "2026-10"), markup);
    assert_eq!(
        crate::memory::restamp_span(markup, 0..markup.len(), "2026-10"),
        markup
    );
}

#[test]
fn removals_drop_a_line_left_with_only_a_bullet_and_a_stamp() {
    use crate::memory::{drop_emptied_line, restamp_span};
    let text = "- Likes tea. [2024-05]\n-  [2026-10]\n* [2024-05] [2026-10]\n\nLast";
    // "-  [2026-10]" is what removing "Prefers tabs" leaves; the line goes.
    assert_eq!(
        drop_emptied_line(text, 25),
        "- Likes tea. [2024-05]\n* [2024-05] [2026-10]\n\nLast"
    );
    // Doubled stamps count as a stamp; a blank line counts as empty.
    assert_eq!(
        drop_emptied_line(text, 38),
        "- Likes tea. [2024-05]\n-  [2026-10]\n\nLast"
    );
    assert_eq!(
        drop_emptied_line(text, 58),
        "- Likes tea. [2024-05]\n-  [2026-10]\n* [2024-05] [2026-10]\nLast"
    );
    // A line with words left keeps its stamp; the last line takes the
    // newline before it; a lone line leaves nothing.
    assert_eq!(drop_emptied_line(text, 2), text);
    assert_eq!(
        drop_emptied_line("Likes tea.\n [2026-10]", 11),
        "Likes tea."
    );
    assert_eq!(drop_emptied_line("- [2026-10]", 0), "");
    // An empty replacement is a removal and does the same.
    assert_eq!(
        restamp_span("Keep\n-  [2026-10]\nKeep", 7..7, "2026-10"),
        "Keep\nKeep"
    );
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
