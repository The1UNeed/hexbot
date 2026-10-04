use hexbot_core::{catalog, common, connectors, db, native_product_tools, runtime_store, skills};
use serde_json::{Value, json};
use std::{fs, path::Path};
const CONTENT: &str =
    "---\nname: unrelated-frontmatter-name\ndescription: Plan a task.\n---\nPrivate body.\n";
fn setup() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    db::open(home.path()).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES('member','Member','member',0); INSERT INTO bots(name,owner_id) VALUES('owl','member'),('fox','local'); INSERT INTO sections(id,bot,owner_id) VALUES('section','owl','member');").unwrap();
    fs::create_dir_all(home.path().join("profiles/owl")).unwrap();
    fs::create_dir_all(home.path().join("profiles/fox")).unwrap();
    runtime_store::open(home.path()).unwrap().execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('section','member','owl','frozen')", []).unwrap();
    home
}
async fn rpc(home: &Path, caller: &str, method: &str, args: Value) -> hexbot_core::Result<Value> {
    connectors::call(home, caller, &format!("hexbot.skills.{method}"), &args)
        .await
        .unwrap()
}
async fn tool(home: &Path, name: &str, args: Value) -> hexbot_core::Result<Value> {
    native_product_tools::call(home, "member", "owl", "section", name, &args)
        .await
        .unwrap()
}
#[tokio::test]
async fn rpc_permissions_and_private_visibility() {
    let home = setup();
    let h = home.path();
    for method in ["save", "delete", "share", "set_global"] {
        let mut args = json!({"name":"custom-notes","content":CONTENT,"enabled":false});
        if method == "share" {
            args["bot"] = json!("owl");
        }
        assert_eq!(rpc(h, "member", method, args).await.unwrap_err().code, 4301);
    }
    for category in [".hidden", "../escape"] {
        assert!(
            rpc(
                h,
                "member",
                "save",
                json!({"name":"bad-category","bot":"owl","content":CONTENT,"category":category})
            )
            .await
            .is_err()
        );
        assert!(tool(h, "skill_manage", json!({"name":"bad-category","action":"create","content":CONTENT,"category":category})).await.is_err());
    }
    let saved = rpc(
        h,
        "member",
        "save",
        json!({"name":"custom-notes","bot":"owl","content":CONTENT,"category":"work"}),
    )
    .await
    .unwrap();
    assert_eq!(saved["skill"]["source"], "bot");
    assert_eq!(saved["skill"]["name"], "custom-notes");
    assert!(rpc(h, "member", "save", json!({"name":"nested","bot":"owl","content":CONTENT,"category":"work/custom-notes/child"})).await.is_err());
    assert!(tool(h, "skill_manage", json!({"name":"nested","action":"create","content":CONTENT,"category":"work/custom-notes/child"})).await.is_err());
    assert_eq!(
        rpc(
            h,
            "member",
            "get",
            json!({"name":"custom-notes","bot":"owl"})
        )
        .await
        .unwrap()["files"],
        json!(["SKILL.md"])
    );
    assert!(
        rpc(h, "member", "get", json!({"name":"custom-notes"}))
            .await
            .is_err()
    );
    assert!(
        rpc(h, "member", "list", json!({"bot":"fox"}))
            .await
            .is_err()
    );
    assert!(
        rpc(
            h,
            "member",
            "save",
            json!({"name":"custom-notes","bot":"fox","content":CONTENT})
        )
        .await
        .is_err()
    );
    assert!(
        rpc(
            h,
            "member",
            "save",
            json!({"name":"../escape","bot":"owl","content":CONTENT})
        )
        .await
        .is_err()
    );
    assert!(
        rpc(
            h,
            "member",
            "save",
            json!({"name":"bad","bot":"owl","content":"No frontmatter"})
        )
        .await
        .is_err()
    );
    rpc(
        h,
        "member",
        "delete",
        json!({"name":"custom-notes","bot":"owl"}),
    )
    .await
    .unwrap();
    assert!(!h.join("profiles/owl/skills/work/custom-notes").exists());
}
#[tokio::test]
async fn live_grants_body_edits_and_read_tools_without_authoring() {
    let home = setup();
    let h = home.path();
    common::write_config(
        &h.join("profiles/owl"),
        &json!({"tools":{"enabled_toolsets":[]}}),
    )
    .unwrap();
    rpc(
        h,
        "local",
        "save",
        json!({"name":"custom-notes","content":CONTENT,"bots_disabled":["fox"]}),
    )
    .await
    .unwrap();
    assert!(
        !skills::find(h, Some("fox"), "custom-notes")
            .unwrap()
            .enabled
    );
    let names = native_product_tools::descriptors(h, "owl").unwrap();
    assert!(names.iter().any(|v| v["name"] == "skill_view"));
    assert!(names.iter().any(|v| v["name"] == "skills_list"));
    assert!(!names.iter().any(|v| v["name"] == "skill_manage"));
    assert_eq!(
        tool(h, "skill_view", json!({"name":"custom-notes"}))
            .await
            .unwrap()["content"],
        CONTENT
    );
    rpc(
        h,
        "local",
        "save",
        json!({"name":"custom-notes","content":CONTENT.replace("Private body.","Updated body.")}),
    )
    .await
    .unwrap();
    assert!(
        tool(h, "skill_view", json!({"name":"custom-notes"}))
            .await
            .unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("Updated body.")
    );
    rpc(
        h,
        "member",
        "set_for_bot",
        json!({"name":"custom-notes","bot":"owl","enabled":false}),
    )
    .await
    .unwrap();
    assert_eq!(
        tool(h, "skill_view", json!({"name":"custom-notes"}))
            .await
            .unwrap_err()
            .code,
        4302
    );
    assert!(
        !tool(h, "skills_list", json!({})).await.unwrap()["skills"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["name"] == "custom-notes")
    );
    rpc(
        h,
        "member",
        "set_for_bot",
        json!({"name":"custom-notes","bot":"owl","enabled":true}),
    )
    .await
    .unwrap();
    rpc(
        h,
        "local",
        "set_global",
        json!({"name":"custom-notes","enabled":false}),
    )
    .await
    .unwrap();
    assert_eq!(
        tool(h, "skill_view", json!({"name":"custom-notes"}))
            .await
            .unwrap_err()
            .code,
        4302
    );
    rpc(
        h,
        "local",
        "set_global",
        json!({"name":"custom-notes","enabled":true}),
    )
    .await
    .unwrap();
    assert!(
        tool(h, "skill_view", json!({"name":"custom-notes"}))
            .await
            .is_ok()
    );
    assert_eq!(
        tool(
            h,
            "skill_manage",
            json!({"action":"delete","name":"custom-notes"})
        )
        .await
        .unwrap_err()
        .code,
        4302
    );
    let bot = catalog::bot(h, "member", "owl").unwrap();
    assert!(
        bot["skills"]
            .as_array()
            .unwrap()
            .contains(&json!("custom-notes"))
    );
    catalog::call(
        h,
        "member",
        "hexbot.bots.update",
        &json!({"name":"owl","skills":[]}),
    )
    .unwrap()
    .unwrap();
    assert!(
        !skills::find(h, Some("owl"), "custom-notes")
            .unwrap()
            .enabled
    );
    rpc(
        h,
        "local",
        "save",
        json!({"name":"later-skill","content":CONTENT}),
    )
    .await
    .unwrap();
    assert!(skills::find(h, Some("owl"), "later-skill").unwrap().enabled);
    catalog::call(
        h,
        "member",
        "profiles.configure",
        &json!({"name":"owl", "disabled_skills":["later-skill"]}),
    )
    .unwrap()
    .unwrap();
    assert!(!skills::find(h, Some("owl"), "later-skill").unwrap().enabled);
}
#[tokio::test]
async fn share_clashes_delete_reverts_and_supporting_files_survive() {
    let home = setup();
    let h = home.path();
    let bundled = skills::resolve(h, None)
        .unwrap()
        .into_iter()
        .find(|s| s.source == "bundled")
        .unwrap();
    assert_eq!(
        rpc(h, "local", "delete", json!({"name":bundled.name}))
            .await
            .unwrap_err()
            .message,
        "Bundled skills can be turned off, not deleted."
    );
    rpc(
        h,
        "local",
        "save",
        json!({"name":bundled.name,"content":CONTENT}),
    )
    .await
    .unwrap();
    assert_eq!(
        skills::find(h, None, &bundled.name).unwrap().source,
        "library"
    );
    rpc(h, "local", "delete", json!({"name":bundled.name}))
        .await
        .unwrap();
    assert_eq!(
        skills::find(h, None, &bundled.name).unwrap().source,
        "bundled"
    );
    rpc(
        h,
        "local",
        "save",
        json!({"bot":"fox","name":"custom-notes","category":"work","content":CONTENT}),
    )
    .await
    .unwrap();
    let dir = h.join("profiles/fox/skills/work/custom-notes");
    fs::create_dir(dir.join("references")).unwrap();
    fs::write(dir.join("references/guide.md"), "guide").unwrap();
    rpc(
        h,
        "local",
        "save",
        json!({"name":"custom-notes","content":CONTENT.replace("Private body.","Library body.")}),
    )
    .await
    .unwrap();
    assert_eq!(
        rpc(
            h,
            "local",
            "share",
            json!({"name":"custom-notes","bot":"fox"})
        )
        .await
        .unwrap_err()
        .code,
        4208
    );
    assert!(dir.exists());
    rpc(
        h,
        "local",
        "share",
        json!({"name":"custom-notes","bot":"fox","replace":true}),
    )
    .await
    .unwrap();
    assert!(!dir.exists());
    let result = rpc(h, "local", "get", json!({"name":"custom-notes"}))
        .await
        .unwrap();
    assert_eq!(result["content"], CONTENT);
    assert_eq!(result["files"], json!(["SKILL.md", "references/guide.md"]));
    assert!(
        rpc(
            h,
            "local",
            "share",
            json!({"name":"custom-notes","bot":"fox","replace":true})
        )
        .await
        .is_err()
    );
    // Editing the inherited skill creates an override with its supporting files.
    rpc(
        h,
        "member",
        "save",
        json!({"name":"custom-notes","bot":"owl","category":"writing","content":CONTENT}),
    )
    .await
    .unwrap();
    assert!(
        h.join("profiles/owl/skills/writing/custom-notes/references/guide.md")
            .exists()
    );
    rpc(
        h,
        "member",
        "delete",
        json!({"name":"custom-notes","bot":"owl"}),
    )
    .await
    .unwrap();
    assert_eq!(
        skills::find(h, Some("owl"), "custom-notes").unwrap().source,
        "library"
    );
    tool(
        h,
        "skill_manage",
        json!({"action":"delete","name":"custom-notes"}),
    )
    .await
    .unwrap();
    assert!(skills::find(h, None, "custom-notes").unwrap().enabled);
    assert!(
        !skills::find(h, Some("owl"), "custom-notes")
            .unwrap()
            .enabled
    );
}

