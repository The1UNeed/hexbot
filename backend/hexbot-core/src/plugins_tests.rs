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
fn a_switched_off_server_keeps_who_it_is_given_to() {
    let home = setup();
    common::write_config(
        home.path(),
        &json!({"mcp_servers": {
            "files": {"command": "node", "disabled": true, "bots": ["fox", "owl"]}
        }}),
    )
    .unwrap();
    call(
        home.path(),
        "alice",
        "hexbot.plugins.set_bots",
        json!({"kind":"connector","id":"mcp:files","bots":[]}),
    )
    .unwrap();
    assert_eq!(
        common::read_config(home.path()).unwrap()["mcp_servers"]["files"]["bots"],
        json!(["fox"])
    );
}

#[test]
fn a_switched_off_server_can_be_taken_from_one_of_its_bots() {
    let home = setup();
    common::write_config(
        home.path(),
        &json!({"mcp_servers": {
            "files": {"command": "node", "disabled": true, "bots": ["cat", "owl"]}
        }}),
    )
    .unwrap();
    let listed = call(home.path(), "alice", "hexbot.plugins.list", json!({})).unwrap();
    assert_eq!(
        row(&listed, "connectors", "mcp:files")["bots"],
        json!(["cat", "owl"])
    );
    call(
        home.path(),
        "alice",
        "hexbot.plugins.set_bots",
        json!({"kind":"connector","id":"mcp:files","bots":["owl"]}),
    )
    .unwrap();
    assert_eq!(
        common::read_config(home.path()).unwrap()["mcp_servers"]["files"]["bots"],
        json!(["owl"])
    );
}

#[test]
fn a_revoke_racing_a_keep_never_regives_a_switched_off_server() {
    let home = setup();
    for _ in 0..20 {
        common::write_config(
            home.path(),
            &json!({"mcp_servers": {
                "files": {"command": "node", "disabled": true, "bots": ["owl"]}
            }}),
        )
        .unwrap();
        let assign = |bots: Value| {
            call(
                home.path(),
                "alice",
                "hexbot.plugins.set_bots",
                json!({"kind":"connector","id":"mcp:files","bots":bots}),
            )
        };
        std::thread::scope(|scope| {
            scope.spawn(|| assign(json!([])).unwrap());
            scope.spawn(|| {
                let _ = assign(json!(["owl"]));
            });
        });
        assert_eq!(
            common::read_config(home.path()).unwrap()["mcp_servers"]["files"]["bots"],
            json!([])
        );
    }
}

#[test]
fn a_skill_ready_through_a_bots_own_key_can_be_given_to_that_bot() {
    let home = setup();
    skill(
        home.path(),
        "needs-key",
        "prerequisites:\n  env_vars: [HEXBOT_TEST_OWL_ONLY_KEY]\n",
    );
    fs::write(
        home.path().join("profiles/owl/.env"),
        "HEXBOT_TEST_OWL_ONLY_KEY=set\n",
    )
    .unwrap();
    let assign = |bots: Value| {
        call(
            home.path(),
            "alice",
            "hexbot.plugins.set_bots",
            json!({"kind":"skill","id":"needs-key","bots":bots}),
        )
    };
    assign(json!([])).unwrap();
    assign(json!(["owl"])).unwrap();
    assert_eq!(assign(json!(["owl", "cat"])).unwrap_err().code, 4209);
    // A bot asking for itself is checked with its own keys too.
    assign(json!([])).unwrap();
    plugins::set_for_bot(home.path(), "alice", "skill", "needs-key", "owl", true).unwrap();
    assert_eq!(
        plugins::set_for_bot(home.path(), "alice", "skill", "needs-key", "cat", true)
            .unwrap_err()
            .code,
        4209
    );
}

#[test]
fn a_bot_asking_for_a_skill_leaves_other_bots_as_they_are() {
    let home = setup();
    skill(home.path(), "plain", "");
    let assign = |bots: Value| {
        call(
            home.path(),
            "alice",
            "hexbot.plugins.set_bots",
            json!({"kind":"skill","id":"plain","bots":bots}),
        )
        .unwrap()
    };
    assign(json!(["owl"]));
    // Owl taken away meanwhile, then Cat's own change lands.
    assign(json!([]));
    plugins::set_for_bot(home.path(), "alice", "skill", "plain", "cat", true).unwrap();
    assert_eq!(skill_on(home.path(), "owl", "plain"), Some(false));
    assert_eq!(skill_on(home.path(), "cat", "plain"), Some(true));
}

