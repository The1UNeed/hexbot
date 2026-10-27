use crate::{common, connectors, db, plugins};
use serde_json::{Value, json};
use std::{fs, path::Path};

#[test]
fn disabled_connector_with_an_incident_is_not_ready() {
    let home = setup();
    common::write_config(
        home.path(),
        &json!({"mcp_servers": {
            "files": {"command": "node", "disabled": true, "bots": []}
        }}),
    )
    .unwrap();
    db::open(home.path()).unwrap().execute(
        "INSERT INTO bot_incidents(id,bot,kind,connector,text,created_at) VALUES ('incident','owl','connector_error','mcp:files','old failure',0)",
        [],
    ).unwrap();
    let listed = call(home.path(), "alice", "hexbot.plugins.list", json!({})).unwrap();
    assert_eq!(row(&listed, "connectors", "mcp:files")["ready"], false);
    assert_eq!(
        call(
            home.path(),
            "alice",
            "hexbot.plugins.set_bots",
            json!({
                "kind":"connector", "id":"mcp:files", "bots":["owl"]
            })
        )
        .unwrap_err()
        .code,
        4209
    );
}

#[test]
fn recreated_bot_does_not_inherit_grants_after_cleanup_error() {
    let home = setup();
    common::write_config(
        home.path(),
        &json!({"mcp_servers": {
            "a": {"command":"node", "bots":["owl"]},
            "b": {"command":"node", "bots":["owl"]}
        }}),
    )
    .unwrap();
    let unrelated = home.path().join("profiles/cat/config.yaml");
    fs::write(&unrelated, "mcp_servers: [\n").unwrap();
    let deleted = crate::catalog::call(
        home.path(),
        "alice",
        "hexbot.bots.delete",
        &json!({"name":"owl"}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(deleted["deleted"], true);
    assert_eq!(deleted["history_pending"], true);
    assert!(
        crate::catalog::call(
            home.path(),
            "alice",
            "hexbot.bots.create",
            &json!({"name":"owl"})
        )
        .unwrap()
        .is_err()
    );
    fs::write(&unrelated, "{}\n").unwrap();
    let create = || {
        crate::catalog::call(
            home.path(),
            "alice",
            "hexbot.bots.create",
            &json!({"name":"owl"}),
        )
        .unwrap()
    };
    crate::catalog::finish_bot_deletes(home.path()).unwrap();
    create().unwrap();
    assert!(
        servers(home.path(), "owl").is_empty(),
        "new bot inherited deleted bot's MCP assignment"
    );
}

/// Alice owns owl and cat; Bob owns fox.
fn setup() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    db::open(home.path()).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES ('alice','Alice','admin',0),('bob','Bob','member',0); INSERT INTO bots(name,owner_id) VALUES ('owl','alice'),('cat','alice'),('fox','bob');").unwrap();
    for bot in ["owl", "cat", "fox"] {
        fs::create_dir_all(home.path().join("profiles").join(bot)).unwrap();
    }
    home
}
fn call(home: &Path, who: &str, method: &str, p: Value) -> crate::Result<Value> {
    plugins::call(home, who, method, &p).expect("plugins method")
}
fn row<'a>(list: &'a Value, group: &str, id: &str) -> &'a Value {
    list[group]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == id)
        .unwrap_or_else(|| panic!("{group} has no {id}"))
}
fn servers(home: &Path, bot: &str) -> Vec<String> {
    connectors::mcp_servers(home, bot)
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect()
}
async fn add_mcp(home: &Path, p: Value) -> Value {
    connectors::call(home, "alice", "hexbot.connectors.add_mcp", &p)
        .await
        .unwrap()
        .unwrap()
}
fn skill(home: &Path, name: &str, frontmatter: &str) {
    let dir = home.join("skills/testing").join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: Test skill\n{frontmatter}---\nBody\n"),
    )
    .unwrap();
}

#[tokio::test]
async fn a_new_server_reaches_only_the_bots_it_is_given() {
    let home = setup();
    add_mcp(home.path(), json!({"name":"files","command":"node"})).await;
    assert!(servers(home.path(), "owl").is_empty());
    assert!(servers(home.path(), "fox").is_empty());

    let given = call(
        home.path(),
        "alice",
        "hexbot.plugins.set_bots",
        json!({"kind":"connector","id":"mcp:files","bots":["owl","cat"]}),
    )
    .unwrap();
    assert_eq!(given["plugin"]["bots"], json!(["cat", "owl"]));
    assert_eq!(servers(home.path(), "owl"), ["files"]);
    assert!(servers(home.path(), "fox").is_empty());

    // Saving the server again keeps its bots; saving from a bot's settings adds it.
    add_mcp(home.path(), json!({"name":"files","command":"npx"})).await;
    assert_eq!(servers(home.path(), "cat"), ["files"]);
    connectors::set_enabled(home.path(), "cat", "mcp:files", false).unwrap();
    add_mcp(
        home.path(),
        json!({"name":"files","command":"npx","bot":"cat"}),
    )
    .await;
    assert_eq!(servers(home.path(), "cat"), ["files"]);
    assert_eq!(
        connectors::mcp_servers(home.path(), "owl").unwrap()["files"]["command"],
        "npx"
    );

    // A deleted bot leaves every list, so a new bot of that name starts with none.
    connectors::forget_bot(home.path(), "owl").unwrap();
    assert_eq!(
        common::read_config(home.path()).unwrap()["mcp_servers"]["files"]["bots"],
        json!(["cat"])
    );
}

