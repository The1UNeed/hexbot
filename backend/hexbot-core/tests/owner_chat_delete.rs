//! Old clients must not erase an owner's ongoing chat, including repair targets.
use futures_util::{SinkExt, StreamExt};
use hexbot_core::{
    catalog, common, db, runtime_store as store,
    server::{self, App},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::Path, time::Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};

mod support;

const REJECTION: &str = "A bot chat cannot be deleted; delete the bot to remove it";

fn setup() -> support::TestHome {
    let home = support::TestHome::new();
    db::migrate(home.path()).unwrap();
    db::open(home.path()).unwrap().execute_batch(
        "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0),('bob','Bob','member',0);
         INSERT INTO bots(name,owner_id,description) VALUES('owl','alice','Fixture owl'),('cat','alice','Fixture cat');
         INSERT INTO sections(id,bot,owner_id,title) VALUES('chat','owl','alice','General');
         INSERT INTO sections(id,bot,owner_id,title,peer_bot) VALUES('peer','cat','alice','Private thread','owl');
         INSERT INTO settings VALUES('one_chat_per_bot','true');"
    ).unwrap();
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT INTO settings VALUES('workspace_dir',?)",
            [json!(home.workspace()).to_string()],
        )
        .unwrap();
    fs::create_dir_all(home.path().join("profiles/owl")).unwrap();
    fs::write(
        home.path().join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: test-model\ntools:\n  enabled_toolsets: []\n",
    )
    .unwrap();
    home
}

fn database(conn: &Connection) -> Value {
    let tables = common::rows(
        conn,
        "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",
        &[],
    )
    .unwrap();
    let mut snapshot = json!({"schema":tables});
    for table in tables {
        let name = table["name"].as_str().unwrap();
        let mut rows = common::rows(
            conn,
            &format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")),
            &[],
        )
        .unwrap();
        rows.sort_by_key(Value::to_string);
        snapshot[name] = json!(rows);
    }
    snapshot
}

fn snapshot(home: &Path) -> Value {
    fn files(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files(root, &path, out);
            } else {
                let name = path.file_name().unwrap().to_str().unwrap();
                if !name.ends_with(".db")
                    && !name.ends_with(".db-wal")
                    && !name.ends_with(".db-shm")
                {
                    out.insert(
                        path.strip_prefix(root).unwrap().to_str().unwrap().into(),
                        fs::read(path).unwrap(),
                    );
                }
            }
        }
    }
    let mut bytes = BTreeMap::new();
    files(home, home, &mut bytes);
    json!({"catalog":database(&db::open(home).unwrap()),
        "native":database(&store::open(home).unwrap()),
        "legacy":database(&Connection::open(home.join("profiles/owl/state.db")).unwrap()),
        "files":bytes})
}

fn legacy(home: &Path) {
    Connection::open(home.join("profiles/owl/state.db"))
        .unwrap()
        .execute_batch(
            "CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,owner_id TEXT,bot TEXT);
         CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT);
         INSERT INTO sessions VALUES('old-chat','chat','alice','owl');
         INSERT INTO messages VALUES(1,'old-chat','user','Original legacy dialogue');",
        )
        .unwrap();
}

fn deletion_params(purge: Option<bool>) -> Value {
    let mut p = json!({"id":"chat"});
    if let Some(purge) = purge {
        p["purge_memory"] = json!(purge);
    }
    p
}