#[test]
fn new_bots_use_library_without_copies_or_frozen_global_disables() {
    let home = setup();
    let h = home.path();
    let bundled = skills::resolve(h, None).unwrap().remove(0);
    skills::set_enabled(h, None, &bundled.name, false).unwrap();
    catalog::call(
        h,
        "member",
        "hexbot.bots.create",
        &json!({"name":"new-owl"}),
    )
    .unwrap()
    .unwrap();
    assert!(!h.join("profiles/new-owl/skills").exists());
    assert!(
        !skills::find(h, Some("new-owl"), &bundled.name)
            .unwrap()
            .enabled
    );
    skills::set_enabled(h, None, &bundled.name, true).unwrap();
    assert!(
        skills::find(h, Some("new-owl"), &bundled.name)
            .unwrap()
            .enabled
    );
    assert!(
        common::read_config(&h.join("profiles/new-owl")).unwrap()["skills"]["disabled"].is_null()
    );
}

#[tokio::test]
async fn changes_reach_library_readers_and_only_private_skill_owners() {
    let home = setup();
    let h = home.path();
    let app = hexbot_core::server::App::new(
        h.into(),
        "127.0.0.1:0".parse().unwrap(),
        "/unused-pi".into(),
        None,
    )
    .unwrap();
    let mut events = app.events.subscribe();
    app.call(
        "local",
        "hexbot.skills.save",
        &json!({"name":"custom-notes","content":CONTENT}),
    )
    .await
    .unwrap();
    let mut owners = vec![];
    while let Ok(event) = events.try_recv() {
        if event.frame["params"]["type"] == "hexbot.skills.changed" {
            owners.push(event.owner);
        }
    }
    owners.sort();
    assert_eq!(owners, ["local", "member"]);
    app.call(
        "member",
        "hexbot.skills.save",
        &json!({"name":"private-notes","bot":"owl","content":CONTENT}),
    )
    .await
    .unwrap();
    let mut owners = vec![];
    while let Ok(event) = events.try_recv() {
        if event.frame["params"]["type"] == "hexbot.skills.changed" {
            owners.push(event.owner);
            assert_eq!(event.frame["params"]["payload"]["bot"], "owl");
        }
    }
    assert_eq!(owners, ["member"]);
    app.shutdown().await;
}

