use super::*;
use serde_json::json;

/// A Bitwarden CLI stand-in: the commands Hexbot runs, against a JSON file
/// in its data folder. The master password is `correct horse`; an email
/// starting with `2fa` wants the code 123456, answering as `bw` does for an
/// authenticator app; a changed `session` in the file is a session `bw`
/// forgot; `down` is a server that doesn't answer.
const FAKE_BW: &str = r#"#!/usr/bin/env node
const fs = require('fs'), path = require('path'), crypto = require('crypto')
// The server's side lives beside this program, so it outlives the CLI's data folder.
const file = path.join(__dirname, 'fake.json')
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { items: [], folders: [], calls: [] }
const args = process.argv.slice(2).filter(a => a !== '--nointeraction' && a !== '--response')
const save = () => fs.writeFileSync(file, JSON.stringify(state))
const ok = data => { save(); console.log(JSON.stringify({ success: true, data })); process.exit(0) }
const fail = message => { save(); console.log(JSON.stringify({ success: false, message })); process.exit(1) }
const stdin = () => JSON.parse(Buffer.from(fs.readFileSync(0, 'utf8'), 'base64').toString())
const opt = name => args[args.indexOf(name) + 1]
state.calls.push({ args, argv: process.argv.slice(2).join(' '), session: process.env.BW_SESSION || null })
const unlocked = () => { if (!state.session || process.env.BW_SESSION !== state.session) fail('Vault is locked.') }
const [command, object, id] = args
if (command === 'config') { state.server = id; ok({ title: 'Saved' }) }
if (command === 'logout') { state.loggedIn = false; state.session = null; ok({}) }
if (command === 'login') {
  if (process.env.BW_PASSWORD !== 'correct horse') { save(); console.log('Username or password is incorrect. Try again.'); process.exit(1) }
  if (object.startsWith('2fa') && opt('--code') !== '123456') { save(); console.log('Code is required.'); process.exit(1) }
  state.loggedIn = true; state.email = object; state.session = 'session-' + crypto.randomUUID(); save(); console.log(state.session); process.exit(0)
}
if (command === 'unlock') {
  if (!state.loggedIn) fail('You are not logged in.')
  if (process.env.BW_PASSWORD !== 'correct horse') { save(); console.log('Invalid master password.'); process.exit(1) }
  state.session = 'session-' + crypto.randomUUID(); save(); console.log(state.session); process.exit(0)
}
if (state.down) fail('FetchError: request to https://vault.example.com/api/sync failed')
unlocked()
if (command === 'sync') ok({ title: 'Syncing complete.' })
if (command === 'list' && object === 'folders') ok({ object: 'list', data: state.folders })
// With `gate`, listing items waits up to five seconds for a `go` file the test writes.
if (command === 'list' && object === 'items' && state.gate) {
  const go = path.join(__dirname, 'go')
  const until = Date.now() + 5000
  while (!fs.existsSync(go) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  if (!fs.existsSync(go)) fail('no go')
}
if (command === 'list' && object === 'items') ok({ object: 'list', data: state.items.filter(i => i.folderId === opt('--folderid') && !i.deletedDate === !args.includes('--trash')) })
if (command === 'restore') { const i = state.items.find(x => x.id === id); if (!i) fail('Not found.'); delete i.deletedDate; ok({}) }
if (command === 'get') { const item = state.items.find(i => i.id === object && 1) || state.items.find(i => i.id === id); item ? ok(item) : fail('Not found.') }
if (command === 'create' && object === 'folder') { const f = { ...stdin(), id: crypto.randomUUID(), object: 'folder' }; state.folders.push(f); ok(f) }
if (command === 'create' && object === 'item' && state.failCreate === 0) { delete state.failCreate; fail('FetchError: connection reset') }
if (command === 'create' && object === 'item' && state.failCreate > 0) state.failCreate--
if (command === 'create' && object === 'item') { const i = { ...stdin(), id: crypto.randomUUID(), object: 'item', revisionDate: new Date().toISOString() }; state.items.push(i); ok(i) }
if (command === 'edit' && state.failEdit) { delete state.failEdit; fail('FetchError: connection reset') }
if (command === 'edit') { const i = state.items.findIndex(x => x.id === id); if (i < 0) fail('Not found.'); if (state.items[i].deletedDate) fail('You may not edit a deleted item. Use the restore command first.'); state.items[i] = { ...stdin(), id, revisionDate: new Date().toISOString() }; ok(state.items[i]) }
if (command === 'delete') { const i = state.items.find(x => x.id === id); if (!i) fail('Not found.'); i.deletedDate = new Date().toISOString(); ok({}) }
fail('unknown command ' + args.join(' '))
"#;

fn home() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    crate::db::migrate(home.path()).unwrap();
    crate::db::open(home.path())
        .unwrap()
        .execute_batch(
            "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
             INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','alice');",
        )
        .unwrap();
    let bw = home.path().join("fake-bw");
    std::fs::write(&bw, FAKE_BW).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&bw, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(
        home.path().join("config.yaml"),
        format!("passwords:\n  bitwarden_command: {}\n", bw.display()),
    )
    .unwrap();
    home
}

