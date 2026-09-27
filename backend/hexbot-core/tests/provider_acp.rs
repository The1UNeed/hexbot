use hexbot_core::{common, db, provider_acp as acp, runtime_store};
use serde_json::{Value, json};
use std::{
    fs,
    sync::{Arc, Mutex},
};

const SERVER: &str = r#"
const readline = require('node:readline');
const mode = process.argv[2];
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
let promptId; let workspace; const replies = {};
function finish(text) {
 send({method:'session/update',params:{sessionId:'foreign',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PRIVATE'}}}});
 send({method:'session/update',params:{sessionId:'a',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Reasoning'}}}});
 send({method:'session/update',params:{sessionId:'a',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
 send({id:promptId,result:{stopReason:'end_turn'}});
}
readline.createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if(request.method==='initialize') {
   if(request.params.protocolVersion!==1) process.exit(2);
   send({id:request.id,result:{protocolVersion:1,agentCapabilities:{}}});
 } else if(request.method==='session/new') { workspace=request.params.cwd;send({id:request.id,result:{sessionId:'a'}}); }
 else if(request.method==='session/prompt') {
   promptId=request.id;
   if(mode==='exit') process.exit(3);
   if(mode==='malformed') {process.stdout.write('bad json\n');return;}
   if(mode==='error') {send({id:request.id,error:{code:-32000,message:'Login required'}});return;}
   if(mode==='hang') return;
   if(mode==='permission'||mode==='cancel') {
     send({id:90,method:'session/request_permission',params:{sessionId:'a',toolCall:{title:'command',rawInput:{pid:process.pid}},options:[{optionId:'no',kind:'reject_once'},{optionId:'yes',kind:'allow_once'}]}});
   } else if(mode==='files') {
     send({id:91,method:'fs/write_text_file',params:{sessionId:'a',path:'nested/note.txt',content:'first\nsecond\nthird\n'}});
   } else if(mode==='traversal') {
     send({id:94,method:'fs/write_text_file',params:{sessionId:'a',path:'../escape',content:'no'}});
   } else {
     const prompt=request.params.prompt[0].text;
     if(!prompt.includes('memory')||!prompt.includes('Remember tea')||!prompt.includes('private system'))process.exit(4);
     finish('Done <tool_call>'+JSON.stringify({id:'call_1',type:'function',function:{name:'memory',arguments:'{"action":"add","content":"tea"}'}})+'</tool_call>');
   }
 } else if(request.id===90) { if(mode==='cancel')return;finish(JSON.stringify(request.result)); }
 else if(request.id===91) {replies.write=request;send({id:92,method:'fs/read_text_file',params:{sessionId:'a',path:'nested/note.txt',line:2,limit:1}});}
 else if(request.id===92) {replies.read=request;send({id:93,method:'fs/read_text_file',params:{sessionId:'a',path:'.env'}});}
 else if(request.id===93) {replies.secret=request;finish(JSON.stringify(replies));}
 else if(request.id===94) finish(JSON.stringify(request));
});
"#;
fn setup(mode: &str, file: bool) -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    fs::create_dir_all(home.path().join("profiles/owl")).unwrap();
    fs::create_dir(home.path().join("workspace")).unwrap();
    fs::write(home.path().join("fake-acp.cjs"), SERVER).unwrap();
    let command_args = format!("'{}' {mode}", home.path().join("fake-acp.cjs").display());
    fs::write(
        home.path().join(".env"),
        format!(
            "HERMES_COPILOT_ACP_COMMAND=node\nHERMES_COPILOT_ACP_ARGS={}\n",
            serde_json::to_string(&command_args).unwrap()
        ),
    )
    .unwrap();
    let options = json!({"cwd":home.path().join("workspace"),"enabledToolsets":if file{vec!["file"]}else{vec![]}});
    runtime_store::open(home.path()).unwrap().execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt,options) VALUES('s','local','owl','',?)",[options.to_string()]).unwrap();
    home
}
fn args() -> Value {
    json!({"model":"copilot-acp","context":{"systemPrompt":"private system","tools":[{"name":"memory","parameters":{"type":"object"}}],"messages":[{"role":"user","content":[{"type":"text","text":"Remember tea"}]}]}})
}

#[tokio::test]
async fn real_process_handshake_transcript_chunks_and_tool_calls() {
    let home = setup("normal", true);
    let result = acp::complete(home.path(), "owl", "s", &args(), |_| async {
        panic!("no approvals expected")
    })
    .await
    .unwrap();
    assert_eq!(result["text"], "Done");
    assert_eq!(result["thinking"], "Reasoning");
    assert_eq!(result["stopReason"], "toolUse");
    assert_eq!(
        result["toolCalls"][0],
        json!({"id":"call_1","name":"memory","arguments":{"action":"add","content":"tea"}})
    );
    // Lease is released and the transport can be reused after every completion.
    assert!(
        acp::complete(home.path(), "owl", "s", &args(), |_| async { Ok(false) })
            .await
            .is_ok()
    );
}
#[tokio::test]
async fn approval_choices_and_workspace_files_obey_policy() {
    for allow in [true, false] {
        let home = setup("permission", true);
        let result = acp::complete(home.path(), "owl", "s", &args(), move |params| async move {
            assert_eq!(params["toolCall"]["title"], "command");
            Ok(allow)
        })
        .await
        .unwrap();
        let result: Value = serde_json::from_str(result["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            result["outcome"]["outcome"],
            if allow { "selected" } else { "cancelled" }
        );
        if allow {
            assert_eq!(result["outcome"]["optionId"], "yes");
        }
    }
    for (enabled, allow) in [(true, true), (true, false), (false, true)] {
        let home = setup("files", enabled);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let result = acp::complete(home.path(), "owl", "s", &args(), move |params| {
            seen.lock().unwrap().push(params);
            async move { Ok(allow) }
        })
        .await
        .unwrap();
        let result: Value = serde_json::from_str(result["text"].as_str().unwrap()).unwrap();
        assert!(result["secret"]["error"].is_object());
        if enabled && allow {
            assert_eq!(result["read"]["result"]["content"], "second\n");
            assert_eq!(
                fs::read_to_string(home.path().join("workspace/nested/note.txt")).unwrap(),
                "first\nsecond\nthird\n"
            );
        } else {
            assert!(result["write"]["error"].is_object());
            assert!(!home.path().join("workspace/nested/note.txt").exists());
        }
        assert_eq!(requests.lock().unwrap().len(), if enabled { 2 } else { 0 });
    }
    let home = setup("traversal", true);
    let result = acp::complete(home.path(), "owl", "s", &args(), |_| async {
        panic!("invalid paths must fail before approval")
    })
    .await
    .unwrap();
    assert!(
        result["text"]
            .as_str()
            .unwrap()
            .contains("Invalid ACP file path")
    );
    assert!(!home.path().join("escape").exists());
}
#[tokio::test]
async fn process_exit_invalid_json_remote_errors_and_timeout_fail_promptly() {
    for (mode, expected) in [
        ("exit", "exited"),
        ("malformed", "malformed JSON"),
        ("error", "Login required"),
        ("hang", "timed out"),
    ] {
        let home = setup(mode, true);
        let mut args = args();
        args["timeout_seconds"] = json!(if mode == "hang" { 0.1 } else { 5.0 });
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(6),
            acp::complete(home.path(), "owl", "s", &args, |_| async { Ok(false) }),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(result.message.contains(expected), "{}", result.message);
    }
}
#[tokio::test]
async fn cancellation_interrupts_pending_approval_and_reaps_child() {
    let home = setup("cancel", true);
    let (sent, mut ready) = tokio::sync::mpsc::unbounded_channel();
    let path = home.path().to_owned();
    let task = tokio::spawn(async move {
        acp::complete(&path, "owl", "s", &args(), move |params| {
            sent.send(params["toolCall"]["rawInput"]["pid"].as_u64().unwrap())
                .unwrap();
            async { std::future::pending::<hexbot_core::Result<bool>>().await }
        })
        .await
    });
    let pid = tokio::time::timeout(std::time::Duration::from_secs(5), ready.recv())
        .await
        .unwrap()
        .unwrap();
    let duplicate = acp::complete(home.path(), "owl", "s", &args(), |_| async { Ok(false) })
        .await
        .unwrap_err();
    assert!(duplicate.message.contains("already running"));
    acp::cancel(home.path(), "s").await;
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(result.message.contains("interrupted"));
    #[cfg(unix)]
    unsafe {
        assert_eq!(libc::kill(pid as i32, 0), -1);
    }
    let mut bad = args();
    bad["timeout_seconds"] = json!(0.05);
    assert!(
        acp::complete(home.path(), "owl", "s", &bad, |_| async { Ok(false) })
            .await
            .unwrap_err()
            .message
            .contains("timed out")
    );
    assert!(common::identifier("s").is_ok());
}