#[test]
fn bots_given_a_server_at_the_same_time_all_keep_it() {
    let home = setup();
    let names = (0..12).map(|i| format!("bot{i}")).collect::<Vec<_>>();
    let conn = db::open(home.path()).unwrap();
    for name in &names {
        conn.execute("INSERT INTO bots(name,owner_id) VALUES (?,'alice')", [name])
            .unwrap();
        fs::create_dir_all(home.path().join("profiles").join(name)).unwrap();
    }
    common::write_config(
        home.path(),
        &json!({"mcp_servers": {"files": {"command": "node", "bots": []}}}),
    )
    .unwrap();
    std::thread::scope(|scope| {
        for name in &names {
            let home = home.path();
            scope.spawn(move || connectors::set_enabled(home, name, "mcp:files", true).unwrap());
        }
    });
    let mut given =
        strings_of(&common::read_config(home.path()).unwrap()["mcp_servers"]["files"]["bots"]);
    given.sort();
    let mut expected = names.clone();
    expected.sort();
    assert_eq!(given, expected);
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
fn taking_a_capability_keeps_other_tools_waiting_for_setup() {
    let home = setup();
    common::write_config(home.path(), &json!({"browser":{"backend":"off"}})).unwrap();
    common::write_config(
        &home.path().join("profiles/owl"),
        &json!({"tools":{"enabled_toolsets":["browser","computer_use","terminal"]}}),
    )
    .unwrap();
    call(
        home.path(),
        "alice",
        "hexbot.plugins.set_bots",
        json!({"kind":"capability","id":"computer_use","bots":[]}),
    )
    .unwrap();
    assert_eq!(
        connectors::toolsets(home.path(), "owl").unwrap(),
        ["browser", "terminal"]
    );
}

#[test]
fn a_bots_list_shows_its_own_view_of_each_skill() {
    let home = setup();
    skill(
        home.path(),
        "needs-key",
        "prerequisites:\n  env_vars: [HEXBOT_TEST_OWL_ONLY_KEY]\n",
    );
    skill(home.path(), "plain", "");
    fs::write(
        home.path().join("profiles/owl/.env"),
        "HEXBOT_TEST_OWL_ONLY_KEY=set\n",
    )
    .unwrap();
    crate::skills::set_enabled(home.path(), Some("owl"), "plain", false).unwrap();
    let listed = call(
        home.path(),
        "alice",
        "hexbot.plugins.list",
        json!({"bot":"owl"}),
    )
    .unwrap();
    assert_eq!(row(&listed, "skills", "needs-key")["ready"], true);
    let plain = row(&listed, "skills", "plain");
    assert_eq!(plain["enabled_for_bot"], false);
    assert_eq!(plain["enabled"], false);
    assert_eq!(plain["bots"], json!(["cat"]));
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
    assert!(
        computer["setup"]
            .as_str()
            .unwrap()
            .contains("uv tool install cua")
    );
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
fn a_connector_ready_through_a_bots_own_key_can_be_given_to_that_bot() {
    let home = setup();
    let listed = call(home.path(), "alice", "hexbot.plugins.list", json!({})).unwrap();
    if row(&listed, "connectors", "notion")["ready"] == true {
        return; // NOTION_API_KEY is set in this environment.
    }
    fs::write(
        home.path().join("profiles/owl/.env"),
        "NOTION_API_KEY=owl-only\n",
    )
    .unwrap();
    let assign = |bots: Value| {
        call(
            home.path(),
            "alice",
            "hexbot.plugins.set_bots",
            json!({"kind":"connector","id":"notion","bots":bots}),
        )
    };
    assign(json!([])).unwrap();
    assign(json!(["owl"])).unwrap();
    assert_eq!(assign(json!(["owl", "cat"])).unwrap_err().code, 4209);
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

const SKILL: &str = "---\ndescription: Find and file GitHub issues.\n---\nUse mcp__github__ tools.";

fn github() -> Value {
    json!({
        "name": "github",
        "description": "GitHub issues and pull requests",
        "mcp": {"command": "npx", "args": ["-y", "github-mcp"], "env": {"GITHUB_TOKEN": ""}},
        "skills": [{"name": "github-issues", "content": SKILL}],
    })
}
fn skill_on(home: &Path, bot: &str, name: &str) -> Option<bool> {
    crate::skills::resolve(home, Some(bot))
        .unwrap()
        .into_iter()
        .find(|s| s.name == name)
        .map(|s| s.enabled_for_bot)
}

#[tokio::test]
async fn a_package_installs_its_server_and_skills_as_one_plugin() {
    let home = setup();
    let mut install = github();
    install["bots"] = json!(["owl"]);
    let plugin =
        call(home.path(), "alice", "hexbot.plugins.install", install).unwrap()["plugin"].clone();
    assert_eq!(plugin["kind"], "package");
    assert_eq!(plugin["bots"], json!(["owl"]));
    assert_eq!(plugin["skills"][0]["name"], "github-issues");
    // A value left empty is for the user to fill in.
    assert_eq!(plugin["state"], "not_set_up");
    assert_eq!(plugin["state_text"], "Needs GITHUB_TOKEN");
    assert_eq!(plugin["server"]["command"], "npx");
    assert_eq!(
        plugin["server"]["env"],
        json!([{"key":"GITHUB_TOKEN","set":false,"hint":null}])
    );
    // Its server and skill are parts of the package, not rows of their own.
    let list = call(home.path(), "alice", "hexbot.plugins.list", json!({})).unwrap();
    for (group, id) in [("connectors", "mcp:github"), ("skills", "github-issues")] {
        assert!(
            !list[group]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["id"] == id),
            "{id}"
        );
    }
    assert_eq!(servers(home.path(), "owl"), ["github"]);
    assert!(servers(home.path(), "cat").is_empty());
    assert_eq!(skill_on(home.path(), "owl", "github-issues"), Some(true));
    assert_eq!(skill_on(home.path(), "cat", "github-issues"), Some(false));

    // Settings keep who has it and never send values back.
    let plugin = call(
        home.path(),
        "alice",
        "hexbot.plugins.configure",
        json!({"kind":"package","id":"github","env":{"GITHUB_TOKEN":"ghp_0123456789"}}),
    )
    .unwrap()["plugin"]
        .clone();
    assert_ne!(plugin["state"], "not_set_up");
    assert_eq!(plugin["server"]["env"][0]["hint"], "…6789");
    assert!(!plugin.to_string().contains("ghp_0123456789"));
    assert_eq!(plugin["bots"], json!(["owl"]));

    // Giving it to Cat instead moves both parts.
    let plugin = call(
        home.path(),
        "alice",
        "hexbot.plugins.set_bots",
        json!({"kind":"package","id":"github","bots":["cat"]}),
    )
    .unwrap()["plugin"]
        .clone();
    assert_eq!(plugin["bots"], json!(["cat"]));
    assert!(servers(home.path(), "owl").is_empty());
    assert_eq!(skill_on(home.path(), "owl", "github-issues"), Some(false));
    assert_eq!(skill_on(home.path(), "cat", "github-issues"), Some(true));
    // A part left on keeps the package on, so it can always be taken away.
    crate::skills::set_enabled(home.path(), Some("cat"), "github-issues", false).unwrap();
    let list = call(home.path(), "alice", "hexbot.plugins.list", json!({})).unwrap();
    assert_eq!(row(&list, "packages", "github")["bots"], json!(["cat"]));

    // Parts go with the package.
    let error = connectors::call(
        home.path(),
        "alice",
        "hexbot.connectors.remove_mcp",
        &json!({"name":"github"}),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(error.message.contains("Remove the plugin instead"));
    let error = connectors::call(
        home.path(),
        "alice",
        "hexbot.connectors.add_mcp",
        &json!({"name":"github","command":"other"}),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(error.code, 4208);
    for (method, p) in [
        ("hexbot.skills.delete", json!({"name":"github-issues"})),
        (
            "hexbot.skills.save",
            json!({"name":"github-issues","content":SKILL}),
        ),
    ] {
        let error = crate::skills::call(home.path(), "alice", method, &p).unwrap_err();
        assert!(
            error.message.contains("plugin github"),
            "{method}: {}",
            error.message
        );
    }
    crate::skills::call(
        home.path(),
        "alice",
        "hexbot.skills.save",
        &json!({"name":"github-issues","content":SKILL,"bot":"owl"}),
    )
    .unwrap();
    let error = crate::skills::call(
        home.path(),
        "alice",
        "hexbot.skills.share",
        &json!({"name":"github-issues","bot":"owl","replace":true}),
    )
    .unwrap_err();
    assert!(error.message.contains("plugin github"), "{}", error.message);
    crate::skills::call(
        home.path(),
        "alice",
        "hexbot.skills.delete",
        &json!({"name":"github-issues","bot":"owl"}),
    )
    .unwrap();

    call(
        home.path(),
        "alice",
        "hexbot.plugins.remove",
        json!({"kind":"package","id":"github"}),
    )
    .unwrap();
    let list = call(home.path(), "alice", "hexbot.plugins.list", json!({})).unwrap();
    assert!(list["packages"].as_array().unwrap().is_empty());
    assert!(servers(home.path(), "cat").is_empty());
    assert_eq!(skill_on(home.path(), "cat", "github-issues"), None);
    // Installed again for every bot, it is on for every bot of Alice's.
    call(home.path(), "alice", "hexbot.plugins.install", github()).unwrap();
    let list = call(home.path(), "alice", "hexbot.plugins.list", json!({})).unwrap();
    assert_eq!(
        row(&list, "packages", "github")["bots"],
        json!(["cat", "owl"])
    );
    assert!(servers(home.path(), "fox").is_empty());
}

#[test]
fn installs_are_checked_before_anything_is_written() {
    let home = setup();
    let error = |p: Value| {
        call(home.path(), "alice", "hexbot.plugins.install", p)
            .unwrap_err()
            .message
    };
    assert!(error(json!({"name":"Bad Name","skills":[]})).contains("plugin name"));
    assert!(error(json!({"name":"empty"})).contains("MCP server, a skill, or both"));
    assert!(
        error(json!({"name":"old","mcp":{"url":"https://example.com/sse","transport":"sse"}}))
            .contains("SSE")
    );
    assert!(error(json!({"name":"two","skills":[{"name":"a","content":SKILL},{"name":"a","content":SKILL}]})).contains("twice"));
    assert!(
        error(json!({"name":"nobody","skills":[{"name":"a","content":"no frontmatter"}]}))
            .contains("frontmatter")
    );
    // A bundled skill, and a skill a bot wrote for itself, keep their names.
    assert!(
        error(json!({"name":"mine","skills":[{"name":"notion","content":SKILL}]}))
            .contains("A skill named notion already exists")
    );
    let private = home.path().join("profiles/owl/skills/house-style");
    fs::create_dir_all(&private).unwrap();
    fs::write(private.join("SKILL.md"), SKILL).unwrap();
    assert!(
        error(json!({"name":"style","skills":[{"name":"house-style","content":SKILL}]}))
            .contains("A skill named house-style already exists")
    );
    assert!(!home.path().join("plugins/mine").exists());
    call(home.path(), "alice", "hexbot.plugins.install", github()).unwrap();
    assert!(error(github()).contains("already installed"));
    // Headers carry an HTTP server's token.
    let plugin = call(
        home.path(),
        "alice",
        "hexbot.plugins.install",
        json!({"name":"linear","mcp":{"url":"https://mcp.linear.app/mcp","headers":{"Authorization":""}}}),
    )
    .unwrap()["plugin"]
        .clone();
    assert_eq!(plugin["state_text"], "Needs Authorization");
    assert_eq!(plugin["server"]["url"], "https://mcp.linear.app/mcp");
}

#[test]
fn a_failed_install_leaves_nothing_behind() {
    let home = setup();
    fs::write(
        home.path().join("profiles/cat/config.yaml"),
        "tools: [unclosed",
    )
    .unwrap();
    assert!(call(home.path(), "alice", "hexbot.plugins.install", github()).is_err());
    assert!(!home.path().join("plugins/github").exists());
    let root = fs::read_to_string(home.path().join("config.yaml")).unwrap_or_default();
    assert!(!root.contains("github"), "{root}");
}

#[test]
fn new_bots_get_packages_for_every_bot_but_not_those_for_some() {
    let home = setup();
    let mut scoped = github();
    scoped["bots"] = json!(["owl", "cat"]);
    call(home.path(), "alice", "hexbot.plugins.install", scoped).unwrap();
    call(
        home.path(),
        "alice",
        "hexbot.plugins.install",
        json!({"name":"writing","skills":[{"name":"house-style","content":SKILL}]}),
    )
    .unwrap();
    crate::catalog::call(
        home.path(),
        "alice",
        "hexbot.bots.create",
        &json!({"name":"raven","display_name":"Raven"}),
    )
    .unwrap()
    .unwrap();
    let list = call(home.path(), "alice", "hexbot.plugins.list", json!({})).unwrap();
    // Installed for the bots there were, even all of them, it stays theirs.
    assert_eq!(
        row(&list, "packages", "github")["bots"],
        json!(["cat", "owl"])
    );
    assert!(servers(home.path(), "raven").is_empty());
    assert_eq!(
        row(&list, "packages", "writing")["bots"],
        json!(["cat", "owl", "raven"])
    );
    // Given to every bot from Settings, later bots get it with its values.
    call(
        home.path(),
        "alice",
        "hexbot.plugins.configure",
        json!({"kind":"package","id":"github","env":{"GITHUB_TOKEN":"ghp_0123456789"}}),
    )
    .unwrap();
    call(
        home.path(),
        "alice",
        "hexbot.plugins.set_bots",
        json!({"kind":"package","id":"github","bots":["owl","cat","raven"]}),
    )
    .unwrap();
    crate::catalog::call(
        home.path(),
        "alice",
        "hexbot.bots.create",
        &json!({"name":"wren","display_name":"Wren"}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(servers(home.path(), "wren"), ["github"]);
    assert_eq!(
        connectors::mcp_servers(home.path(), "wren").unwrap()["github"]["env"]["GITHUB_TOKEN"],
        "ghp_0123456789"
    );
    assert_eq!(skill_on(home.path(), "wren", "github-issues"), Some(true));
}

#[test]
fn a_bot_asking_for_itself_changes_only_itself() {
    let home = setup();
    let mut install = github();
    install["bots"] = json!(["owl"]);
    call(home.path(), "alice", "hexbot.plugins.install", install).unwrap();
    // Cat asks for it: Owl keeps it, and the scope gains only Cat, so a bot
    // created later still doesn't get it.
    plugins::set_for_bot(home.path(), "alice", "package", "github", "cat", true).unwrap();
    let list = call(home.path(), "alice", "hexbot.plugins.list", json!({})).unwrap();
    assert_eq!(
        row(&list, "packages", "github")["bots"],
        json!(["cat", "owl"])
    );
    crate::catalog::call(
        home.path(),
        "alice",
        "hexbot.bots.create",
        &json!({"name":"raven","display_name":"Raven"}),
    )
    .unwrap()
    .unwrap();
    assert!(servers(home.path(), "raven").is_empty());
    // Owl taken away meanwhile, then Cat's change lands: Owl stays off.
    call(
        home.path(),
        "alice",
        "hexbot.plugins.set_bots",
        json!({"kind":"package","id":"github","bots":["cat"]}),
    )
    .unwrap();
    plugins::set_for_bot(home.path(), "alice", "package", "github", "cat", true).unwrap();
    assert!(servers(home.path(), "owl").is_empty());
    assert_eq!(servers(home.path(), "cat"), ["github"]);
}

#[test]
fn settings_saved_at_the_same_time_all_keep_their_part() {
    let home = setup();
    call(
        home.path(),
        "alice",
        "hexbot.plugins.install",
        json!({"name":"api","mcp":{"url":"https://example.com/mcp"}}),
    )
    .unwrap();
    let threads = (0..12)
        .map(|i| {
            let home = home.path().to_path_buf();
            std::thread::spawn(move || {
                plugins::configure(
                    &home,
                    "api",
                    &json!({"headers": {format!("X-{i}"): "value"}}),
                )
                .unwrap()
            })
        })
        .collect::<Vec<_>>();
    for thread in threads {
        thread.join().unwrap();
    }
    let headers =
        crate::common::read_config(home.path()).unwrap()["mcp_servers"]["api"]["headers"].clone();
    assert_eq!(headers.as_object().unwrap().len(), 12, "{headers}");
}