#[test]
fn catalog_rejects_owner_chat_deletion_without_changing_any_store_or_file() {
    let mut accepted = Vec::new();
    for kind in ["native", "archived", "legacy", "repair"] {
        for purge in [None, Some(true), Some(false)] {
            let home = setup();
            let h = home.path();
            legacy(h);
            let dir = store::session_dir(h, "chat").unwrap();
            fs::create_dir_all(dir.join("attachments")).unwrap();
            fs::create_dir_all(dir.join("artifacts")).unwrap();
            fs::write(dir.join("attachments/staged.txt"), "staged upload").unwrap();
            fs::write(dir.join("artifacts/result.txt"), "saved artifact").unwrap();
            if kind != "legacy" {
                store::open(h).unwrap().execute("INSERT INTO native_sessions(stored_id,bot,owner,prompt,options) VALUES('chat','owl','alice','FROZEN PREFIX',?)", [json!({"provider":"test","model":"frozen","tools":["read"]}).to_string()]).unwrap();
                let raw = format!(
                    "{}\n{}\n",
                    json!({"type":"session","version":3,"id":"chat","timestamp":"2026-10-16T00:00:00Z","cwd":h}),
                    json!({"type":"message","id":"original","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"Original native dialogue"}],"timestamp":1000}})
                );
                fs::write(dir.join("conversation.jsonl"), raw).unwrap();
                store::reconcile(h, "owl", "chat", "alice").unwrap();
            }
            if kind == "repair" {
                fs::write(
                    dir.join("conversation.jsonl"),
                    "unreadable original for repair",
                )
                .unwrap();
            }
            db::open(h).unwrap().execute("UPDATE sections SET last_live_session_id='live-sentinel',archived_at=? WHERE id='chat'", [if kind == "native" { None } else { Some(1) }]).unwrap();
            let before = snapshot(h);
            let result = catalog::call(
                h,
                "alice",
                "hexbot.sections.delete",
                &deletion_params(purge),
            )
            .unwrap();
            let after = snapshot(h);
            eprintln!(
                "owner delete kind={kind} purge={purge:?} result={result:?} unchanged={}",
                before == after
            );
            record(
                &format!("catalog-{kind}-{purge:?}"),
                &json!({"before":before,"after":after,"result":format!("{result:?}")}),
            );
            let Err(error) = result else {
                accepted.push(format!("{kind} {purge:?}"));
                continue;
            };
            assert_eq!((error.code, error.message.as_str()), (4202, REJECTION));
            assert_eq!(after, before, "{kind} {purge:?}");
            assert!(store::session_dir(h, "chat").is_ok(), "no tombstone");
        }
    }
    assert!(
        accepted.is_empty(),
        "Owner chats were deleted: {accepted:?}"
    );
}

fn record(name: &str, value: &Value) {
    if let Some(dir) = std::env::var_os("HEXBOT_TEST_OWNER_DELETE_EVIDENCE") {
        let dir = Path::new(&dir);
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join(format!("{name}.json")),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }
}

#[tokio::test]
async fn ownership_and_missing_errors_precede_the_chat_guard_in_both_dispatchers() {
    let home = setup();
    let h = home.path();
    let app = App::new(
        h.into(),
        "127.0.0.1:0".parse().unwrap(),
        h.join("unused-pi"),
        None,
    )
    .unwrap();
    for (caller, id, code, message) in [
        ("bob", "chat", 4302, ""),
        ("bob", "peer", 4302, ""),
        ("alice", "missing", 4204, "section not found: missing"),
        ("bob", "missing", 4204, "section not found: missing"),
    ] {
        let p = json!({"id":id});
        let direct = catalog::call(h, caller, "hexbot.sections.delete", &p)
            .unwrap()
            .unwrap_err();
        let public = app
            .call(caller, "hexbot.sections.delete", &p)
            .await
            .unwrap_err();
        assert_eq!(direct.code, code);
        assert_eq!(public.code, code);
        assert_eq!(direct.message, public.message);
        if !message.is_empty() {
            assert_eq!(direct.message, message);
        }
    }
    assert!(catalog::section(h, "alice", "chat").is_ok());
    assert!(store::session_dir(h, "chat").is_ok());
    app.shutdown().await;
}

fn fake_pi(home: &Path) -> std::path::PathBuf {
    let path = home.join("fake-pi.cjs");
    fs::write(&path, r#"#!/usr/bin/env node
const fs=require('node:fs');
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
const complete=()=>{emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Preserved reply'}],stopReason:'stop'}});emit({type:'agent_end'});emit({type:'agent_settled'});};
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const c=JSON.parse(line);fs.appendFileSync(__dirname+'/commands.jsonl',JSON.stringify(c)+'\n');
if(c.type==='extension_ui_response'){complete();return;}
emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});emit({type:'extension_ui_request',id:'waiting-approval',method:'select',title:'__HEXBOT_APPROVAL__'+JSON.stringify({tool:'bash',command:'pwd',reason:'Fixture approval'}),options:['once','deny']});}
if(c.type==='abort')emit({type:'agent_settled'});
});
"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    path
}

