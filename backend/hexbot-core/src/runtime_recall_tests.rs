use super::*;

/// A Pi that keeps a real conversation file and moves its leaf for
/// `/hexbot-recall` as the private extension does. `wait` keeps a turn
/// running until Stop; `refuse-recall` in the home makes the command fail.
fn install_recall_pi(home: &Path) {
    let script = home.join("pi.cjs");
    fs::write(
        &script,
        r#"#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
const file=process.argv[process.argv.indexOf('--session')+1];
let entries=[];
if(fs.existsSync(file))entries=fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)).slice(1);
else fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id:'s',timestamp:new Date().toISOString(),cwd:'/'})+'\n');
let leaf=entries.length?entries.at(-1).id:null,count=entries.length,waiting=false;
const append=e=>{Object.assign(e,{id:'e'+(++count),parentId:leaf,timestamp:new Date().toISOString()});entries.push(e);leaf=e.id;fs.appendFileSync(file,JSON.stringify(e)+'\n');};
const branch=()=>{const byId=new Map(entries.map(e=>[e.id,e]));const out=[];for(let e=byId.get(leaf);e;e=byId.get(e.parentId))out.unshift(e);return out;};
const reply=(text,stopReason)=>{const message={role:'assistant',content:text?[{type:'text',text}]:[],stopReason,timestamp:Date.now()};append({type:'message',message});emit({type:'message_start',message});emit({type:'message_end',message});emit({type:'agent_settled'});};
rl.on('line',line=>{const c=JSON.parse(line);
if(c.type==='prompt'&&c.message.startsWith('/hexbot-recall ')){
  const id=c.message.slice('/hexbot-recall '.length);
  const latest=branch().filter(e=>e.type==='message'&&e.message.role==='user').at(-1);
  if(latest&&latest.id===id&&!fs.existsSync(__dirname+'/refuse-recall')){leaf=latest.parentId;append({type:'custom',customType:'hexbot_recall',data:{entryId:id}});}
  else emit({type:'extension_error',error:'Only the latest message can be recalled'});
  emit({type:'response',id:c.id,command:'prompt',success:true,data:{disposition:'handled'}});return;}
emit({type:'response',id:c.id,command:c.type,success:true,data:c.type==='prompt'?{disposition:'started'}:{}});
if(c.type==='prompt'){emit({type:'agent_start'});const message={role:'user',content:c.message,timestamp:Date.now()};append({type:'message',message});emit({type:'message_start',message});emit({type:'message_end',message});
  if(c.message==='wait')waiting=true;else reply('Re: '+c.message,'stop');}
if(c.type==='abort'){if(waiting){waiting=false;reply('','aborted');}else emit({type:'agent_settled'});}
});
"#,
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

async fn send(
    runtime: &Runtime,
    events: &mut tokio::sync::broadcast::Receiver<crate::events::Event>,
    id: &str,
    text: &str,
    input: &str,
) {
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":text,"input_id":input}),
        )
        .await
        .unwrap()
        .unwrap();
    if text != "wait" {
        stop_tests::stop_event(events, |e| e["type"] == "message.complete").await;
    }
}

async fn shown(runtime: &Runtime, id: &str) -> Vec<String> {
    runtime
        .call("alice", "session.history", &json!({"session_id":id}))
        .await
        .unwrap()
        .unwrap()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["role"] == "user" || row["role"] == "assistant")
        .map(|row| row["text"].as_str().unwrap().to_owned())
        .collect()
}

async fn recall(runtime: &Runtime, id: &str, input: &str) -> Result<Value> {
    runtime
        .call(
            "alice",
            "session.recall",
            &json!({"session_id":id,"input_id":input}),
        )
        .await
        .unwrap()
}

const FIRST: &str = "00000000-0000-4000-8000-000000000001";
const SECOND: &str = "00000000-0000-4000-8000-000000000002";
const THIRD: &str = "00000000-0000-4000-8000-000000000003";

