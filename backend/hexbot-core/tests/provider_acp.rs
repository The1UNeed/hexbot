use hexbot_core::{common, credentials, db, provider_acp as acp, runtime_store};
use serde_json::{Value, json};
use std::fs;
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

const SERVER: &str = r#"
const readline = require('node:readline');
const mode = process.argv[2];
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
let promptId; const replies = {};
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
   const fs = request.params.clientCapabilities.fs;
   if(fs.readTextFile!==false||fs.writeTextFile!==false) process.exit(5);
   send({id:request.id,result:{protocolVersion:1,agentCapabilities:{}}});
 } else if(request.method==='session/new') { send({id:request.id,result:{sessionId:'a'}}); }
 else if(request.method==='session/prompt') {
   promptId=request.id;
   if(mode==='exit') process.exit(3);
   if(mode==='malformed') {process.stdout.write('bad json\n');return;}
   if(mode==='error') {send({id:request.id,error:{code:-32000,message:'Login required'}});return;}
   if(mode==='hang') return;
   if(mode==='cancel') { globalThis.keep = require('node:net').connect(Number(process.argv[3]),'127.0.0.1',function(){this.write('running\n');}); return; }
   if(mode==='env') { finish(JSON.stringify(process.env)); return; }
   if(mode==='secrets') {
     const fs=require('node:fs'), path=require('node:path'), home=path.dirname(__filename);
     const read=file=>{try{return fs.readFileSync(path.join(home,file),'utf8')}catch(error){return 'ERR '+error.code}};
     finish(JSON.stringify({env:read('.env'),connect:read('connect.json'),auth:read('profiles/owl/pi/auth.json'),workspace:read('../workspace/public.txt')}));
     return;
   }
   if(mode==='permission') {
     send({id:90,method:'session/request_permission',params:{sessionId:'a',toolCall:{title:'rm -rf ~/important',kind:'execute'},options:[{optionId:'no',kind:'reject_once'},{optionId:'yes',kind:'allow_once'}]}});
   } else if(mode==='files') {
     send({id:91,method:'fs/write_text_file',params:{sessionId:'a',path:'nested/note.txt',content:'first\nsecond\nthird\n'}});
   } else {
     const prompt=request.params.prompt[0].text;
     if(!prompt.includes('memory')||!prompt.includes('Remember tea')||!prompt.includes('private system'))process.exit(4);
     finish('Done <tool_call>'+JSON.stringify({id:'call_1',type:'function',function:{name:'memory',arguments:'{"action":"add","content":"tea"}'}})+'</tool_call>');
   }
 } else if(request.id===90) { finish(JSON.stringify(request.result)); }
 else if(request.id===91) {replies.write=request;send({id:92,method:'fs/read_text_file',params:{sessionId:'a',path:'nested/note.txt',line:2,limit:1}});}
 else if(request.id===92) {replies.read=request;finish(JSON.stringify(replies));}
});
"#;
/// A Hexbot home and, beside it, the session workspace: the daemon never saves
/// a working directory inside its home.
struct Home {
    root: tempfile::TempDir,
    home: std::path::PathBuf,
}
impl Home {
    fn path(&self) -> &std::path::Path {
        &self.home
    }
    fn workspace(&self) -> std::path::PathBuf {
        self.root.path().join("workspace")
    }
}
fn setup(mode: &str, file: bool) -> Home {
    setup_with(mode, file, "")
}
fn setup_with(mode: &str, file: bool, extra: &str) -> Home {
    let root = tempfile::tempdir().unwrap();
    let home = Home {
        home: root.path().join("home"),
        root,
    };
    fs::create_dir(home.path()).unwrap();
    db::migrate(home.path()).unwrap();
    fs::create_dir_all(home.path().join("profiles/owl")).unwrap();
    fs::create_dir(home.workspace()).unwrap();
    fs::write(home.path().join("fake-acp.cjs"), SERVER).unwrap();
    let command_args = format!(
        "'{}' {mode} {extra}",
        home.path().join("fake-acp.cjs").display()
    );
    fs::write(
        home.path().join(".env"),
        format!(
            "HEXBOT_COPILOT_ACP_COMMAND=node\nHEXBOT_COPILOT_ACP_ARGS={}\nHERMES_COPILOT_ACP_COMMAND=/nonexistent\nHERMES_COPILOT_ACP_ARGS=invalid\nOPENAI_API_KEY=provider-secret\nCUSTOM_CONNECTOR_VALUE=connector-secret\nHEXBOT_TOKEN=daemon-secret\nGH_TOKEN=gh-login\n",
            serde_json::to_string(&command_args).unwrap()
        ),
    )
    .unwrap();
    let options = json!({"cwd":home.workspace(),"enabledToolsets":if file{vec!["file","terminal"]}else{vec![]}});
    runtime_store::open(home.path()).unwrap().execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt,options) VALUES('s','local','owl','',?)",[options.to_string()]).unwrap();
    home
}
fn args() -> Value {
    json!({"model":"copilot-acp","context":{"systemPrompt":"private system","tools":[{"name":"memory","parameters":{"type":"object"}}],"messages":[{"role":"user","content":[{"type":"text","text":"Remember tea"}]}]}})
}

