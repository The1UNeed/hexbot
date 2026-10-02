use hexbot_core::{catalog, db, memory::MemoryStore, runtime_store};
use serde_json::{Value, json};
use std::{fs, path::Path};
fn setup() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    db::open(home.path()).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES ('alice','Alice','member',0),('bob','Bob','member',0)").unwrap();
    home
}
fn call(home: &Path, user: &str, method: &str, p: Value) -> Value {
    catalog::call(home, user, method, &p).unwrap().unwrap()
}
fn create(home: &Path) -> Value {
    call(
        home,
        "alice",
        "hexbot.bots.create",
        json!({"name":"research-owl","model":"model-a","provider":"openai"}),
    )
}
#[test]
fn lifecycle_preserves_memory_and_reopens_archived_sections() {
    let home = setup();
    let h = home.path();
    let created = create(h);
    let bot = &created["bot"];
    assert_eq!(bot["display_name"], "Research Owl");
    assert_eq!(bot["sections_total"], 1);
    assert!(bot["persona"].as_str().unwrap().contains("Research Owl"));
    assert_eq!(bot["model"], "model-a");
    let id = created["section"]["id"].as_str().unwrap();
    assert_eq!(
        catalog::section(h, "alice", id).unwrap()["title"],
        "General"
    );
    let memory = MemoryStore::new(h.to_path_buf());
    memory
        .set_bot("alice", "research-owl", "Durable memory")
        .unwrap();
    runtime_store::append(h, id, json!({"role":"user","text":"First message"})).unwrap();
    assert_eq!(
        catalog::section(h, "alice", id).unwrap()["message_count"],
        1
    );
    let archived = call(h, "alice", "hexbot.sections.archive", json!({"id":id}));
    assert!(archived["section"]["archived_at"].is_number());
    assert_eq!(
        call(h, "alice", "hexbot.sections.list", json!({}))["sections"],
        json!([])
    );
    call(h, "alice", "hexbot.sections.unarchive", json!({"id":id}));
    call(
        h,
        "alice",
        "hexbot.sections.rename",
        json!({"id":id,"title":" Next task "}),
    );
    assert_eq!(
        catalog::section(h, "alice", id).unwrap()["title"],
        "Next task"
    );
    assert!(
        call(h, "alice", "hexbot.sections.touch", json!({"id":id}))["section"]["done_at"]
            .is_number()
    );
    assert!(
        call(h, "alice", "hexbot.sections.mark_read", json!({"id":id}))["section"]["done_at"]
            .is_null()
    );
    call(h, "alice", "hexbot.sections.delete", json!({"id":id}));
    assert!(runtime_store::history(h, id).unwrap().is_empty());
    assert_eq!(
        memory.get_bot("alice", "research-owl").unwrap()["memory_md"],
        "Durable memory"
    );
    let updated = call(
        h,
        "alice",
        "hexbot.bots.update",
        json!({"name":"research-owl","display_name":"Owl","persona":"Custom soul","model":"model-b","tools":["files"],"dream_enabled":false,"workdir":" /tmp/work ","approval_mode":"off"}),
    );
    assert_eq!(updated["bot"]["persona"], "Custom soul");
    assert_eq!(updated["bot"]["tools"], json!(["files"]));
    assert_eq!(updated["bot"]["workdir"], "/tmp/work");
    assert_eq!(updated["bot"]["dream_enabled"], false);
    call(
        h,
        "alice",
        "hexbot.bots.delete",
        json!({"name":"research-owl"}),
    );
    assert!(!h.join("profiles/research-owl").exists());
    let archived = fs::read_dir(h.join("runtime/deleted-bots"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("MEMORY.md");
    assert_eq!(fs::read_to_string(archived).unwrap(), "Durable memory");
    assert_eq!(
        call(h, "alice", "hexbot.bots.list", json!({}))["bots"],
        json!([])
    );
}
#[test]
fn owner_checks_cover_reads_writes_and_admin_listing() {
    let home = setup();
    let h = home.path();
    let created = create(h);
    let id = created["section"]["id"].as_str().unwrap();
    for user in ["bob", "local"] {
        for (method, p) in [
            ("hexbot.bots.get", json!({"name":"research-owl"})),
            (
                "hexbot.bots.update",
                json!({"name":"research-owl","persona":"wrong"}),
            ),
            ("hexbot.bots.delete", json!({"name":"research-owl"})),
            ("hexbot.sections.rename", json!({"id":id,"title":"wrong"})),
            ("hexbot.sections.delete", json!({"id":id})),
            ("hexbot.sections.close", json!({"id":id})),
        ] {
            assert_eq!(
                catalog::call(h, user, method, &p)
                    .unwrap()
                    .unwrap_err()
                    .code,
                4302
            );
        }
    }
    assert_eq!(
        call(h, "bob", "hexbot.bots.list", json!({}))["bots"],
        json!([])
    );
    assert_eq!(
        call(h, "local", "hexbot.bots.list", json!({"all":true}))["bots"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        catalog::call(h, "bob", "hexbot.bots.list", &json!({"all":true}))
            .unwrap()
            .unwrap_err()
            .code,
        4301
    );
    db::open(h)
        .unwrap()
        .execute("UPDATE users SET disabled_at=1 WHERE id='alice'", [])
        .unwrap();
    assert_eq!(
        catalog::bot(h, "alice", "research-owl").unwrap_err().code,
        4302
    );
}
#[test]
fn validates_all_fields_before_writes_and_rejects_path_escape() {
    let home = setup();
    let h = home.path();
    create(h);
    for name in [
        "../escape",
        "/tmp/escape",
        "bad/name",
        "root",
        "default",
        "Upper",
    ] {
        assert_eq!(
            catalog::call(h, "alice", "hexbot.bots.create", &json!({"name":name}))
                .unwrap()
                .unwrap_err()
                .code,
            4202
        );
    }
    for p in [
        json!({"notify":"yes"}),
        json!({"approval_mode":"auto"}),
        json!({"tools":["invalid"]}),
        json!({"skills":[1]}),
        json!({"workdir":" "}),
        json!({"avatar":"not-an-image"}),
    ] {
        let mut p = p;
        p["name"] = json!("research-owl");
        p["persona"] = json!("Must not replace");
        assert!(
            catalog::call(h, "alice", "hexbot.bots.update", &p)
                .unwrap()
                .is_err()
        );
        assert_ne!(
            catalog::bot(h, "alice", "research-owl").unwrap()["persona"],
            "Must not replace"
        );
    }
    assert_eq!(
        catalog::call(
            h,
            "alice",
            "hexbot.bots.create",
            &json!({"name":"research-owl"})
        )
        .unwrap()
        .unwrap_err()
        .code,
        4208
    );
}
#[test]
fn reads_legacy_transcripts_and_optional_purge_keeps_them() {
    let home = setup();
    let h = home.path();
    let created = create(h);
    let id = created["section"]["id"].as_str().unwrap();
    let conn = rusqlite::Connection::open(h.join("profiles/research-owl/state.db")).unwrap();
    conn.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY);CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT)").unwrap();
    conn.execute("INSERT INTO sessions VALUES (?)", [id])
        .unwrap();
    conn.execute(
        "INSERT INTO messages VALUES (1,?,'assistant','Stored reply')",
        [id],
    )
    .unwrap();
    assert_eq!(
        catalog::section(h, "alice", id).unwrap()["message_count"],
        1
    );
    call(
        h,
        "alice",
        "hexbot.sections.delete",
        json!({"id":id,"purge_memory":false}),
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn skill_selection_and_avatar_use_existing_profile_files() {
    let home = setup();
    let h = home.path();
    create(h);
    let skill = h.join("profiles/research-owl/skills/notes");
    fs::create_dir_all(&skill).unwrap();
    fs::write(skill.join("SKILL.md"), "Notes").unwrap();
    call(
        h,
        "alice",
        "hexbot.bots.update",
        json!({"name":"research-owl","skills":[]}),
    );
    assert_eq!(
        call(
            h,
            "alice",
            "profiles.describe",
            json!({"name":"research-owl"})
        )["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == "notes")
            .unwrap()["enabled"],
        false
    );
    call(
        h,
        "alice",
        "hexbot.bots.update",
        json!({"name":"research-owl","skills":["notes"]}),
    );
    assert_eq!(
        call(
            h,
            "alice",
            "profiles.describe",
            json!({"name":"research-owl"})
        )["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == "notes")
            .unwrap()["enabled"],
        true
    );
    let image = "data:image/png;base64,iVBORw0KGgo=";
    call(
        h,
        "alice",
        "hexbot.bots.update",
        json!({"name":"research-owl","avatar":image}),
    );
    assert_eq!(
        catalog::bot(h, "alice", "research-owl").unwrap()["avatar"]["data"],
        image
    );
    call(
        h,
        "alice",
        "hexbot.bots.update",
        json!({"name":"research-owl","avatar":null}),
    );
    assert!(catalog::bot(h, "alice", "research-owl").unwrap()["avatar"].is_null());
}
#[cfg(unix)]
#[test]
fn refuses_symlink_profile_reads_and_mutations() {
    let home = setup();
    let h = home.path();
    create(h);
    let outside = tempfile::tempdir().unwrap();
    let file = h.join("profiles/research-owl/SOUL.md");
    fs::remove_file(&file).unwrap();
    fs::write(outside.path().join("soul"), "Private").unwrap();
    std::os::unix::fs::symlink(outside.path().join("soul"), file).unwrap();
    assert_eq!(
        catalog::bot(h, "alice", "research-owl").unwrap_err().code,
        4202
    );
    assert_eq!(
        catalog::call(
            h,
            "alice",
            "hexbot.bots.update",
            &json!({"name":"research-owl","persona":"Changed"})
        )
        .unwrap()
        .unwrap_err()
        .code,
        4202
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("soul")).unwrap(),
        "Private"
    );
}

#[test]
fn purges_legacy_session_keys_and_compression_descendants() {
    let home = setup();
    let h = home.path();
    let created = create(h);
    let id = created["section"]["id"].as_str().unwrap();
    let conn = rusqlite::Connection::open(h.join("profiles/research-owl/state.db")).unwrap();
    conn.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,parent_session_id TEXT);CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT)").unwrap();
    conn.execute("INSERT INTO sessions VALUES ('parent',?,NULL)", [id])
        .unwrap();
    conn.execute_batch("INSERT INTO sessions VALUES ('compressed','other-key','parent'),('unrelated','different',NULL); INSERT INTO messages VALUES (1,'parent','user','Earlier'),(2,'compressed','assistant','Later'),(3,'unrelated','user','Keep')").unwrap();
    assert_eq!(
        catalog::section(h, "alice", id).unwrap()["message_count"],
        2
    );
    call(h, "alice", "hexbot.sections.delete", json!({"id":id}));
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row("SELECT content FROM messages", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "Keep"
    );
}
#[test]
fn incidents_take_precedence_and_clear_status_resolves_them() {
    let home = setup();
    let h = home.path();
    create(h);
    let conn = db::open(h).unwrap();
    conn.execute_batch("INSERT INTO bot_incidents(id,bot,kind,text,created_at) VALUES ('incident','research-owl','turn_failed','Provider disconnected',1)").unwrap();
    let bot = catalog::bot(h, "alice", "research-owl").unwrap();
    assert_eq!(bot["status"], "stopped");
    assert_eq!(bot["status_detail"]["action"]["kind"], "retry");
    let cleared = call(
        h,
        "alice",
        "hexbot.bots.clear_status",
        json!({"name":"research-owl"}),
    );
    assert_eq!(cleared["bot"]["status"], "idle");
}

#[test]
fn create_accepts_explicit_empty_tool_selection_before_registry_insert() {
    let home = setup();
    let created = call(
        home.path(),
        "alice",
        "hexbot.bots.create",
        json!({"name":"no-tools","tools":[]}),
    );
    assert_eq!(created["bot"]["tools"], json!([]));
}

#[test]
fn empty_native_history_never_resurrects_legacy_messages() {
    let home = setup();
    let h = home.path();
    let created = create(h);
    let id = created["section"]["id"].as_str().unwrap();
    let legacy = rusqlite::Connection::open(h.join("profiles/research-owl/state.db")).unwrap();
    legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY);CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,active INTEGER)").unwrap();
    legacy
        .execute("INSERT INTO sessions VALUES (?)", [id])
        .unwrap();
    legacy
        .execute(
            "INSERT INTO messages VALUES (1,?,'user','Current',1),(2,?,'user','Inactive',0)",
            [id, id],
        )
        .unwrap();
    let old = catalog::section(h, "alice", id).unwrap();
    assert_eq!(old["message_count"], 1);
    assert_eq!(old["preview"], "Current");
    let native = runtime_store::open(h).unwrap();
    native.execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES (?,'alice','research-owl','')",[id]).unwrap();
    assert_eq!(
        catalog::section(h, "alice", id).unwrap()["message_count"],
        0
    );
    assert_eq!(catalog::section(h, "alice", id).unwrap()["preview"], "");
    native.execute("DELETE FROM native_sessions", []).unwrap();
    native.execute("INSERT INTO native_pi_journal(journal_id,session_id,raw_json,active) VALUES ('rewound',?,'{}',0)",[id]).unwrap();
    assert_eq!(
        catalog::section(h, "alice", id).unwrap()["message_count"],
        0
    );
}