async fn next_kind(
    events: &mut tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
    kind: &str,
) -> Value {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["type"] == kind {
                return event.frame["params"].clone();
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn websocket_rejection_preserves_waiting_process_uploads_and_canonical_history() {
    let home = setup();
    let h = home.path();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = App::new(h.into(), address, fake_pi(h), None).unwrap();
    legacy(h);
    let token = support::mint_device(h, "Old client", "test", "alice").unwrap();
    let router = server::router(app.clone());
    let serving = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let (mut socket, _) = connect_async(format!(
        "ws://{address}/api/ws?token={}",
        token["device_token"].as_str().unwrap()
    ))
    .await
    .unwrap();
    let mut events = app.events.subscribe();
    let opened = app
        .call("alice", "hexbot.sections.open", &json!({"id":"chat"}))
        .await
        .unwrap();
    let live = &opened["section"]["live_session_id"];
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"Keep this question"}),
    )
    .await
    .unwrap();
    next_kind(&mut events, "approval.request").await;
    let staged = app.call("alice", "file.attach", &json!({"session_id":live,"data_url":"data:text/plain;base64,c3RhZ2Vk","name":"later.txt"})).await.unwrap();
    let artifact = h.join("runtime/sessions/chat/artifacts/result.txt");
    fs::create_dir_all(artifact.parent().unwrap()).unwrap();
    fs::write(&artifact, "saved result").unwrap();
    for purge in [None, Some(true), Some(false)] {
        let before = snapshot(h);
        let global_events = app.events.since("alice", "", 0);
        let live_events = app.events.since("alice", live.as_str().unwrap(), 0);
        socket.send(Message::Text(json!({"jsonrpc":"2.0","id":"old-delete","method":"hexbot.sections.delete","params":deletion_params(purge)}).to_string().into())).await.unwrap();
        let response = tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if let Message::Text(text) = socket.next().await.unwrap().unwrap() {
                    let frame: Value = serde_json::from_str(&text).unwrap();
                    if frame["id"] == "old-delete" {
                        break frame;
                    }
                }
            }
        })
        .await
        .unwrap();
        let after = snapshot(h);
        let status = app
            .call("alice", "session.status", &json!({"session_id":live}))
            .await;
        eprintln!(
            "WS delete purge={purge:?} response={response} unchanged={} status={status:?} staged={}",
            before == after,
            Path::new(staged["path"].as_str().unwrap()).exists()
        );
        record(
            &format!("ws-{purge:?}"),
            &json!({"before":before,"after":after,"response":response,"status":format!("{status:?}"),"staged_exists":Path::new(staged["path"].as_str().unwrap()).exists(),"global_before":global_events,"global_after":app.events.since("alice", "", 0),"live_before":live_events,"live_after":app.events.since("alice",live.as_str().unwrap(),0)}),
        );
        if response["error"]["code"] != 4202 {
            app.shutdown().await;
            serving.abort();
        }
        assert_eq!(response["error"], json!({"code":4202,"message":REJECTION}));
        assert_eq!(after, before);
        assert_eq!(status.unwrap()["status"], "working");
        assert_eq!(app.events.since("alice", "", 0), global_events);
        assert_eq!(
            app.events.since("alice", live.as_str().unwrap(), 0),
            live_events
        );
        assert!(store::session_dir(h, "chat").is_ok());
    }
    let canonical = app
        .call("alice", "hexbot.sections.create", &json!({"bot":"owl"}))
        .await
        .unwrap();
    assert_eq!(canonical["section"]["id"], "chat");
    let reopened = app
        .call("alice", "hexbot.sections.open", &json!({"id":"chat"}))
        .await
        .unwrap();
    assert_eq!(reopened["section"]["live_session_id"], *live);
    assert_eq!(
        reopened["messages"],
        json!(store::history(h, "chat").unwrap())
    );
    assert!(
        reopened["messages"]
            .to_string()
            .contains("Keep this question")
    );
    assert!(
        reopened["messages"]
            .to_string()
            .contains("Original legacy dialogue")
    );
    app.call(
        "alice",
        "approval.respond",
        &json!({"session_id":live,"request_id":"waiting-approval","choice":"deny"}),
    )
    .await
    .unwrap();
    assert_eq!(
        next_kind(&mut events, "message.complete").await["payload"]["text"],
        "Preserved reply"
    );
    assert!(Path::new(staged["path"].as_str().unwrap()).exists());
    assert_eq!(fs::read_to_string(&artifact).unwrap(), "saved result");
    let commands = fs::read_to_string(h.join("commands.jsonl")).unwrap();
    assert!(
        !commands
            .lines()
            .any(|line| serde_json::from_str::<Value>(line).unwrap()["type"] == "abort")
    );
    socket.close(None).await.unwrap();
    app.shutdown().await;
    serving.abort();
}