#[tokio::test]
async fn recall_takes_back_the_latest_message_and_the_bot_forgets_it() {
    let (home, runtime, hub) = setup();
    install_recall_pi(home.path());
    let id = open(&runtime).await;
    let mut events = hub.subscribe();
    send(&runtime, &mut events, &id, "First", FIRST).await;
    send(&runtime, &mut events, &id, "Second", SECOND).await;
    // Only the latest message, named by the client that sent it.
    assert_eq!(recall(&runtime, &id, FIRST).await.unwrap_err().code, 4202);
    assert_eq!(
        shown(&runtime, &id).await,
        ["First", "Re: First", "Second", "Re: Second"]
    );
    let recalled = recall(&runtime, &id, SECOND).await.unwrap();
    assert_eq!(recalled, json!({"recalled":true,"text":"Second"}));
    stop_tests::stop_event(&mut events, |e| {
        e["type"] == "hexbot.sections.changed" && e["payload"]["reload"] == true
    })
    .await;
    assert_eq!(shown(&runtime, &id).await, ["First", "Re: First"]);
    // The next message continues from before the recalled one.
    send(&runtime, &mut events, &id, "Third", THIRD).await;
    assert_eq!(
        shown(&runtime, &id).await,
        ["First", "Re: First", "Third", "Re: Third"]
    );
    // A restart rebuilds the history from the conversation file.
    runtime.shutdown().await;
    let restarted = Runtime::new(home.path().into(), hub, home.path().join("pi.cjs")).unwrap();
    let id = open(&restarted).await;
    assert_eq!(
        shown(&restarted, &id).await,
        ["First", "Re: First", "Third", "Re: Third"]
    );
    restarted.shutdown().await;
}

#[tokio::test]
async fn recall_stops_the_turn_working_on_it() {
    let (home, runtime, hub) = setup();
    install_recall_pi(home.path());
    let id = open(&runtime).await;
    let mut events = hub.subscribe();
    send(&runtime, &mut events, &id, "First", FIRST).await;
    send(&runtime, &mut events, &id, "wait", SECOND).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    assert!(s.state.lock().unwrap().busy);
    let recalled = recall(&runtime, &id, SECOND).await.unwrap();
    assert_eq!(recalled["text"], "wait");
    assert!(!s.state.lock().unwrap().busy);
    assert_eq!(shown(&runtime, &id).await, ["First", "Re: First"]);
    runtime.shutdown().await;
}

#[tokio::test]
async fn recall_changes_nothing_when_pi_does_not_move() {
    let (home, runtime, hub) = setup();
    install_recall_pi(home.path());
    let id = open(&runtime).await;
    let mut events = hub.subscribe();
    send(&runtime, &mut events, &id, "First", FIRST).await;
    fs::write(home.path().join("refuse-recall"), "").unwrap();
    assert_eq!(recall(&runtime, &id, FIRST).await.unwrap_err().code, 5201);
    assert_eq!(shown(&runtime, &id).await, ["First", "Re: First"]);
    // The section takes messages again.
    fs::remove_file(home.path().join("refuse-recall")).unwrap();
    send(&runtime, &mut events, &id, "Second", SECOND).await;
    runtime.shutdown().await;
}

#[tokio::test]
async fn recall_is_only_for_a_bot_chat_and_never_typed() {
    let (home, runtime, hub) = setup();
    install_recall_pi(home.path());
    let id = open(&runtime).await;
    let mut events = hub.subscribe();
    let typed = runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"/hexbot-recall e1"}),
        )
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(typed.code, 4202);
    send(&runtime, &mut events, &id, "First", FIRST).await;
    assert_eq!(recall(&runtime, &id, "").await.unwrap_err().code, 4200);
    // A thread between bots keeps what was said.
    db::open(home.path())
        .unwrap()
        .execute("UPDATE sections SET peer_bot='hawk' WHERE id='first'", [])
        .unwrap();
    assert_eq!(recall(&runtime, &id, FIRST).await.unwrap_err().code, 4202);
    assert_eq!(shown(&runtime, &id).await, ["First", "Re: First"]);
    runtime.shutdown().await;
}