#[test]
fn failed_section_delete_removes_tombstone() {
    let home = setup();
    let created = create(home.path());
    let id = created["section"]["id"].as_str().unwrap();
    runtime_store::mark_deleted(home.path(), id).unwrap();
    db::open(home.path()).unwrap().execute_batch("CREATE TRIGGER refuse_delete BEFORE DELETE ON sections BEGIN SELECT RAISE(FAIL, 'busy'); END;").unwrap();
    assert!(
        catalog::call(
            home.path(),
            "alice",
            "hexbot.sections.delete",
            &json!({"id":id})
        )
        .unwrap()
        .is_err()
    );
    assert!(catalog::section(home.path(), "alice", id).is_ok());
    runtime_store::append(
        home.path(),
        id,
        json!({"role":"user","text":"Still usable"}),
    )
    .unwrap();
}

#[test]
fn bot_and_workspace_dirs_never_open_the_hexbot_home() {
    let home = setup();
    let h = home.path();
    create(h);
    db::open(h)
        .unwrap()
        .execute("UPDATE users SET role='admin' WHERE id='alice'", [])
        .unwrap();
    let outside = tempfile::tempdir().unwrap();
    let mut refused = vec![
        h.to_path_buf(),
        h.join("profiles/research-owl"),
        h.join("bin"),
        h.join("profiles/future-bot"),
        outside.path().join("../escape"),
    ];
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(h, outside.path().join("home-link")).unwrap();
        refused.push(outside.path().join("home-link/profiles/research-owl"));
    }
    for workdir in refused {
        for (method, p) in [
            (
                "hexbot.bots.update",
                json!({"name":"research-owl","workdir":workdir}),
            ),
            (
                "hexbot.bots.create",
                json!({"name":"second-owl","workdir":workdir}),
            ),
        ] {
            let error = catalog::call(h, "alice", method, &p).unwrap().unwrap_err();
            assert_eq!(error.code, 4202, "{method} {}", workdir.display());
        }
        assert!(
            hexbot_core::settings::update(h, "alice", &json!({"workspace_dir":workdir})).is_err()
        );
    }
    assert!(catalog::bot(h, "alice", "research-owl").unwrap()["workdir"].is_null());
    assert!(!h.join("profiles/second-owl").exists());
    assert!(!h.join("bin").exists());
    assert!(!h.join("profiles/future-bot").exists());
    let allowed = outside.path().join("work");
    let updated = call(
        h,
        "alice",
        "hexbot.bots.update",
        json!({"name":"research-owl","workdir":allowed}),
    );
    assert_eq!(updated["bot"]["workdir"], json!(allowed));
}