#[tokio::test]
async fn assigning_keeps_other_owners_bots_and_refuses_theirs() {
    let home = setup();
    add_mcp(home.path(), json!({"name":"files","command":"node"})).await;
    connectors::assign_mcp(home.path(), "files", &["fox".into(), "owl".into()]).unwrap();
    call(
        home.path(),
        "alice",
        "hexbot.plugins.set_bots",
        json!({"kind":"connector","id":"mcp:files","bots":["cat"]}),
    )
    .unwrap();
    assert_eq!(servers(home.path(), "fox"), ["files"]);
    assert!(servers(home.path(), "owl").is_empty());
    assert_eq!(
        call(
            home.path(),
            "alice",
            "hexbot.plugins.set_bots",
            json!({"kind":"connector","id":"mcp:files","bots":["fox"]}),
        )
        .unwrap_err()
        .code,
        4302
    );
    let listed = call(home.path(), "alice", "hexbot.plugins.list", json!({})).unwrap();
    assert_eq!(
        row(&listed, "connectors", "mcp:files")["bots"],
        json!(["cat"])
    );
}

#[test]
fn migration_writes_each_servers_bots_and_drops_profile_copies() {
    let home = setup();
    common::write_config(
        home.path(),
        &json!({"mcp_servers":{
            "shared":{"command":"node"},
            "picked":{"command":"node","bots":["cat"]}
        }}),
    )
    .unwrap();
    // Older versions copied every server into each profile and switched it off there.
    common::write_config(
        &home.path().join("profiles/fox"),
        &json!({"mcp_servers":{"shared":{"command":"stale","disabled":true},"own":{"command":"mine"}}}),
    )
    .unwrap();
    common::write_config(
        &home.path().join("profiles/owl"),
        &json!({"mcp_servers":{"shared":{"command":"stale"}}}),
    )
    .unwrap();
    // Before migrating, a server without a list reaches every bot but one
    // switched off in its profile, and never takes the profile's stale copy.
    assert_eq!(
        connectors::mcp_servers(home.path(), "owl").unwrap()["shared"]["command"],
        "node"
    );
    assert!(!servers(home.path(), "fox").contains(&"shared".into()));

    db::migrate(home.path()).unwrap();
    let root = common::read_config(home.path()).unwrap();
    assert_eq!(root["mcp_servers"]["shared"]["bots"], json!(["cat", "owl"]));
    assert_eq!(root["mcp_servers"]["picked"]["bots"], json!(["cat"]));
    let fox = common::read_config(&home.path().join("profiles/fox")).unwrap();
    assert_eq!(fox["mcp_servers"], json!({"own":{"command":"mine"}}));
    assert_eq!(servers(home.path(), "fox"), ["own"]);
    assert_eq!(servers(home.path(), "owl"), ["shared"]);
    // Migrating again changes nothing.
    db::migrate(home.path()).unwrap();
    assert_eq!(common::read_config(home.path()).unwrap(), root);
}

#[test]
fn a_skill_waiting_for_setup_is_hidden_and_cannot_be_given() {
    let home = setup();
    skill(
        home.path(),
        "needs-tool",
        "prerequisites:\n  commands: [hexbot-test-missing-command]\n",
    );
    skill(
        home.path(),
        "needs-key",
        "prerequisites:\n  env_vars: [HEXBOT_TEST_SKILL_KEY]\n",
    );
    skill(home.path(), "elsewhere", "platforms: [plan9]\n");
    skill(home.path(), "plain", "");

    let listed = call(
        home.path(),
        "alice",
        "hexbot.plugins.list",
        json!({"bot":"owl"}),
    )
    .unwrap();
    let tool = row(&listed, "skills", "needs-tool");
    assert_eq!(tool["ready"], false);
    assert_eq!(tool["enabled"], false);
    assert_eq!(
        tool["missing"],
        json!([{"kind":"command","name":"hexbot-test-missing-command"}])
    );
    // Its bots are the ones it would reach once set up.
    assert_eq!(tool["bots"], json!(["cat", "owl"]));
    assert_eq!(
        row(&listed, "skills", "elsewhere")["missing"],
        json!([{"kind":"platform","name":["plan9"]}])
    );
    assert_eq!(row(&listed, "skills", "plain")["enabled"], true);
    assert!(row(&listed, "skills", "plain").get("path").is_none());
    let enabled = crate::catalog::enabled_skills(home.path(), "owl").unwrap();
    assert!(enabled.iter().any(|s| s["name"] == "plain"));
    assert!(!enabled.iter().any(|s| s["name"] == "needs-tool"));

    call(
        home.path(),
        "alice",
        "hexbot.plugins.set_bots",
        json!({"kind":"skill","id":"needs-key","bots":[]}),
    )
    .unwrap();
    assert_eq!(
        call(
            home.path(),
            "alice",
            "hexbot.plugins.set_bots",
            json!({"kind":"skill","id":"needs-key","bots":["owl"]}),
        )
        .unwrap_err()
        .code,
        4209
    );
    // Saving the key sets the skill up; giving it to a bot then works.
    fs::write(home.path().join(".env"), "HEXBOT_TEST_SKILL_KEY=value\n").unwrap();
    let given = call(
        home.path(),
        "alice",
        "hexbot.plugins.set_bots",
        json!({"kind":"skill","id":"needs-key","bots":["owl"]}),
    )
    .unwrap();
    assert_eq!(given["plugin"]["ready"], true);
    assert_eq!(given["plugin"]["bots"], json!(["owl"]));
}