fn fake(home: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(home.join("fake.json")).unwrap()).unwrap()
}

fn connect_alice(h: &Path, extra: Value) -> Result<Value> {
    let mut p = json!({"server":"https://vault.example.com/","email":"alice@example.com","password":"correct horse"});
    p.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    crate::passwords::call(h, "alice", "hexbot.passwords.connect", &p).unwrap()
}

#[test]
fn items_live_in_the_hexbot_folder_and_secrets_never_reach_a_command_line() {
    let home = home();
    let h = home.path();
    // Saved on this daemon first, then copied in when Vaultwarden connects.
    let local = crate::passwords::save(
        h,
        "alice",
        &json!({"title":"Schoology","url":"https://app.schoology.com","username":"alex","password":"hunter2","code":"JBSWY3DPEHPK3PXP"}),
    )
    .unwrap();
    let connected = connect_alice(h, json!({"copy":true})).unwrap();
    assert_eq!(connected["copied"], 1);
    assert_eq!(connected["vault"]["kind"], "vaultwarden");
    assert_eq!(connected["vault"]["server"], "https://vault.example.com");
    let state = fake(h);
    assert_eq!(state["server"], "https://vault.example.com/");
    assert_eq!(state["folders"][0]["name"], "Hexbot");
    let listed = crate::passwords::list(h, "alice", None).unwrap();
    assert_eq!(listed.len(), 1);
    assert_ne!(
        listed[0]["id"], local["id"],
        "a Vaultwarden item has its own id"
    );
    let id = listed[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(listed[0]["has_code"], true);
    assert_eq!(
        crate::passwords::secret(h, "alice", &id, "password").unwrap(),
        "hunter2"
    );
    assert_eq!(
        crate::passwords::secret(h, "alice", &id, "code")
            .unwrap()
            .len(),
        6
    );
    // The other kinds, as Bitwarden apps can show them.
    let api = crate::passwords::save(
        h,
        "alice",
        &json!({"kind":"api_key","title":"OpenAI","key":"sk-secret","bots":["owl"]}),
    )
    .unwrap();
    let ssh = crate::passwords::save(
        h,
        "alice",
        &json!({"kind":"ssh_key","title":"GitHub","generate":true}),
    )
    .unwrap();
    let items = fake(h)["items"].as_array().unwrap().clone();
    let by_name = |name: &str| items.iter().find(|i| i["name"] == name).unwrap().clone();
    let openai = by_name("OpenAI");
    assert_eq!(openai["type"], 1);
    assert_eq!(openai["login"]["password"], "sk-secret");
    assert_eq!(
        field(&openai, "Variable").as_deref(),
        Some("OPENAI_API_KEY")
    );
    assert_eq!(field(&openai, "hexbot.bots").as_deref(), Some(r#"["owl"]"#));
    let github = by_name("GitHub");
    assert_eq!(github["type"], 2, "a Secure note every app shows");
    let private = github["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "Private key")
        .unwrap();
    assert_eq!(private["type"], 1, "hidden");
    assert!(
        private["value"]
            .as_str()
            .unwrap()
            .contains("OPENSSH PRIVATE KEY")
    );
    assert_eq!(
        crate::passwords::find(h, "alice", ssh["id"].as_str().unwrap()).unwrap()["public_key"],
        ssh["public_key"]
    );
    // Bots see what they are given; a deleted bot leaves every list.
    assert_eq!(
        crate::passwords::list(h, "alice", Some("fox"))
            .unwrap()
            .len(),
        2
    );
    crate::passwords::forget_bot(h, "owl").unwrap();
    assert_eq!(
        crate::passwords::find(h, "alice", api["id"].as_str().unwrap()).unwrap()["bots"],
        json!([])
    );
    // A change keeps what a Bitwarden app added.
    let mut state = fake(h);
    let at = state["items"]
        .as_array()
        .unwrap()
        .iter()
        .position(|i| i["name"] == "Schoology")
        .unwrap();
    state["items"][at]["fields"] = json!([{"name":"PIN","value":"1234","type":1}]);
    state["items"][at]["login"]["uris"]
        .as_array_mut()
        .unwrap()
        .push(json!({"uri":"https://schoology.com/m"}));
    std::fs::write(h.join("fake.json"), state.to_string()).unwrap();
    crate::passwords::save(h, "alice", &json!({"id":id,"username":"alex2"})).unwrap();
    let schoology = fake(h)["items"][at].clone();
    assert_eq!(schoology["login"]["username"], "alex2");
    assert_eq!(field(&schoology, "PIN").as_deref(), Some("1234"));
    assert_eq!(schoology["login"]["uris"].as_array().unwrap().len(), 2);
    // Deleting moves it to Vaultwarden's trash.
    crate::passwords::delete(h, "alice", &id).unwrap();
    assert!(!fake(h)["items"][at]["deletedDate"].is_null());
    assert_eq!(
        crate::passwords::find(h, "alice", &id).unwrap_err().code,
        4204
    );
    // No password, key or session key was ever on a command line.
    for call in fake(h)["calls"].as_array().unwrap() {
        let argv = call["argv"].as_str().unwrap();
        for secret in [
            "correct horse",
            "hunter2",
            "sk-secret",
            "session-",
            "PRIVATE KEY",
        ] {
            assert!(!argv.contains(secret), "{argv}");
        }
    }
    // The master password is kept owner-only, never in the settings file.
    let settings =
        std::fs::read_to_string(h.join("users/alice/passwords/vaultwarden.json")).unwrap();
    assert!(!settings.contains("correct horse"));
    assert!(crate::credentials::credential_name(
        h,
        &h.join("users/alice/passwords/vaultwarden.key")
    ));
}

#[test]
fn only_hexbot_folder_items_are_used() {
    let home = home();
    let h = home.path();
    connect_alice(h, json!({})).unwrap();
    let mut state = fake(h);
    state["items"] = json!([
        {"id":"0b1e1a52-0000-4000-8000-000000000001","type":1,"name":"Bank","folderId":null,
         "login":{"username":"me","password":"elsewhere","uris":[]}},
        {"id":"0b1e1a52-0000-4000-8000-000000000002","type":3,"name":"Visa","folderId":state["folders"][0]["id"]}
    ]);
    std::fs::write(h.join("fake.json"), state.to_string()).unwrap();
    assert!(crate::passwords::list(h, "alice", None).unwrap().is_empty());
    for id in [
        "0b1e1a52-0000-4000-8000-000000000001",
        "0b1e1a52-0000-4000-8000-000000000002",
    ] {
        assert_eq!(
            crate::passwords::secret(h, "alice", id, "password")
                .unwrap_err()
                .code,
            4204
        );
    }
}

#[test]
fn a_forgotten_session_unlocks_again_and_disconnect_goes_back_to_this_daemon() {
    let home = home();
    let h = home.path();
    crate::passwords::save(
        h,
        "alice",
        &json!({"url":"https://x.com","password":"local"}),
    )
    .unwrap();
    connect_alice(h, json!({})).unwrap();
    assert!(crate::passwords::list(h, "alice", None).unwrap().is_empty());
    // After a restart, or when `bw` forgets the session, Hexbot unlocks again.
    let mut state = fake(h);
    state["session"] = json!("session-new");
    std::fs::write(h.join("fake.json"), state.to_string()).unwrap();
    crate::passwords::save(h, "alice", &json!({"url":"https://y.com","password":"vw"})).unwrap();
    assert_eq!(crate::passwords::list(h, "alice", None).unwrap().len(), 1);
    let unlocks = fake(h)["calls"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["args"][0] == "unlock")
        .count();
    assert_eq!(unlocks, 1);
    crate::passwords::call(h, "alice", "hexbot.passwords.disconnect", &json!({}))
        .unwrap()
        .unwrap();
    assert!(!h.join("users/alice/passwords/bitwarden").exists());
    assert!(!h.join("users/alice/passwords/vaultwarden.key").exists());
    assert_eq!(status(h, "alice").unwrap(), json!({"kind":"local"}));
    let back = crate::passwords::list(h, "alice", None).unwrap();
    assert_eq!(back.len(), 1);
    assert_eq!(back[0]["site"], "x.com");
}

#[test]
fn connecting_needs_https_the_right_password_and_a_two_step_code() {
    let home = home();
    let h = home.path();
    let err = |extra: Value| connect_alice(h, extra).unwrap_err();
    assert_eq!(err(json!({"server":"http://vault.example.com"})).code, 4202);
    assert!(
        err(json!({"password":"wrong"}))
            .message
            .contains("incorrect")
    );
    let two_step = err(json!({"email":"2fa@example.com"}));
    assert_eq!(two_step.code, 4207);
    connect_alice(h, json!({"email":"2fa@example.com","code":"123456"})).unwrap();
    assert_eq!(status(h, "alice").unwrap()["email"], "2fa@example.com");
    // A failed sign-in saved nothing: Passwords stayed on this daemon until it worked.
    let other = home_without_bw();
    let missing = crate::passwords::call(
        other.path(),
        "alice",
        "hexbot.passwords.connect",
        &json!({"server":"https://v.example.com","email":"a@b.c","password":"p"}),
    )
    .unwrap()
    .unwrap_err();
    assert_eq!(missing.code, 5301);
    assert_eq!(status(other.path(), "alice").unwrap()["kind"], "local");
}

fn edit_fake(h: &Path, change: impl FnOnce(&mut Value)) {
    let mut state = fake(h);
    change(&mut state);
    std::fs::write(h.join("fake.json"), state.to_string()).unwrap();
}

#[test]
fn an_unreachable_vaultwarden_still_shows_so_it_can_be_disconnected() {
    let home = home();
    let h = home.path();
    connect_alice(h, json!({})).unwrap();
    edit_fake(h, |state| state["down"] = json!(true));
    let listed = crate::passwords::call(h, "alice", "hexbot.passwords.list", &json!({}))
        .unwrap()
        .unwrap();
    assert_eq!(listed["vault"]["kind"], "vaultwarden");
    assert!(listed["error"].as_str().unwrap().contains("FetchError"));
    assert_eq!(listed["logins"], json!([]));
    // Where they are answers without asking the server at all.
    let calls = fake(h)["calls"].as_array().unwrap().len();
    let vault = crate::passwords::call(h, "alice", "hexbot.passwords.vault", &json!({}))
        .unwrap()
        .unwrap();
    assert_eq!(vault["vault"]["kind"], "vaultwarden");
    assert_eq!(fake(h)["calls"].as_array().unwrap().len(), calls);
    // Nor does it open the daemon's own vault, which may not open.
    std::fs::write(h.join("users/alice/passwords/passwords.kdbx"), "broken").unwrap();
    let vault = crate::passwords::call(h, "alice", "hexbot.passwords.vault", &json!({}))
        .unwrap()
        .unwrap();
    assert_eq!(vault["vault"]["kind"], "vaultwarden");
    crate::passwords::call(h, "alice", "hexbot.passwords.disconnect", &json!({}))
        .unwrap()
        .unwrap();
    assert_eq!(status(h, "alice").unwrap()["kind"], "local");
}

#[test]
fn reading_an_item_syncs_first_so_a_moved_item_stops_working() {
    let home = home();
    let h = home.path();
    connect_alice(h, json!({})).unwrap();
    let saved = crate::passwords::save(h, "alice", &json!({"url":"https://x.com","password":"pw"}))
        .unwrap();
    let id = saved["id"].as_str().unwrap().to_owned();
    // Moved out of the Hexbot folder in a Bitwarden app.
    edit_fake(h, |state| state["items"][0]["folderId"] = Value::Null);
    synced().lock().unwrap().clear();
    assert_eq!(
        crate::passwords::secret(h, "alice", &id, "password")
            .unwrap_err()
            .code,
        4204
    );
    let calls = fake(h)["calls"].as_array().unwrap().clone();
    let sync = calls.iter().rposition(|c| c["args"][0] == "sync").unwrap();
    let get = calls.iter().rposition(|c| c["args"][0] == "get").unwrap();
    assert!(sync < get, "synced before reading");
}

#[test]
fn a_deleted_bot_leaves_the_daemons_vault_too_while_vaultwarden_is_connected() {
    let home = home();
    let h = home.path();
    crate::passwords::save(
        h,
        "alice",
        &json!({"url":"https://x.com","password":"pw","bots":["owl"]}),
    )
    .unwrap();
    connect_alice(h, json!({})).unwrap();
    crate::passwords::forget_bot(h, "owl").unwrap();
    crate::passwords::call(h, "alice", "hexbot.passwords.disconnect", &json!({}))
        .unwrap()
        .unwrap();
    assert_eq!(
        crate::passwords::list(h, "alice", None).unwrap()[0]["bots"],
        json!([])
    );
}

#[test]
fn a_connect_that_fails_part_way_leaves_nothing_behind() {
    let home = home();
    let h = home.path();
    crate::passwords::save(h, "alice", &json!({"url":"https://x.com","password":"pw"})).unwrap();
    // The vault on the daemon can't be read, so copying it fails after sign-in.
    std::fs::remove_file(h.join("users/alice/passwords/passwords.key")).unwrap();
    assert_eq!(
        connect_alice(h, json!({"copy":true})).unwrap_err().code,
        5300
    );
    assert!(!h.join("users/alice/passwords/vaultwarden.key").exists());
    assert!(!h.join("users/alice/passwords/vaultwarden.json").exists());
    assert!(!h.join("users/alice/passwords/bitwarden").exists());
    assert!(!sessions().lock().unwrap().contains_key(&key(h, "alice")));
    assert_eq!(status(h, "alice").unwrap()["kind"], "local");
    // Disconnect runs whole even with nothing connected, so it can clean up.
    std::fs::write(h.join("users/alice/passwords/vaultwarden.key"), "6869").unwrap();
    crate::passwords::call(h, "alice", "hexbot.passwords.disconnect", &json!({}))
        .unwrap()
        .unwrap();
    assert!(!h.join("users/alice/passwords/vaultwarden.key").exists());
}

#[test]
fn a_deleted_bot_leaves_trashed_items_and_they_stay_in_the_trash() {
    let home = home();
    let h = home.path();
    connect_alice(h, json!({})).unwrap();
    let saved = crate::passwords::save(
        h,
        "alice",
        &json!({"url":"https://x.com","password":"pw","bots":["owl","fox"]}),
    )
    .unwrap();
    crate::passwords::delete(h, "alice", saved["id"].as_str().unwrap()).unwrap();
    crate::passwords::forget_bot(h, "owl").unwrap();
    let item = fake(h)["items"][0].clone();
    assert!(!item["deletedDate"].is_null(), "back in the trash");
    assert_eq!(field(&item, "hexbot.bots").as_deref(), Some(r#"["fox"]"#));
    // A change that fails still puts the item back in the trash.
    edit_fake(h, |state| state["failEdit"] = json!(true));
    assert_eq!(
        crate::passwords::forget_bot(h, "fox").unwrap_err().code,
        5300
    );
    assert!(
        !fake(h)["items"][0]["deletedDate"].is_null(),
        "still in the trash"
    );
}

#[test]
fn saving_keeps_the_match_rule_a_bitwarden_app_set() {
    let home = home();
    let h = home.path();
    connect_alice(h, json!({})).unwrap();
    let saved = crate::passwords::save(h, "alice", &json!({"url":"https://x.com","password":"pw"}))
        .unwrap();
    edit_fake(h, |state| {
        state["items"][0]["login"]["uris"][0]["match"] = json!(3)
    });
    crate::passwords::save(h, "alice", &json!({"id":saved["id"],"url":"https://y.com"})).unwrap();
    let uri = fake(h)["items"][0]["login"]["uris"][0].clone();
    assert_eq!(uri, json!({"uri":"https://y.com","match":3}));
}

/// The daemon's runtime has many threads; a call waiting on `bw` steps
/// aside for the worker's other tasks instead of holding it. With one
/// worker, the fake `bw` finishes only once another task writes its `go`.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn waiting_on_bw_leaves_the_async_workers_free() {
    let home = home();
    let h = home.path().to_owned();
    connect_alice(&h, json!({})).unwrap();
    edit_fake(&h, |state| state["gate"] = json!(true));
    let (started, waiting) = tokio::sync::oneshot::channel::<()>();
    let listing = tokio::spawn({
        let h = h.clone();
        async move {
            started.send(()).unwrap();
            crate::passwords::list(&h, "alice", None).map(|l| l.len())
        }
    });
    let go = h.join("go");
    tokio::spawn(async move {
        waiting.await.unwrap();
        std::fs::write(go, "").unwrap();
    });
    assert_eq!(listing.await.unwrap().unwrap(), 0);
}

#[test]
fn a_copy_cut_short_and_tried_again_makes_no_duplicates() {
    let home = home();
    let h = home.path();
    for site in ["https://a.com", "https://b.com", "https://c.com"] {
        crate::passwords::save(h, "alice", &json!({"url":site,"password":"pw"})).unwrap();
    }
    std::fs::write(
        h.join("fake.json"),
        json!({"items":[],"folders":[],"calls":[],"failCreate":1}).to_string(),
    )
    .unwrap();
    assert_eq!(
        connect_alice(h, json!({"copy":true})).unwrap_err().code,
        5300
    );
    assert_eq!(fake(h)["items"].as_array().unwrap().len(), 1);
    let connected = connect_alice(h, json!({"copy":true})).unwrap();
    assert_eq!(connected["copied"], 2);
    assert_eq!(fake(h)["items"].as_array().unwrap().len(), 3);
}

#[test]
fn a_copy_skips_only_items_it_copied_itself() {
    let home = home();
    let h = home.path();
    crate::passwords::save(
        h,
        "alice",
        &json!({"kind":"api_key","title":"OpenAI","key":"sk-local"}),
    )
    .unwrap();
    connect_alice(h, json!({})).unwrap();
    // The folder already has a different key with the same name.
    crate::passwords::save(
        h,
        "alice",
        &json!({"kind":"api_key","title":"OpenAI","key":"sk-remote"}),
    )
    .unwrap();
    connect_alice(h, json!({"copy":true})).unwrap();
    let keys = fake(h)["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["login"]["password"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(keys, ["sk-remote", "sk-local"]);
}

#[test]
fn saving_a_login_keeps_fields_named_like_another_kinds() {
    let home = home();
    let h = home.path();
    connect_alice(h, json!({})).unwrap();
    let saved = crate::passwords::save(h, "alice", &json!({"url":"https://x.com","password":"pw"}))
        .unwrap();
    edit_fake(h, |state| {
        state["items"][0]["fields"] = json!([{"name":"Variable","value":"mine","type":0}]);
    });
    crate::passwords::save(h, "alice", &json!({"id":saved["id"],"title":"X"})).unwrap();
    assert_eq!(
        field(&fake(h)["items"][0], "Variable").as_deref(),
        Some("mine")
    );
}

#[test]
fn a_locked_key_saved_into_a_bitwarden_ssh_key_item_keeps_its_passphrase() {
    let home = home();
    let h = home.path();
    connect_alice(h, json!({})).unwrap();
    let saved = crate::passwords::save(
        h,
        "alice",
        &json!({"kind":"ssh_key","title":"Server","generate":true}),
    )
    .unwrap();
    // Made a Bitwarden SSH key item in a Bitwarden app.
    edit_fake(h, |state| {
        let item = &mut state["items"][0];
        item["type"] = json!(5);
        item["sshKey"] = json!({"privateKey": "", "publicKey": ""});
        item["fields"] = json!([{"name":"hexbot.kind","value":"ssh_key","type":0}]);
    });
    let id = saved["id"].as_str().unwrap();
    crate::passwords::save(
        h,
        "alice",
        &json!({"id":id,"private_key":crate::passwords::tests::LOCKED_KEY,"passphrase":"correct horse"}),
    )
    .unwrap();
    assert_eq!(fake(h)["items"][0]["type"], 5);
    assert!(
        crate::passwords::secret(h, "alice", id, "private_key")
            .unwrap()
            .contains("OPENSSH PRIVATE KEY")
    );
}

#[test]
fn a_steam_code_key_survives_saving_other_fields() {
    let home = home();
    let h = home.path();
    connect_alice(h, json!({})).unwrap();
    let saved = crate::passwords::save(
        h,
        "alice",
        &json!({"url":"https://steam.com","password":"pw"}),
    )
    .unwrap();
    edit_fake(h, |state| {
        state["items"][0]["login"]["totp"] = json!("steam://ABCDEFGHIJ")
    });
    let id = saved["id"].as_str().unwrap();
    crate::passwords::save(h, "alice", &json!({"id":id,"title":"Steam"})).unwrap();
    assert_eq!(fake(h)["items"][0]["login"]["totp"], "steam://ABCDEFGHIJ");
    assert_eq!(
        crate::passwords::find(h, "alice", id).unwrap()["has_code"],
        true
    );
    // A bare key, as Bitwarden apps save it, still gives codes and stays bare.
    edit_fake(h, |state| {
        state["items"][0]["login"]["totp"] = json!("JBSWY3DPEHPK3PXP")
    });
    assert_eq!(
        crate::passwords::secret(h, "alice", id, "code")
            .unwrap()
            .len(),
        6
    );
    crate::passwords::save(h, "alice", &json!({"id":id,"title":"Steam 2"})).unwrap();
    assert_eq!(fake(h)["items"][0]["login"]["totp"], "JBSWY3DPEHPK3PXP");
}

fn home_without_bw() -> tempfile::TempDir {
    let home = home();
    std::fs::write(
        home.path().join("config.yaml"),
        "passwords:\n  bitwarden_command: /nonexistent/bw\n",
    )
    .unwrap();
    home
}

/// Against a real Vaultwarden: `HEXBOT_VAULTWARDEN_URL`, `_EMAIL` and
/// `_PASSWORD`, with the Bitwarden CLI on the PATH.
#[test]
#[ignore]
fn a_real_vaultwarden_keeps_every_kind() {
    let var = |name: &str| std::env::var(format!("HEXBOT_VAULTWARDEN_{name}")).unwrap();
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    crate::db::migrate(h).unwrap();
    crate::db::open(h)
        .unwrap()
        .execute_batch(
            "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
             INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','alice');",
        )
        .unwrap();
    let p = json!({"server":var("URL"),"email":var("EMAIL"),"password":var("PASSWORD")});
    crate::passwords::call(h, "alice", "hexbot.passwords.connect", &p)
        .unwrap()
        .unwrap();
    let login = crate::passwords::save(
        h,
        "alice",
        &json!({"title":"Real login","url":"https://example.com","username":"u","password":"pw","code":"JBSWY3DPEHPK3PXP"}),
    )
    .unwrap();
    let api = crate::passwords::save(
        h,
        "alice",
        &json!({"kind":"api_key","title":"Real API","key":"sk-real"}),
    )
    .unwrap();
    let ssh = crate::passwords::save(
        h,
        "alice",
        &json!({"kind":"ssh_key","title":"Real SSH","generate":true}),
    )
    .unwrap();
    let id = |v: &Value| v["id"].as_str().unwrap().to_owned();
    assert_eq!(
        crate::passwords::secret(h, "alice", &id(&login), "password").unwrap(),
        "pw"
    );
    assert_eq!(
        crate::passwords::secret(h, "alice", &id(&login), "code")
            .unwrap()
            .len(),
        6
    );
    assert_eq!(
        crate::passwords::secret(h, "alice", &id(&api), "key").unwrap(),
        "sk-real"
    );
    assert!(
        crate::passwords::secret(h, "alice", &id(&ssh), "private_key")
            .unwrap()
            .contains("OPENSSH PRIVATE KEY")
    );
    let titles = crate::passwords::list(h, "alice", None)
        .unwrap()
        .iter()
        .map(|i| i["title"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    for title in ["Real login", "Real API", "Real SSH"] {
        assert!(titles.iter().any(|t| t == title), "{titles:?}");
    }
    for item in [&login, &api, &ssh] {
        crate::passwords::delete(h, "alice", &id(item)).unwrap();
    }
    // A deleted bot leaves a trashed item's list, and the item stays trashed.
    let shared = crate::passwords::save(
        h,
        "alice",
        &json!({"title":"Real trash","url":"https://example.com","password":"pw","bots":["owl","fox"]}),
    )
    .unwrap();
    crate::passwords::delete(h, "alice", &id(&shared)).unwrap();
    crate::passwords::forget_bot(h, "owl").unwrap();
    assert_eq!(
        crate::passwords::find(h, "alice", &id(&shared))
            .unwrap_err()
            .code,
        4204,
        "still in the trash"
    );
    crate::passwords::call(h, "alice", "hexbot.passwords.disconnect", &json!({}))
        .unwrap()
        .unwrap();
}