#[test]
fn create_persists_every_accepted_field() {
    let home = setup();
    let workdir = tempfile::tempdir().unwrap();
    let created = call(
        home.path(),
        "alice",
        "hexbot.bots.create",
        json!({"name":"quiet-owl","dream_enabled":false,"shareable":true,"notify":false,"approval_mode":"manual","workdir":workdir.path(),"tools":["files","files"]}),
    );
    let bot = &created["bot"];
    assert_eq!(bot["dream_enabled"], false);
    assert_eq!(bot["shareable"], true);
    assert_eq!(bot["notify"], false);
    assert_eq!(bot["approval_mode"], "manual");
    assert_eq!(bot["workdir"], json!(workdir.path()));
    assert_eq!(bot["tools"], json!(["files"]));
}

#[test]
fn deleting_a_bot_removes_its_scheduled_jobs() {
    let home = setup();
    let h = home.path();
    create(h);
    let jobs = runtime_store::open(h).unwrap();
    jobs.execute_batch("INSERT INTO native_jobs(id,owner,bot,job_json) VALUES ('daily','alice','research-owl','{}'),('other','alice','other-owl','{}'); INSERT INTO native_job_imports(bot) VALUES ('research-owl');").unwrap();
    call(
        h,
        "alice",
        "hexbot.bots.delete",
        json!({"name":"research-owl"}),
    );
    let count = |sql: &str| jobs.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(
        count("SELECT COUNT(*) FROM native_jobs WHERE bot='research-owl'"),
        0
    );
    assert_eq!(count("SELECT COUNT(*) FROM native_job_imports"), 0);
    assert_eq!(count("SELECT COUNT(*) FROM native_jobs"), 1);
}