#[tokio::test]
async fn real_process_handshake_transcript_chunks_and_tool_calls() {
    let home = setup("normal", true);
    let result = acp::complete(home.path(), "owl", "s", &args())
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
        acp::complete(home.path(), "owl", "s", &args())
            .await
            .is_ok()
    );
}
/// Copilot's own tools run outside the section's toolsets, approval mode, and sandbox,
/// so no permission is granted and no file bridge exists, whatever the section allows.
#[tokio::test]
async fn copilot_tools_are_never_granted() {
    for file in [true, false] {
        let home = setup("permission", file);
        let result = acp::complete(home.path(), "owl", "s", &args())
            .await
            .unwrap();
        let result: Value = serde_json::from_str(result["text"].as_str().unwrap()).unwrap();
        assert_eq!(result, json!({"outcome":{"outcome":"cancelled"}}));

        let home = setup("files", file);
        let result = acp::complete(home.path(), "owl", "s", &args())
            .await
            .unwrap();
        let result: Value = serde_json::from_str(result["text"].as_str().unwrap()).unwrap();
        assert!(result["write"]["error"].is_object());
        assert!(result["read"]["error"].is_object());
        assert!(!home.workspace().join("nested/note.txt").exists());
    }
}
/// The child starts from the same allowlist as every other child process, plus the
/// GitHub login variables Copilot CLI needs; provider and daemon secrets stay home.
#[tokio::test]
async fn child_environment_is_an_allowlist() {
    let home = setup("env", true);
    let result = acp::complete(home.path(), "owl", "s", &args())
        .await
        .unwrap();
    let env: Value = serde_json::from_str(result["text"].as_str().unwrap()).unwrap();
    assert_eq!(env["GH_TOKEN"], "gh-login");
    assert!(env["PATH"].is_string());
    // macOS re-adds its own `__CF_*` variables to every child, and bubblewrap sets
    // PWD to the working directory it enters; everything else the daemon holds
    // must be allowlisted or one of Copilot's GitHub login variables.
    let copilot_login = [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "COPILOT_GITHUB_TOKEN",
        "GH_HOST",
        "XDG_CONFIG_HOME",
    ];
    let bubblewrap = credentials::sandbox() == Some("bubblewrap");
    for (key, _) in std::env::vars() {
        assert!(
            key.starts_with("__")
                || (bubblewrap && key == "PWD")
                || credentials::inherited_environment(&key)
                || copilot_login.contains(&key.as_str())
                || env.get(&key).is_none(),
            "Copilot received {key}"
        );
    }
    if bubblewrap {
        let workspace = fs::canonicalize(home.workspace()).unwrap();
        assert_eq!(env["PWD"].as_str().unwrap(), workspace.to_str().unwrap());
    }
    assert!(env.get("OPENAI_API_KEY").is_none());
    assert!(env.get("CUSTOM_CONNECTOR_VALUE").is_none());
    assert!(env.get("HEXBOT_TOKEN").is_none());
}
/// The child runs in the same sandbox as scripts: daemon credentials are unreadable
/// (bubblewrap serves them empty), the workspace beside the home is not.
#[tokio::test]
async fn child_cannot_read_daemon_credentials() {
    if !hexbot_core::credentials::isolation_available() {
        return;
    }
    let home = setup("secrets", true);
    fs::write(home.path().join("connect.json"), "connect-secret").unwrap();
    fs::create_dir_all(home.path().join("profiles/owl/pi")).unwrap();
    fs::write(home.path().join("profiles/owl/pi/auth.json"), "auth-secret").unwrap();
    fs::write(home.workspace().join("public.txt"), "public").unwrap();
    let result = acp::complete(home.path(), "owl", "s", &args())
        .await
        .unwrap();
    let seen: Value = serde_json::from_str(result["text"].as_str().unwrap()).unwrap();
    for key in ["env", "connect", "auth"] {
        assert!(
            !seen[key].as_str().unwrap().contains("secret"),
            "{key}: {}",
            seen[key]
        );
    }
    assert_eq!(seen["workspace"], "public");
}
#[tokio::test]
async fn missing_cli_reports_install_instructions_without_a_sandbox() {
    let missing = setup("normal", true);
    fs::write(
        missing.path().join(".env"),
        "HEXBOT_COPILOT_ACP_COMMAND=no-such-copilot-cli\n",
    )
    .unwrap();
    let error = acp::complete(missing.path(), "owl", "s", &args())
        .await
        .unwrap_err();
    assert!(
        error
            .message
            .contains("Could not start Copilot ACP command")
    );
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
            acp::complete(home.path(), "owl", "s", &args),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(result.message.contains(expected), "{}", result.message);
    }
}
#[tokio::test]
async fn cancellation_interrupts_the_turn_and_reaps_child() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let home = setup_with("cancel", true, &port);
    let path = home.path().to_owned();
    let task = tokio::spawn(async move { acp::complete(&path, "owl", "s", &args()).await });
    // The child holds this socket open for its lifetime: EOF proves it was reaped,
    // whatever PID namespace the sandbox gives it.
    let (socket, _) = tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut socket = tokio::io::BufReader::new(socket);
    let mut line = String::new();
    socket.read_line(&mut line).await.unwrap();
    assert_eq!(line.trim(), "running");
    let duplicate = acp::complete(home.path(), "owl", "s", &args())
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
    let mut rest = String::new();
    let closed = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        socket.read_to_string(&mut rest),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(closed, 0, "child still alive: {rest}");
    let mut bad = args();
    bad["timeout_seconds"] = json!(0.05);
    assert!(
        acp::complete(home.path(), "owl", "s", &bad)
            .await
            .unwrap_err()
            .message
            .contains("timed out")
    );
    assert!(common::identifier("s").is_ok());
}
/// A relative command is found in the session workspace, where the child starts.
#[tokio::test]
#[cfg(unix)]
async fn relative_command_resolves_against_the_workspace() {
    let home = setup("normal", true);
    let launcher = home.workspace().join("copilot");
    fs::write(
        &launcher,
        format!(
            "#!/bin/sh\nexec node '{}' normal\n",
            home.path().join("fake-acp.cjs").display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(
        home.path().join(".env"),
        "HEXBOT_COPILOT_ACP_COMMAND=./copilot\nHEXBOT_COPILOT_ACP_ARGS=\n",
    )
    .unwrap();
    let result = acp::complete(home.path(), "owl", "s", &args())
        .await
        .unwrap();
    assert_eq!(result["text"], "Done");
}