#[test]
fn saving_a_bots_skills_keeps_its_choice_for_one_waiting_for_setup() {
    let home = setup();
    skill(
        home.path(),
        "needs-tool",
        "prerequisites:\n  commands: [hexbot-test-missing-command]\n",
    );
    skill(home.path(), "plain", "");
    // The client sends the skills it shows as on; the waiting one is not among them.
    crate::catalog::call(
        home.path(),
        "alice",
        "hexbot.bots.update",
        &json!({"name":"owl","skills":["plain"]}),
    )
    .unwrap()
    .unwrap();
    let owl = crate::skills::resolve(home.path(), Some("owl")).unwrap();
    assert!(
        owl.iter()
            .any(|s| s.name == "needs-tool" && s.enabled_for_bot)
    );
}

#[test]
fn a_capability_that_is_not_set_up_cannot_be_given() {
    let home = setup();
    common::write_config(
        home.path(),
        &json!({"computer_use":{"command":"/nonexistent/hexbot-test-cua"}}),
    )
    .unwrap();
    let listed = call(home.path(), "alice", "hexbot.plugins.list", json!({})).unwrap();
    let computer = row(&listed, "capabilities", "computer_use");
    assert_eq!(computer["ready"], false);
    assert!(computer["setup"].as_str().unwrap().contains("uv tool install cua"));
    assert_eq!(
        call(
            home.path(),
            "alice",
            "hexbot.plugins.set_bots",
            json!({"kind":"capability","id":"computer_use","bots":["owl"]}),
        )
        .unwrap_err()
        .code,
        4209
    );
    assert_eq!(
        call(
            home.path(),
            "alice",
            "hexbot.plugins.set_bots",
            json!({"kind":"lamp","id":"x","bots":[]}),
        )
        .unwrap_err()
        .code,
        4202
    );
}

#[test]
fn a_connector_waiting_for_its_key_can_still_be_taken_away() {
    let home = setup();
    let listed = call(home.path(), "alice", "hexbot.plugins.list", json!({})).unwrap();
    let notion = row(&listed, "connectors", "notion");
    if notion["ready"] == true {
        return; // NOTION_API_KEY is set in this environment.
    }
    assert_eq!(notion["bots"], json!(["cat", "owl"]));
    call(
        home.path(),
        "alice",
        "hexbot.plugins.set_bots",
        json!({"kind":"connector","id":"notion","bots":["cat"]}),
    )
    .unwrap();
    // Saving the key later must not bring it back to owl.
    fs::write(home.path().join(".env"), "NOTION_API_KEY=secret\n").unwrap();
    let listed = call(home.path(), "alice", "hexbot.plugins.list", json!({})).unwrap();
    assert_eq!(row(&listed, "connectors", "notion")["bots"], json!(["cat"]));
}

#[test]
fn assigning_the_cloud_browser_keeps_the_daemons_provider() {
    let home = setup();
    common::write_config(
        home.path(),
        &json!({"browser":{"cloud_provider":"browser-use"}}),
    )
    .unwrap();
    fs::write(home.path().join(".env"), "BROWSER_USE_API_KEY=secret\n").unwrap();
    for bots in [json!(["owl", "cat"]), json!(["owl"]), json!(["cat", "owl"])] {
        let given = call(
            home.path(),
            "alice",
            "hexbot.plugins.set_bots",
            json!({"kind":"connector","id":"cloud_browser","bots":bots}),
        )
        .unwrap();
        let mut want = strings_of(&bots);
        want.sort();
        assert_eq!(given["plugin"]["bots"], json!(want));
        assert_eq!(
            common::read_config(home.path()).unwrap()["browser"]["cloud_provider"],
            "browser-use"
        );
    }
}
fn strings_of(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}