#[test]
fn deleting_a_bot_closes_the_threads_where_it_asked_others() {
    let home = setup();
    let h = home.path();
    create(h);
    call(
        h,
        "alice",
        "hexbot.bots.create",
        json!({"name":"writer","model":"model-a","provider":"openai"}),
    );
    db::open(h).unwrap().execute_batch("INSERT INTO sections(id,bot,owner_id,title,peer_bot,created_at) VALUES('asked','writer','alice','From Research Owl','research-owl',1);").unwrap();
    call(
        h,
        "alice",
        "hexbot.bots.delete",
        json!({"name":"research-owl"}),
    );
    // A new bot with the same name must not inherit the old conversation.
    assert!(
        call(
            h,
            "alice",
            "hexbot.sections.thread",
            json!({"bot":"writer","peer":"research-owl"})
        )["section"]
            .is_null()
    );
    assert!(!catalog::section(h, "alice", "asked").unwrap()["archived_at"].is_null());
}

#[test]
fn threads_are_hidden_from_lists_and_counts_but_readable_by_the_owner() {
    let home = setup();
    let h = home.path();
    create(h);
    db::open(h).unwrap().execute_batch("INSERT INTO sections(id,bot,owner_id,title,peer_bot,created_at) VALUES('thread','research-owl','alice','From Cat','cat',1),('archived-thread','research-owl','alice','From Dog','dog',2); UPDATE sections SET archived_at=3 WHERE id='archived-thread';").unwrap();
    let list = call(
        h,
        "alice",
        "hexbot.sections.list",
        json!({"bot":"research-owl"}),
    );
    assert_eq!(list["sections"].as_array().unwrap().len(), 1);
    assert!(list["sections"][0]["peer_bot"].is_null());
    let list = call(
        h,
        "alice",
        "hexbot.sections.list",
        json!({"bot":"research-owl","include_threads":true}),
    );
    assert_eq!(list["sections"].as_array().unwrap().len(), 2);
    let bot = call(
        h,
        "alice",
        "hexbot.bots.get",
        json!({"name":"research-owl"}),
    );
    assert_eq!(bot["bot"]["sections_total"], 1);
    assert_eq!(bot["bot"]["sections_recent"].as_array().unwrap().len(), 1);
    let thread = call(
        h,
        "alice",
        "hexbot.sections.thread",
        json!({"bot":"research-owl","peer":"cat"}),
    );
    assert_eq!(thread["section"]["id"], "thread");
    assert_eq!(thread["section"]["peer_bot"], "cat");
    assert!(
        call(
            h,
            "alice",
            "hexbot.sections.thread",
            json!({"bot":"research-owl","peer":"dog"})
        )["section"]
            .is_null()
    );
    assert!(
        call(
            h,
            "alice",
            "hexbot.sections.thread",
            json!({"bot":"research-owl","peer":"missing"})
        )["section"]
            .is_null()
    );
    let error = catalog::call(
        h,
        "bob",
        "hexbot.sections.thread",
        &json!({"bot":"research-owl","peer":"cat"}),
    )
    .unwrap()
    .unwrap_err();
    assert_eq!(error.code, 4302);
    assert!(catalog::section(h, "bob", "thread").is_err());
    assert_eq!(
        catalog::section(h, "alice", "thread").unwrap()["peer_bot"],
        "cat"
    );
    runtime_store::append(
        h,
        "thread",
        json!({"role":"user","text":"@cat: Help","display_kind":"hidden"}),
    )
    .unwrap();
    call(
        h,
        "alice",
        "hexbot.bots.delete",
        json!({"name":"research-owl"}),
    );
    assert!(runtime_store::history(h, "thread").unwrap().is_empty());
    assert_eq!(
        db::open(h)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM sections WHERE bot='research-owl'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