#[test]
fn admin_library_writes_still_require_ownership_of_every_affected_bot() {
    let home = setup();
    let h = home.path();
    skills::call(
        h,
        "member",
        "hexbot.skills.save",
        &json!({"bot":"owl","name":"notes","content":CONTENT}),
    )
    .unwrap();
    assert_eq!(
        skills::call(
            h,
            "local",
            "hexbot.skills.share",
            &json!({"bot":"owl","name":"notes"})
        )
        .unwrap_err()
        .code,
        4302
    );
    assert!(h.join("profiles/owl/skills/notes/SKILL.md").is_file());
    assert!(!h.join("skills/notes").exists());
    // The owned bot appears first: validation must finish before any grant or file write.
    assert_eq!(
        skills::call(
            h,
            "local",
            "hexbot.skills.save",
            &json!({"name":"notes","content":CONTENT,"bots_disabled":["fox","owl"]})
        )
        .unwrap_err()
        .code,
        4302
    );
    assert!(!h.join("skills/notes").exists());
    assert!(common::read_config(&h.join("profiles/fox")).unwrap()["skills"]["disabled"].is_null());
}

#[test]
fn legacy_selection_preserves_both_grants_while_globally_disabled() {
    let home = setup();
    let h = home.path();
    for name in ["allowed", "denied"] {
        skills::call(
            h,
            "local",
            "hexbot.skills.save",
            &json!({"name":name,"content":CONTENT}),
        )
        .unwrap();
        skills::set_enabled(h, None, name, false).unwrap();
    }
    skills::set_enabled(h, Some("owl"), "denied", false).unwrap();
    let list = skills::call(h, "member", "hexbot.skills.list", &json!({"bot":"owl"})).unwrap();
    let allowed = list["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "allowed")
        .unwrap();
    assert_eq!(allowed["enabled_for_bot"], true);
    assert_eq!(allowed["disabled_globally"], true);
    assert_eq!(allowed["enabled"], false);
    for selected in [json!([]), json!(["allowed", "denied"])] {
        catalog::call(
            h,
            "member",
            "hexbot.bots.update",
            &json!({"name":"owl","skills":selected}),
        )
        .unwrap()
        .unwrap();
        assert!(
            skills::find(h, Some("owl"), "allowed")
                .unwrap()
                .enabled_for_bot
        );
        assert!(
            !skills::find(h, Some("owl"), "denied")
                .unwrap()
                .enabled_for_bot
        );
    }
    for name in ["allowed", "denied"] {
        skills::set_enabled(h, None, name, true).unwrap();
    }
    assert!(skills::find(h, Some("owl"), "allowed").unwrap().enabled);
    assert!(!skills::find(h, Some("owl"), "denied").unwrap().enabled);
}

#[tokio::test]
async fn nested_batch_destinations_are_rejected_in_either_order_before_commit() {
    let home = setup();
    let h = home.path();
    common::write_config(
        &h.join("profiles/owl"),
        &json!({"tools":{"enabled_toolsets":["skills"]}}),
    )
    .unwrap();
    let parent = json!({"action":"create","name":"alpha","content":CONTENT});
    let child = json!({"action":"create","name":"beta","category":"alpha/sub","content":CONTENT});
    for operations in [json!([parent, child]), json!([child, parent])] {
        assert_eq!(
            tool(h, "skill_manage", json!({"operations":operations}))
                .await
                .unwrap_err()
                .code,
            4202
        );
        assert!(!h.join("profiles/owl/skills/alpha").exists());
    }
    rpc(
        h,
        "member",
        "save",
        json!({"bot":"owl","name":"beta","category":"alpha/sub","content":CONTENT}),
    )
    .await
    .unwrap();
    assert_eq!(
        rpc(
            h,
            "member",
            "save",
            json!({"bot":"owl","name":"alpha","content":CONTENT})
        )
        .await
        .unwrap_err()
        .code,
        4202
    );
    assert_eq!(
        tool(h, "skill_manage", parent).await.unwrap_err().code,
        4202
    );
    assert!(skills::find(h, Some("owl"), "beta").is_ok());
    assert_eq!(tool(h, "skill_manage", json!({"action":"write_file","name":"beta","file_path":"scripts/nested/SKILL.md","file_content":CONTENT})).await.unwrap_err().code, 4202);
    assert!(
        !h.join("profiles/owl/skills/alpha/sub/beta/scripts/nested/SKILL.md")
            .exists()
    );
}

#[tokio::test]
async fn concurrent_connector_and_skill_updates_preserve_both_config_changes() {
    use std::sync::{Arc, Barrier};
    let home = setup();
    let h = home.path();
    skills::call(
        h,
        "local",
        "hexbot.skills.save",
        &json!({"name":"notes","content":CONTENT}),
    )
    .unwrap();
    for _ in 0..50 {
        skills::set_enabled(h, Some("owl"), "notes", true).unwrap();
        connectors::call(
            h,
            "member",
            "hexbot.connectors.set_for_bot",
            &json!({"bot":"owl","id":"web_search","enabled":true}),
        )
        .await
        .unwrap()
        .unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let ready = barrier.clone();
        let path = h.to_owned();
        let writer = std::thread::spawn(move || {
            ready.wait();
            skills::call(
                &path,
                "member",
                "hexbot.skills.set_for_bot",
                &json!({"bot":"owl","name":"notes","enabled":false}),
            )
            .unwrap();
        });
        barrier.wait();
        connectors::call(
            h,
            "member",
            "hexbot.connectors.set_for_bot",
            &json!({"bot":"owl","id":"web_search","enabled":false}),
        )
        .await
        .unwrap()
        .unwrap();
        writer.join().unwrap();
        assert!(!skills::find(h, Some("owl"), "notes").unwrap().enabled);
        let config = common::read_config(&h.join("profiles/owl")).unwrap();
        assert!(
            !config["tools"]["enabled_toolsets"]
                .as_array()
                .unwrap()
                .contains(&json!("web"))
        );
    }
}

#[tokio::test]
async fn concurrent_reads_never_lose_private_skills_during_saves_or_tool_commits() {
    use std::sync::{Arc, Barrier};
    let home = setup();
    let h = home.path();
    common::write_config(
        &h.join("profiles/owl"),
        &json!({"tools":{"enabled_toolsets":["skills"]}}),
    )
    .unwrap();
    rpc(
        h,
        "local",
        "save",
        json!({"name":"notes","content":CONTENT.replace("Private", "Library")}),
    )
    .await
    .unwrap();
    rpc(
        h,
        "member",
        "save",
        json!({"bot":"owl","name":"notes","content":CONTENT}),
    )
    .await
    .unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let ready = barrier.clone();
    let path = h.to_owned();
    let reader = std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        ready.wait();
        for _ in 0..100 {
            assert_eq!(
                skills::find(&path, Some("owl"), "notes").unwrap().source,
                "bot"
            );
            let value = skills::call(
                &path,
                "member",
                "hexbot.skills.get",
                &json!({"bot":"owl","name":"notes"}),
            )
            .unwrap();
            assert_eq!(value["content"], CONTENT);
            assert_eq!(
                rt.block_on(tool(&path, "skill_view", json!({"name":"notes"})))
                    .unwrap()["content"],
                CONTENT
            );
            assert_eq!(skills::read_body(&path, "owl", "notes").unwrap(), CONTENT);
        }
    });
    barrier.wait();
    for index in 0..100 {
        rpc(h, "member", "save", json!({"bot":"owl","name":"notes","category":if index % 2 == 0 {"work"} else {""},"content":CONTENT})).await.unwrap();
        assert_eq!(
            tool(
                h,
                "skill_manage",
                json!({"action":"patch","name":"notes","content":CONTENT})
            )
            .await
            .unwrap()["success"],
            true
        );
    }
    reader.join().unwrap();
}
