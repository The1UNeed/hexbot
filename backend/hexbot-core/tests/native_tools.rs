use axum::{Json, Router, extract::State, http::HeaderMap, routing::post};
use hexbot_core::{common, db, native_tools};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
mod support;
fn home(mut config: Value) -> support::TestHome {
    let home = support::TestHome::new();
    db::migrate(home.path()).unwrap();
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT INTO bots(name,owner_id,workdir) VALUES ('tester','local',NULL)",
            [],
        )
        .unwrap();
    std::fs::create_dir_all(home.path().join("profiles/tester")).unwrap();
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT INTO settings(key,value) VALUES('workspace_dir',?)",
            [json!(home.workspace()).to_string()],
        )
        .unwrap();
    config["security"] = json!({"allow_private_urls":true});
    common::write_config(home.path(), &config).unwrap();
    home
}
async fn call(home: &Path, name: &str, args: Value) -> hexbot_core::Result<Value> {
    native_tools::call(home, "local", "tester", "conversation", name, &args).await
}
#[tokio::test]
async fn code_and_the_browser_never_run_on_the_daemons_computer() {
    // A bot from before Computer use took them over still lists them.
    let h = home(json!({"browser":{"command":"/bin/echo"}}));
    common::write_config(
        &h.path().join("profiles/tester"),
        &json!({"tools":{"enabled_toolsets":["code_execution","browser"]}}),
    )
    .unwrap();
    let offered = native_tools::descriptors(h.path(), "tester").unwrap();
    assert!(!offered.iter().any(|d| {
        let name = d["name"].as_str().unwrap_or_default();
        name == "execute_code" || name.starts_with("browser_")
    }));
    for (name, args) in [
        ("execute_code", json!({"code":"print(1)"})),
        ("browser_navigate", json!({"url":"https://example.com"})),
    ] {
        assert_eq!(
            call(h.path(), name, args).await.unwrap_err().code,
            4302,
            "{name}"
        );
    }
}
type Requests = Arc<Mutex<Vec<(HeaderMap, Value)>>>;
async fn service(
    State(state): State<Requests>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let extract = payload.get("urls").is_some();
    state.lock().unwrap().push((headers, payload));
    if extract {
        Json(
            json!({"results":[{"url":"https://example.test/page","raw_content":"你好".repeat(3000)}]}),
        )
    } else {
        Json(
            json!({"results":[{"title":"Result","url":"https://example.test/page","content":"Description"}]}),
        )
    }
}
#[tokio::test]
async fn configured_web_search_extract_headers_payload_and_artifacts() {
    let requests: Requests = Default::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .route("/search", post(service))
        .route("/extract", post(service))
        .with_state(requests.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let h = home(json!({"tools":{"enabled_toolsets":["web"]},"web":{"backend":"tavily"}}));
    std::fs::write(
        h.path().join(".env"),
        format!("TAVILY_API_KEY=private-test-key\nTAVILY_BASE_URL=http://{address}\n"),
    )
    .unwrap();
    let found = call(
        h.path(),
        "web_search",
        json!({"query":"test phrase","limit":7}),
    )
    .await
    .unwrap();
    assert_eq!(found["data"]["web"][0]["description"], "Description");
    let extracted = call(
        h.path(),
        "web_extract",
        json!({"urls":[format!("http://{address}/page")],"char_limit":2000}),
    )
    .await
    .unwrap();
    let file = extracted["results"][0]["full_content_path"]
        .as_str()
        .unwrap();
    assert!(Path::new(file).starts_with(h.path()));
    assert_eq!(std::fs::read_to_string(file).unwrap(), "你好".repeat(3000));
    let saved = requests.lock().unwrap();
    assert_eq!(saved[0].0["authorization"], "Bearer private-test-key");
    assert_eq!(saved[0].1, json!({"query":"test phrase","max_results":7}));
    assert_eq!(saved[1].1["format"], "markdown");
    server.abort();
}
#[tokio::test]
async fn vision_executes_the_configured_http_service() {
    let requests: Requests = Default::default();
    let records = requests.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new().route(
        "/chat/completions",
        post(move |headers: HeaderMap, Json(payload): Json<Value>| {
            let records = records.clone();
            async move {
                records.lock().unwrap().push((headers, payload));
                Json(json!({"choices":[{"message":{"content":"A red square"}}]}))
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let h = home(
        json!({"tools":{"enabled_toolsets":["vision"]},"auxiliary":{"vision":{"provider":"openai","model":"vision-test","base_url":format!("http://{address}")}}}),
    );
    std::fs::write(h.path().join(".env"), "OPENAI_API_KEY=private-test-key\n").unwrap();
    let vision = call(
        h.path(),
        "vision_analyze",
        json!({"image_url":"data:image/png;base64,aGVsbG8=","question":"What color?"}),
    )
    .await
    .unwrap();
    assert_eq!(vision["analysis"], "A red square");
    assert_eq!(requests.lock().unwrap()[0].1["model"], "vision-test");
    server.abort();
}
#[cfg(unix)]
#[tokio::test]
async fn speech_checks_the_requested_provider_instead_of_the_default() {
    let h = home(json!({"tools":{"enabled_toolsets":["tts"]},"tts":{
        "provider":"edge","edge":{"command": "/missing/hexbot-edge-tts"}
    }}));
    let say = script(
        h.path(),
        "say.py",
        "import sys\nopen(sys.argv[1],'wb').write(b'ID3test-audio')\n",
    );
    let mut cfg = common::read_config(h.path()).unwrap();
    cfg["tts"]["providers"]["say"] =
        json!({"type":"command","command":say,"args":["{output_path}"]});
    common::write_config(h.path(), &cfg).unwrap();
    let audio = call(
        h.path(),
        "text_to_speech",
        json!({"text":"Hello","provider":"say"}),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(audio["file_path"].as_str().unwrap()).unwrap(),
        b"ID3test-audio"
    );
    // Cloud voices went with the Premium voice connector.
    let denied = call(
        h.path(),
        "text_to_speech",
        json!({"text":"Hello","provider":"elevenlabs"}),
    )
    .await
    .unwrap_err();
    assert_eq!(denied.code, 4302);
    assert!(denied.message.contains("not set up"));
}

#[tokio::test]
async fn vision_crop_sends_actual_image_bytes() {
    use base64::Engine;
    let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        4,
        4,
        image::Rgba([255, 0, 0, 255]),
    ));
    let mut png = std::io::Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png).unwrap();
    let png = png.into_inner();
    let records: Requests = Default::default();
    let vision_records = records.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new().route(
        "/chat/completions",
        post(move |headers: HeaderMap, Json(payload): Json<Value>| {
            let records = vision_records.clone();
            async move {
                records.lock().unwrap().push((headers, payload));
                Json(json!({"choices":[{"message":{"content":"Cropped image"}}]}))
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let h = home(
        json!({"tools":{"enabled_toolsets":["vision"]},"auxiliary":{"vision":{"provider":"openai","base_url":format!("http://{address}")}}}),
    );
    std::fs::create_dir_all(h.workspace()).unwrap();
    let input = h.workspace().join("input.png");
    std::fs::write(&input, &png).unwrap();
    call(
        h.path(),
        "vision_analyze",
        json!({"image_url":input,"question":"Look","region":[1,1,3,4]}),
    )
    .await
    .unwrap();
    let record = records.lock().unwrap()[0].1.clone();
    let data = record["messages"][0]["content"][1]["image_url"]["url"]
        .as_str()
        .unwrap()
        .split_once(',')
        .unwrap()
        .1;
    let cropped = image::load_from_memory(
        &base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap(),
    )
    .unwrap();
    assert_eq!((cropped.width(), cropped.height()), (2, 3));
    assert_eq!(
        call(
            h.path(),
            "vision_analyze",
            json!({"image_url":input,"question":"Look","region":[0,0,100,100]})
        )
        .await
        .unwrap_err()
        .code,
        4202
    );
    server.abort();
}
#[cfg(unix)]
fn script(home: &Path, name: &str, code: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = home.join(name);
    std::fs::write(&path, format!("#!/usr/bin/env python3\n{code}")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path
}
/// A stand-in for the `cua` CLI: a sandbox recorded in a file, `cua mcp`
/// answering the computer tools, and a viewer link to `upstream.txt`. While
/// `engine-down` exists Docker does not answer: the sandbox reads as missing.
#[cfg(unix)]
const FAKE_CUA: &str = r#"import json,sys,pathlib,os,base64
here=pathlib.Path(__file__).parent
state=here/'sandbox.json'
def log(row):
    row['secret']=os.getenv('OPENAI_API_KEY'); row['telemetry']=os.getenv('CUA_TELEMETRY')
    with (here/'cua.log').open('a') as f: f.write(json.dumps(row)+'\n')
args=sys.argv[1:]
log({'argv':args})
down=(here/'engine-down').exists()
if args[:2]==['runtime','doctor']:
    print(json.dumps({'backends':[{'backend':'container','ready':not down}]})); sys.exit(0)
if args[:2]==['sb','info'] and (here/'info-fails-once').exists():
    (here/'info-fails-once').unlink(); print('cua: the daemon did not answer',file=sys.stderr); sys.exit(1)
if args[:2]==['sb','info'] and (here/'turn-off-during-info').exists():
    (here/'turn-off-during-info').unlink()
    saved=json.loads((here/'computer.json').read_text()); saved['on']=False
    (here/'computer.json').write_text(json.dumps(saved))
if args[:2]==['sb','info']:
    if not state.exists(): print('cua: not found: sandbox',file=sys.stderr); sys.exit(3)
    if down: print(json.dumps({'name':args[2],'state':'missing','status':'missing'})); sys.exit(0)
    print(state.read_text()); sys.exit(0)
if args[:2]==['sb','resume']:
    if down: print('cua: local runtime: instance not found',file=sys.stderr); sys.exit(1)
    state.write_text(json.dumps({'name':args[2],'state':'running','status':'ready'})); sys.exit(0)
if args[:2]==['sb','suspend']:
    state.write_text(json.dumps({'name':args[2],'state':'stopped','status':'stopped'})); sys.exit(0)
if args[:2]==['sb','create']:
    if (here/'slow').exists():
        (here/'creating').write_text('1'); import time; time.sleep(60)
    state.write_text(json.dumps({'name':args[args.index('--name')+1],'state':'running','status':'ready'})); print(state.read_text()); sys.exit(0)
if args[:2]==['sb','rm']:
    state.unlink(missing_ok=True); sys.exit(0)
if args[:2]==['sb','view']:
    upstream=(here/'upstream.txt').read_text().strip()
    print(json.dumps({'url':upstream+'/viewer/#ticket=abc&files=%2Fhome%2Fcua'})); sys.exit(0)
if args[0]=='mcp':
    png=base64.b64encode(b'\x89PNG\r\n\x1a\nscreen').decode()
    for line in sys.stdin:
        r=json.loads(line)
        if 'id' not in r: continue
        m=r.get('method')
        if m=='initialize': result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'cua','version':'1'}}
        elif m=='tools/list': result={'tools':[]}
        elif m=='tools/call':
            name=r['params']['name']; log({'tool':name,'args':r['params'].get('arguments',{})})
            if name=='computer_click' and (here/'hold').exists():
                import time
                while (here/'hold').exists(): time.sleep(0.02)
                log({'done':name})
            if name=='computer_screenshot': result={'content':[{'type':'image','mimeType':'image/png','data':png}]}
            else: result={'content':[{'type':'text','text':json.dumps({'success':True})}]}
        else: result={}
        print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}),flush=True)
"#;
#[cfg(unix)]
#[tokio::test]
async fn bots_share_one_computer_and_take_turns() {
    use hexbot_core::computers;
    let h = home(json!({"tools":{"enabled_toolsets":["computer_use"]}}));
    let cua = script(h.path(), "cua-test", FAKE_CUA);
    std::fs::write(
        h.path().join(".env"),
        format!(
            "OPENAI_API_KEY=must-not-reach-cua\nHEXBOT_CUA_CMD={}\n",
            cua.display()
        ),
    )
    .unwrap();
    assert!(
        native_tools::descriptors(h.path(), "tester")
            .unwrap()
            .iter()
            .any(|d| d["name"] == "computer_use")
    );
    let status = computers::call(h.path(), "hexbot.computer.status", &json!({}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status["state"], "absent");
    assert_eq!(status["control"], "bot");
    // The first action creates the computer at the chosen size.
    let shot = call(h.path(), "computer_use", json!({"action":"screenshot"}))
        .await
        .unwrap();
    assert!(Path::new(shot["screenshot_path"].as_str().unwrap()).is_file());
    call(
        h.path(),
        "computer_use",
        json!({"action":"click","coordinate":[10,20]}),
    )
    .await
    .unwrap();
    call(
        h.path(),
        "computer_use",
        json!({"action":"key","keys":"ctrl+l"}),
    )
    .await
    .unwrap();
    // While the user has control, the bot's actions wait.
    computers::call(
        h.path(),
        "hexbot.computer.control",
        &json!({"holder":"user"}),
    )
    .await
    .unwrap()
    .unwrap();
    let refused = call(
        h.path(),
        "computer_use",
        json!({"action":"click","coordinate":[1,2]}),
    )
    .await
    .unwrap_err();
    assert!(refused.message.contains("taken over"));
    computers::call(
        h.path(),
        "hexbot.computer.control",
        &json!({"holder":"bot"}),
    )
    .await
    .unwrap()
    .unwrap();
    call(
        h.path(),
        "computer_use",
        json!({"action":"type","text":"hello"}),
    )
    .await
    .unwrap();
    let rows = std::fs::read_to_string(h.path().join("cua.log"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(rows.iter().all(|row| row["secret"].is_null()));
    assert!(rows.iter().all(|row| row["telemetry"] == "0"));
    let create = rows.iter().find(|row| row["argv"][1] == "create").unwrap()["argv"].clone();
    let name = computers::sandbox(h.path());
    assert!(name.starts_with("hexbot-computer-"));
    assert_eq!(create[2], "linux");
    for pair in [
        ["--name", name.as_str()],
        ["--cpu", "2"],
        ["--memory", "4GB"],
    ] {
        let at = create
            .as_array()
            .unwrap()
            .iter()
            .position(|v| v == pair[0])
            .unwrap();
        assert_eq!(create[at + 1], pair[1]);
    }
    let tools = rows
        .iter()
        .filter(|row| row["tool"].is_string())
        .map(|row| (row["tool"].as_str().unwrap(), row["args"].clone()))
        .collect::<Vec<_>>();
    assert_eq!(
        tools,
        vec![
            ("computer_screenshot", json!({})),
            ("computer_click", json!({"x":10,"y":20,"button":"left"})),
            ("computer_hotkey", json!({"keys":"ctrl+l"})),
            ("computer_type", json!({"text":"hello"})),
        ]
    );
    // A second bot works on the same computer. Both act at once; they take
    // turns, and each keeps a cursor where it last acted.
    db::open(h.path())
        .unwrap()
        .execute(
            "INSERT INTO bots(name,owner_id,workdir) VALUES ('helper','local',NULL)",
            [],
        )
        .unwrap();
    std::fs::create_dir_all(h.path().join("profiles/helper")).unwrap();
    let double = json!({"action":"double_click","coordinate":[300,150]});
    let (first, second) = tokio::join!(
        call(
            h.path(),
            "computer_use",
            json!({"action":"click","coordinate":[600,375]}),
        ),
        native_tools::call(
            h.path(),
            "local",
            "helper",
            "conversation",
            "computer_use",
            &double,
        ),
    );
    first.unwrap();
    second.unwrap();
    let status = computers::call(h.path(), "hexbot.computer.status", &json!({}))
        .await
        .unwrap()
        .unwrap();
    assert!(status["actor"].is_null());
    let cursor = |bot: &str| {
        status["cursors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["bot"] == bot)
            .cloned()
            .unwrap()
    };
    assert_eq!(
        (cursor("tester")["x"].clone(), cursor("tester")["y"].clone()),
        (json!(0.5), json!(0.5))
    );
    assert_eq!(cursor("helper")["action"], "double_click");
    assert_eq!(
        (cursor("helper")["x"].clone(), cursor("helper")["y"].clone()),
        (json!(0.25), json!(0.2))
    );
    let creates = std::fs::read_to_string(h.path().join("cua.log"))
        .unwrap()
        .lines()
        .filter(|line| line.contains("\"create\""))
        .count();
    assert_eq!(creates, 1);
    // A deleted bot's cursor goes; the computer stays.
    computers::forget_bot(h.path(), "helper").await;
    let status = computers::call(h.path(), "hexbot.computer.status", &json!({}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status["cursors"].as_array().unwrap().len(), 1);
    assert_eq!(status["state"], "running");
    native_tools::close_session(h.path(), "conversation").await;
    hexbot_core::connectors::close_bot(h.path(), "tester").await;
    hexbot_core::connectors::close_bot(h.path(), "helper").await;
}
/// Docker stops and its engine will not start: a bot's action fails at once
/// and says why, the computer is kept, and the error clears once Docker is
/// back, whether the user looks first or a bot acts first.
#[cfg(unix)]
#[tokio::test]
async fn a_computer_docker_cannot_find_fails_at_once_and_is_kept() {
    use hexbot_core::computers;
    let h = running_computer().await;
    let down = |down: bool| {
        for marker in ["engine-down", "engine-broken"] {
            if down {
                std::fs::write(h.path().join(marker), "").unwrap();
            } else {
                std::fs::remove_file(h.path().join(marker)).unwrap();
            }
        }
    };
    down(true);
    let started = std::time::Instant::now();
    let error = call(h.path(), "computer_use", json!({"action":"screenshot"}))
        .await
        .unwrap_err();
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    assert!(
        error.message.starts_with("Docker is not running"),
        "{}",
        error.message
    );
    let status = computer_status(h.path()).await;
    assert_eq!(status["state"], "error");
    assert_eq!(status["error"], error.message.as_str());
    // Nothing on it is lost: the computer is not made again.
    let steps = cua_log(h.path())
        .lines()
        .filter(|line| line.contains("\"create\"") || line.contains("\"rm\""))
        .count();
    assert_eq!(steps, 1);
    down(false);
    let status = computer_status(h.path()).await;
    assert_eq!(status["state"], "running");
    assert!(status["error"].is_null());
    down(true);
    call(h.path(), "computer_use", json!({"action":"screenshot"}))
        .await
        .unwrap_err();
    down(false);
    let events = hexbot_core::events::EventHub::new();
    computers::attach(h.path(), events.clone());
    let mut changes = events.subscribe();
    call(h.path(), "computer_use", json!({"action":"screenshot"}))
        .await
        .unwrap();
    let mut last = Value::Null;
    while let Ok(event) = changes.try_recv() {
        if event.frame["params"]["type"] == "hexbot.computer.changed" {
            last = event.frame["params"]["payload"].clone();
        }
    }
    assert_eq!(last["state"], "running");
    assert!(last["error"].is_null(), "{last}");
    native_tools::close_session(h.path(), "conversation").await;
    hexbot_core::connectors::close_bot(h.path(), "tester").await;
}
#[cfg(unix)]
#[tokio::test]
async fn computer_screen_is_served_through_the_daemon_and_embeddable() {
    use axum::{body::Body, http::Request, routing::get};
    use hexbot_core::computers;
    let h = home(json!({"tools":{"enabled_toolsets":["computer_use"]}}));
    let cua = script(h.path(), "cua-test", FAKE_CUA);
    std::fs::write(
        h.path().join(".env"),
        format!("HEXBOT_CUA_CMD={}\n", cua.display()),
    )
    .unwrap();
    let seen: Arc<Mutex<Vec<HeaderMap>>> = Default::default();
    let recorded = seen.clone();
    let viewer = Router::new()
        .route(
            "/viewer/",
            get(move |headers: HeaderMap| {
                recorded.lock().unwrap().push(headers);
                async {
                    (
                        [(
                            "content-security-policy",
                            "default-src 'self'; frame-ancestors 'none'",
                        )],
                        axum::response::Html("<html><head></head><body>viewer page</body></html>"),
                    )
                }
            }),
        )
        .route(
            "/cua.env.v1.StreamService/SetPreferences",
            axum::routing::post(|| async { "resized" }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, viewer).await.unwrap() });
    std::fs::write(h.path().join("upstream.txt"), format!("http://{address}")).unwrap();
    let view = computers::call(h.path(), "hexbot.computer.view", &json!({}))
        .await
        .unwrap()
        .unwrap();
    let path = view["path"].as_str().unwrap();
    let (location, fragment) = path.split_once('#').unwrap();
    assert_eq!(fragment, "ticket=abc&files=%2Fhome%2Fcua");
    assert_eq!(view["control"], false);
    let token = location
        .strip_prefix("/hexbot/computer/")
        .unwrap()
        .strip_suffix("/viewer/")
        .unwrap();
    let request = Request::get(location)
        .header("cookie", "hexbot_session=secret")
        .body(Body::empty())
        .unwrap();
    let response = computers::proxy(token.to_owned(), request).await;
    assert_eq!(response.status(), 200);
    let policy = response.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(policy.contains("default-src 'self'"));
    assert!(!policy.contains("frame-ancestors 'none'"));
    assert!(policy.contains("frame-ancestors 'self' hexbot-app:"));
    let body = axum::body::to_bytes(response.into_body(), 1024)
        .await
        .unwrap();
    // A watching page hides the viewer's toolbar.
    let body = String::from_utf8_lossy(&body);
    assert!(body.contains("viewer page"));
    assert!(body.contains(".cua-toolbar"));
    assert!(seen.lock().unwrap()[0].get("cookie").is_none());
    // Hex Connect's edge drops the trailing slash; the page still loads.
    let stripped = computers::proxy(
        token.to_owned(),
        Request::get(location.trim_end_matches('/'))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(stripped.status(), 200);
    let body = axum::body::to_bytes(stripped.into_body(), 1024)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains(".cua-toolbar"));
    // The viewer may not shrink the stream to its window; the quality decides.
    let resize = computers::proxy(
        token.to_owned(),
        Request::post(format!(
            "/hexbot/computer/{token}/cua.env.v1.StreamService/SetPreferences"
        ))
        .body(Body::empty())
        .unwrap(),
    )
    .await;
    assert_eq!(resize.status(), 403);
    // A link may fix the screen's quality; an unknown one is refused.
    let fixed = computers::call(
        h.path(),
        "hexbot.computer.view",
        &json!({"quality":"720p30"}),
    )
    .await
    .unwrap();
    assert!(fixed.is_ok());
    let unknown = computers::call(h.path(), "hexbot.computer.view", &json!({"quality":"4k"}))
        .await
        .unwrap();
    assert_eq!(unknown.unwrap_err().code, 4202);
    // An unknown token reaches nothing.
    let missing = computers::proxy(
        "nope".into(),
        Request::get("/hexbot/computer/nope/viewer/")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(missing.status(), 404);
    server.abort();
}
#[cfg(unix)]
#[tokio::test]
async fn a_bot_action_under_way_keeps_the_turn_until_it_ends() {
    use hexbot_core::computers;
    let h = home(json!({"tools":{"enabled_toolsets":["computer_use"]}}));
    let cua = script(h.path(), "cua-test", FAKE_CUA);
    std::fs::write(
        h.path().join(".env"),
        format!("HEXBOT_CUA_CMD={}\n", cua.display()),
    )
    .unwrap();
    db::open(h.path())
        .unwrap()
        .execute(
            "INSERT INTO bots(name,owner_id,workdir) VALUES ('helper','local',NULL)",
            [],
        )
        .unwrap();
    std::fs::create_dir_all(h.path().join("profiles/helper")).unwrap();
    // A conversation from before keeps the earlier tool's action names.
    let shot = call(h.path(), "computer_use", json!({"action":"capture"}))
        .await
        .unwrap();
    assert!(Path::new(shot["screenshot_path"].as_str().unwrap()).is_file());
    let log = || std::fs::read_to_string(h.path().join("cua.log")).unwrap_or_default();
    let hold = h.path().join("hold");
    let clicked = |log: &str| log.matches(r#""tool": "computer_click""#).count();
    let helper = |home: std::path::PathBuf| {
        tokio::spawn(async move {
            native_tools::call(
                &home,
                "local",
                "helper",
                "conversation",
                "computer_use",
                &json!({"action":"double_click","coordinate":[20,20]}),
            )
            .await
        })
    };
    // A click is under way, held by the computer, when its bot is stopped.
    std::fs::write(&hold, "").unwrap();
    let mut click = Box::pin(call(
        h.path(),
        "computer_use",
        json!({"action":"click","coordinate":[10,10]}),
    ));
    tokio::select! {
        _ = &mut click => panic!("the click should be held"),
        _ = async { while clicked(&log()) < 1 { tokio::task::yield_now().await } } => {}
    }
    drop(click);
    // Another bot waits for the click to end before acting.
    let mut second = helper(h.path().to_owned());
    let waited = tokio::time::timeout(std::time::Duration::from_secs(1), &mut second).await;
    assert!(waited.is_err(), "the second bot acted during the click");
    std::fs::remove_file(&hold).unwrap();
    second.await.unwrap().unwrap();
    let after = log();
    assert!(after.find(r#""done""#).unwrap() < after.find("computer_double_click").unwrap());
    // Taking control waits for a click under way, too.
    std::fs::write(&hold, "").unwrap();
    let home = h.path().to_owned();
    let click = tokio::spawn(async move {
        native_tools::call(
            &home,
            "local",
            "tester",
            "conversation",
            "computer_use",
            &json!({"action":"click","coordinate":[30,30]}),
        )
        .await
    });
    while clicked(&log()) < 2 {
        tokio::task::yield_now().await;
    }
    let home = h.path().to_owned();
    let mut take = tokio::spawn(async move {
        computers::call(&home, "hexbot.computer.control", &json!({"holder":"user"}))
            .await
            .unwrap()
    });
    let waited = tokio::time::timeout(std::time::Duration::from_secs(1), &mut take).await;
    assert!(waited.is_err(), "control was granted during the click");
    std::fs::remove_file(&hold).unwrap();
    click.await.unwrap().unwrap();
    assert_eq!(take.await.unwrap().unwrap()["control"], "user");
    hexbot_core::connectors::close_bot(h.path(), "tester").await;
    hexbot_core::connectors::close_bot(h.path(), "helper").await;
}
#[cfg(unix)]
#[tokio::test]
async fn a_bot_stopped_while_the_computer_starts_leaves_it_free() {
    use hexbot_core::computers;
    let h = home(json!({"tools":{"enabled_toolsets":["computer_use"]}}));
    let cua = script(h.path(), "cua-test", FAKE_CUA);
    std::fs::write(
        h.path().join(".env"),
        format!("HEXBOT_CUA_CMD={}\n", cua.display()),
    )
    .unwrap();
    std::fs::write(h.path().join("slow"), "").unwrap();
    let status = || async {
        computers::call(h.path(), "hexbot.computer.status", &json!({}))
            .await
            .unwrap()
            .unwrap()
    };
    // The bot's first action starts the computer; the bot is stopped meanwhile.
    let mut action = Box::pin(call(
        h.path(),
        "computer_use",
        json!({"action":"screenshot"}),
    ));
    tokio::select! {
        _ = &mut action => panic!("the start should still be running"),
        _ = async {
            while status().await["state"] != "starting" {
                tokio::task::yield_now().await;
            }
        } => {}
    }
    drop(action);
    assert_eq!(status().await["state"], "absent");
    let started = computers::call(h.path(), "hexbot.computer.start", &json!({}))
        .await
        .unwrap();
    assert!(started.is_ok(), "the computer is no longer busy");
}
/// Starts the fake engine: Docker answers again, unless `engine-broken` exists.
#[cfg(unix)]
const FAKE_ENGINE: &str = r#"import sys,pathlib
here=pathlib.Path(__file__).parent
with (here/'cua.log').open('a') as f: f.write('{"engine":"start"}\n')
if (here/'engine-broken').exists():
    print('time="2026-10-30T10:09:00+08:00" level=fatal msg="vz: the virtual machine could not start"',file=sys.stderr); sys.exit(1)
(here/'engine-down').unlink(missing_ok=True)
"#;
/// A home whose computer runs, made by a bot's first action, with a fake
/// engine Hexbot starts when Docker does not answer.
#[cfg(unix)]
async fn running_computer() -> support::TestHome {
    let h = home(json!({"tools":{"enabled_toolsets":["computer_use"]}}));
    let engine = script(h.path(), "engine-start", FAKE_ENGINE);
    let mut cfg = common::read_config(h.path()).unwrap();
    cfg["computer_use"] = json!({"engine_start":[engine]});
    common::write_config(h.path(), &cfg).unwrap();
    let cua = script(h.path(), "cua-test", FAKE_CUA);
    std::fs::write(
        h.path().join(".env"),
        format!("HEXBOT_CUA_CMD={}\n", cua.display()),
    )
    .unwrap();
    call(h.path(), "computer_use", json!({"action":"screenshot"}))
        .await
        .unwrap();
    h
}
#[cfg(unix)]
async fn computer_status(home: &Path) -> Value {
    hexbot_core::computers::call(home, "hexbot.computer.status", &json!({}))
        .await
        .unwrap()
        .unwrap()
}
/// Runs a lifecycle step, which reports by event, and waits for it to end.
#[cfg(unix)]
async fn computer_step(home: &Path, step: &str) -> Value {
    hexbot_core::computers::call(home, &format!("hexbot.computer.{step}"), &json!({}))
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let status = computer_status(home).await;
            if ![
                "starting",
                "repairing",
                "stopping",
                "restarting",
                "resetting",
            ]
            .contains(&status["state"].as_str().unwrap_or(""))
            {
                return status;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}
#[cfg(unix)]
fn cua_log(home: &Path) -> String {
    std::fs::read_to_string(home.join("cua.log")).unwrap()
}
/// The daemon's computer restarted, for an update: the engine and the
/// computer are down, and the watchdog brings both back, files and all.
#[cfg(unix)]
#[tokio::test]
async fn a_computer_lost_with_its_engine_comes_back_by_itself() {
    use hexbot_core::computers;
    let h = running_computer().await;
    let sandbox = h.path().join("sandbox.json");
    std::fs::write(
        &sandbox,
        json!({"name":computers::sandbox(h.path()),"state":"stopped","status":"stopped"})
            .to_string(),
    )
    .unwrap();
    std::fs::write(h.path().join("engine-down"), "").unwrap();
    let status = computer_status(h.path()).await;
    assert_eq!(status["state"], "error");
    assert_eq!(
        status["error"],
        "Docker is not running on the daemon's computer. Turn the computer on to start the container engine and the computer."
    );
    computers::check(h.path()).await;
    let status = computer_status(h.path()).await;
    assert_eq!(status["state"], "running");
    assert!(status["error"].is_null());
    let log = cua_log(h.path());
    assert!(log.contains(r#"{"engine":"start"}"#));
    assert!(log.contains(r#""resume""#));
    // The same computer: not made again.
    assert_eq!(log.matches(r#""create""#).count(), 1);
    assert!(!log.contains(r#""rm""#));
    // Turned off on purpose, it stays off.
    assert_eq!(computer_step(h.path(), "stop").await["state"], "stopped");
    std::fs::write(h.path().join("engine-down"), "").unwrap();
    let before = cua_log(h.path()).len();
    computers::check(h.path()).await;
    assert_eq!(cua_log(h.path()).len(), before);
}
/// The engine will not start: the primary bot tells the user once, in its
/// chat and on their devices, and Turn on repairs it once the engine can start.
#[cfg(unix)]
#[tokio::test]
async fn a_computer_that_cannot_come_back_is_reported_once() {
    use hexbot_core::{computers, events::EventHub};
    let h = running_computer().await;
    db::open(h.path())
        .unwrap()
        .execute("UPDATE bots SET is_primary=1 WHERE name='tester'", [])
        .unwrap();
    let events = EventHub::new();
    let mut heard = events.subscribe();
    computers::attach(h.path(), events);
    std::fs::write(h.path().join("engine-down"), "").unwrap();
    std::fs::write(h.path().join("engine-broken"), "").unwrap();
    computers::check(h.path()).await;
    let reason = "Docker is not running on the daemon's computer, and the container engine would not start: vz: the virtual machine could not start. Start it there, then turn the computer on.";
    assert_eq!(computer_status(h.path()).await["error"], reason);
    let notices = || {
        common::rows(
            &db::open(h.path()).unwrap(),
            "SELECT bot,text FROM heartbeat_messages WHERE heartbeat_id IS NULL",
            &[],
        )
        .unwrap()
    };
    assert_eq!(
        notices(),
        vec![
            json!({"bot":"tester","text":format!("Your bots' computer is down, and I could not bring it back. {reason}")})
        ]
    );
    let told = loop {
        let event = heard.recv().await.unwrap();
        if event.frame["params"]["type"] == "hexbot.heartbeat.message" {
            break event;
        }
    };
    assert_eq!(told.owner, "local");
    assert!(
        told.frame["params"]["payload"]["text"]
            .as_str()
            .unwrap()
            .ends_with(reason)
    );
    // Still down a minute later: no second message.
    computers::check(h.path()).await;
    assert_eq!(notices().len(), 1);
    std::fs::remove_file(h.path().join("engine-broken")).unwrap();
    let status = computer_step(h.path(), "start").await;
    assert_eq!(status["state"], "running");
    assert!(status["error"].is_null());
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(h.path().join("computer.json")).unwrap())
            .unwrap();
    assert_eq!(
        (saved["on"].clone(), saved["told"].clone()),
        (json!(true), json!(false))
    );
}
/// A repair failed, then the user starts Docker themselves: the watchdog's
/// next look clears the outage from open screens, without waiting to retry.
#[cfg(unix)]
#[tokio::test]
async fn the_watchdog_shows_a_computer_that_came_back_on_its_own() {
    use hexbot_core::{computers, events::EventHub};
    let h = running_computer().await;
    let events = EventHub::new();
    computers::attach(h.path(), events.clone());
    std::fs::write(h.path().join("engine-down"), "").unwrap();
    std::fs::write(h.path().join("engine-broken"), "").unwrap();
    computers::check(h.path()).await;
    std::fs::remove_file(h.path().join("engine-down")).unwrap();
    std::fs::remove_file(h.path().join("engine-broken")).unwrap();
    let mut changes = events.subscribe();
    computers::check(h.path()).await;
    let mut last = Value::Null;
    while let Ok(event) = changes.try_recv() {
        if event.frame["params"]["type"] == "hexbot.computer.changed" {
            last = event.frame["params"]["payload"].clone();
        }
    }
    assert_eq!(last["state"], "running");
    assert!(last["error"].is_null(), "{last}");
    assert_eq!(
        cua_log(h.path()).matches(r#"{"engine":"start"}"#).count(),
        1
    );
}
/// A computer Cua reports failed is left as it is, files and all, and the
/// primary bot says so once; with no one to tell, the outage stays untold.
#[cfg(unix)]
#[tokio::test]
async fn a_failed_computer_is_reported_once_and_never_remade_unattended() {
    use hexbot_core::{computers, events::EventHub};
    let failed = |h: &Path| {
        std::fs::write(
            h.join("sandbox.json"),
            json!({"name":computers::sandbox(h),"state":"failed","status":"failed"}).to_string(),
        )
        .unwrap()
    };
    let told = |h: &Path| {
        serde_json::from_str::<Value>(&std::fs::read_to_string(h.join("computer.json")).unwrap())
            .unwrap()["told"]
            .clone()
    };
    let h = running_computer().await;
    db::open(h.path())
        .unwrap()
        .execute("UPDATE bots SET is_primary=1 WHERE name='tester'", [])
        .unwrap();
    computers::attach(h.path(), EventHub::new());
    failed(h.path());
    let before = cua_log(h.path()).len();
    computers::check(h.path()).await;
    let log = cua_log(h.path())[before..].to_owned();
    assert!(!log.contains(r#""rm""#) && !log.contains(r#""create""#));
    let notices = common::rows(
        &db::open(h.path()).unwrap(),
        "SELECT text FROM heartbeat_messages WHERE heartbeat_id IS NULL",
        &[],
    )
    .unwrap();
    assert_eq!(
        notices,
        vec![
            json!({"text":"Your bots' computer is down, and I could not bring it back. The computer failed to start. Turn it on to make a new one."})
        ]
    );
    assert_eq!(told(h.path()), true);
    // No primary bot to say it: not marked told, so a later failure tries again.
    let quiet = running_computer().await;
    failed(quiet.path());
    computers::check(quiet.path()).await;
    assert_eq!(computer_status(quiet.path()).await["state"], "error");
    assert_ne!(told(quiet.path()), true);
}
/// Docker comes back and the computer turns out to have failed: the watchdog
/// reports it and leaves it, files and all, for the user or a bot to remake.
#[cfg(unix)]
#[tokio::test]
async fn a_computer_failed_behind_a_stopped_engine_is_remade_only_when_asked() {
    use hexbot_core::computers;
    let h = running_computer().await;
    std::fs::write(
        h.path().join("sandbox.json"),
        json!({"name":computers::sandbox(h.path()),"state":"failed","status":"failed"}).to_string(),
    )
    .unwrap();
    std::fs::write(h.path().join("engine-down"), "").unwrap();
    let events = hexbot_core::events::EventHub::new();
    computers::attach(h.path(), events.clone());
    let mut changes = events.subscribe();
    let before = cua_log(h.path()).len();
    computers::check(h.path()).await;
    let log = cua_log(h.path())[before..].to_owned();
    assert!(log.contains(r#"{"engine":"start"}"#));
    assert!(!log.contains(r#""rm""#) && !log.contains(r#""create""#));
    // Open screens show it down at once, not as it was before.
    let mut last = Value::Null;
    while let Ok(event) = changes.try_recv() {
        if event.frame["params"]["type"] == "hexbot.computer.changed" {
            last = event.frame["params"]["payload"].clone();
        }
    }
    assert_eq!(last["state"], "error", "{last}");
    assert_eq!(
        last["error"],
        "Docker is back, but the computer failed to start. Turn it on to make a new one."
    );
    // Turn on, asked for, makes a new one behind the same stopped engine.
    std::fs::write(h.path().join("engine-down"), "").unwrap();
    let before = cua_log(h.path()).len();
    let status = computer_step(h.path(), "start").await;
    assert_eq!(status["state"], "running", "{status}");
    let log = cua_log(h.path())[before..].to_owned();
    assert!(log.contains(r#"{"engine":"start"}"#));
    assert!(log.contains(r#""rm""#) && log.contains(r#""create""#));
}
/// Cua's first answer fails and only the second says the computer failed:
/// the watchdog still does not make a new one.
#[cfg(unix)]
#[tokio::test]
async fn the_watchdog_never_remakes_a_computer_found_failed_on_a_second_look() {
    use hexbot_core::computers;
    let h = running_computer().await;
    std::fs::write(
        h.path().join("sandbox.json"),
        json!({"name":computers::sandbox(h.path()),"state":"failed","status":"failed"}).to_string(),
    )
    .unwrap();
    std::fs::write(h.path().join("info-fails-once"), "").unwrap();
    let before = cua_log(h.path()).len();
    computers::check(h.path()).await;
    let log = cua_log(h.path())[before..].to_owned();
    assert!(log.matches(r#""info""#).count() >= 2);
    assert!(!log.contains(r#""rm""#) && !log.contains(r#""create""#));
    assert_eq!(
        computer_status(h.path()).await["error"],
        "The computer failed to start. Turn it on to make a new one."
    );
}
/// Turned off while the watchdog waited on Cua: it does not turn the computer
/// back on.
#[cfg(unix)]
#[tokio::test]
async fn the_watchdog_respects_a_turn_off_made_while_it_looked() {
    use hexbot_core::computers;
    let h = running_computer().await;
    std::fs::write(
        h.path().join("sandbox.json"),
        json!({"name":computers::sandbox(h.path()),"state":"stopped","status":"stopped"})
            .to_string(),
    )
    .unwrap();
    std::fs::write(h.path().join("turn-off-during-info"), "").unwrap();
    let before = cua_log(h.path()).len();
    computers::check(h.path()).await;
    assert!(!cua_log(h.path())[before..].contains(r#""resume""#));
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(h.path().join("computer.json")).unwrap())
            .unwrap();
    assert_eq!(saved["on"], false);
}
/// Docker answers but the container is gone: its files are too, so only Reset,
/// which the user chooses, makes a new computer.
#[cfg(unix)]
#[tokio::test]
async fn a_removed_container_is_not_made_again_without_reset() {
    use hexbot_core::computers;
    let h = running_computer().await;
    std::fs::write(
        h.path().join("sandbox.json"),
        json!({"name":computers::sandbox(h.path()),"state":"missing","status":"missing"})
            .to_string(),
    )
    .unwrap();
    let action = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        call(h.path(), "computer_use", json!({"action":"screenshot"})),
    )
    .await
    .expect("a removed computer fails at once instead of waiting for it");
    let removed = "The computer's container was removed. Reset makes a new computer.";
    assert_eq!(action.unwrap_err().message, removed);
    let status = computer_status(h.path()).await;
    assert_eq!(
        (status["state"].clone(), status["error"].clone()),
        (json!("error"), json!(removed))
    );
    let log = cua_log(h.path());
    assert_eq!(log.matches(r#""create""#).count(), 1);
    assert!(!log.contains(r#""rm""#) && !log.contains(r#"{"engine":"start"}"#));
    let status = computer_step(h.path(), "reset").await;
    assert_eq!(status["state"], "running");
    assert!(status["error"].is_null());
}
#[cfg(unix)]
#[tokio::test]
async fn giving_the_computer_back_closes_an_open_control_screen() {
    use axum::{
        extract::{Path as UrlPath, Request, WebSocketUpgrade, ws::Message},
        routing::{any, get},
    };
    use futures_util::{SinkExt, StreamExt};
    use hexbot_core::computers;
    let h = home(json!({"tools":{"enabled_toolsets":["computer_use"]}}));
    let cua = script(h.path(), "cua-test", FAKE_CUA);
    std::fs::write(
        h.path().join(".env"),
        format!("HEXBOT_CUA_CMD={}\n", cua.display()),
    )
    .unwrap();
    // The computer's screen: a socket that answers whatever it is sent.
    let viewer = Router::new().route(
        "/media",
        get(|ws: WebSocketUpgrade| async {
            ws.on_upgrade(|mut socket| async move {
                while let Some(Ok(Message::Text(text))) = socket.recv().await {
                    if socket.send(Message::Text(text)).await.is_err() {
                        break;
                    }
                }
            })
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream = tokio::spawn(async move { axum::serve(listener, viewer).await.unwrap() });
    std::fs::write(h.path().join("upstream.txt"), format!("http://{address}")).unwrap();
    let daemon = Router::new().route(
        "/hexbot/computer/{token}/{*rest}",
        any(
            |UrlPath((token, _)): UrlPath<(String, String)>, request: Request| {
                computers::proxy(token, request)
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let served = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, daemon).await.unwrap() });
    let view = computers::call(h.path(), "hexbot.computer.view", &json!({"control": true}))
        .await
        .unwrap()
        .unwrap();
    let location = view["path"].as_str().unwrap().split_once('#').unwrap().0;
    let media = location.strip_suffix("viewer/").unwrap();
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{served}{media}media"))
        .await
        .unwrap();
    socket.send("click".into()).await.unwrap();
    assert_eq!(
        socket.next().await.unwrap().unwrap().into_text().unwrap(),
        "click"
    );
    computers::call(
        h.path(),
        "hexbot.computer.control",
        &json!({"holder": "bot"}),
    )
    .await
    .unwrap()
    .unwrap();
    // The bots have it again, so the screen that could type is shut.
    let ended = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            match socket.next().await {
                None | Some(Err(_)) => break,
                Some(Ok(message)) if message.is_close() => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "the control screen stayed open");
    server.abort();
    upstream.abort();
}
#[cfg(unix)]
#[tokio::test]
async fn every_screen_reports_when_its_picture_is_up() {
    use axum::{
        extract::{Path as UrlPath, Request},
        routing::{any, get},
    };
    use hexbot_core::computers;
    let h = home(json!({"tools":{"enabled_toolsets":["computer_use"]}}));
    let cua = script(h.path(), "cua-test", FAKE_CUA);
    std::fs::write(
        h.path().join(".env"),
        format!("HEXBOT_CUA_CMD={}\n", cua.display()),
    )
    .unwrap();
    let viewer = Router::new().route(
        "/viewer/",
        get(|| async {
            axum::response::Html("<html><head><title>Cua viewer</title></head><body></body></html>")
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream = tokio::spawn(async move { axum::serve(listener, viewer).await.unwrap() });
    std::fs::write(h.path().join("upstream.txt"), format!("http://{address}")).unwrap();
    let daemon = Router::new().route(
        "/hexbot/computer/{token}/{*rest}",
        any(
            |UrlPath((token, _)): UrlPath<(String, String)>, request: Request| {
                computers::proxy(token, request)
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let served = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, daemon).await.unwrap() });
    let client = reqwest::Client::new();
    for control in [false, true] {
        let view = computers::call(
            h.path(),
            "hexbot.computer.view",
            &json!({"control": control}),
        )
        .await
        .unwrap()
        .unwrap();
        let page = view["path"].as_str().unwrap().split_once('#').unwrap().0;
        let html = client
            .get(format!("http://{served}{page}"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        // Watching or in control, the page says when its picture is up;
        // only a watching one hides the viewer's toolbar.
        assert!(
            html.contains(r#"<script defer src="./hexbot-screen.js"></script></head>"#),
            "{html}"
        );
        assert_eq!(html.contains("cua-toolbar"), !control, "{html}");
        let script = client
            .get(format!("http://{served}{page}hexbot-screen.js"))
            .send()
            .await
            .unwrap();
        assert_eq!(script.headers()["content-type"], "text/javascript");
        assert!(
            script
                .text()
                .await
                .unwrap()
                .contains("hexbot.computer.screen")
        );
    }
    server.abort();
    upstream.abort();
}
#[tokio::test]
async fn keenable_uses_its_vendor_contract() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let records: Requests = Default::default();
    let web_records = records.clone();
    let router=Router::new().route("/v1/search",post(move|headers:HeaderMap,Json(body):Json<Value>|{let records=web_records.clone();async move{records.lock().unwrap().push((headers,body));Json(json!({"results":[{"url":"https://example.test","title":"Keenable","snippet":"Search snippet"}]}))}})).route("/v1/fetch",axum::routing::get(||async{Json(json!({"content":"Extracted page","title":"Page"}))}));
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let h = home(json!({"tools":{"enabled_toolsets":["web"]},"web":{"backend":"keenable"}}));
    std::fs::write(
        h.path().join(".env"),
        format!("KEENABLE_API_KEY=web-secret\nKEENABLE_BASE_URL=http://{address}\n"),
    )
    .unwrap();
    let search = call(h.path(), "web_search", json!({"query":"selected backend"}))
        .await
        .unwrap();
    assert_eq!(search["data"]["web"][0]["description"], "Search snippet");
    let extracted = call(
        h.path(),
        "web_extract",
        json!({"urls":[format!("http://{address}/page")]}),
    )
    .await
    .unwrap();
    assert_eq!(extracted["results"][0]["content"], "Extracted page");
    let saved = records.lock().unwrap();
    assert_eq!(saved[0].0["x-keenable-title"], "hexbot");
    server.abort();
}
#[test]
fn missing_explicit_optional_commands_are_not_advertised() {
    let h = home(
        json!({"tools":{"enabled_toolsets":["computer_use","browser"]},"browser":{"backend":"browser-use"}}),
    );
    let mut cfg = common::read_config(h.path()).unwrap();
    let missing = h.path().join("absent-binary");
    cfg["computer_use"] = json!({"command":missing});
    cfg["browser"]["command"] = json!(missing);
    common::write_config(h.path(), &cfg).unwrap();
    let tools = native_tools::descriptors(h.path(), "tester").unwrap();
    assert!(
        !tools
            .iter()
            .any(|d| matches!(d["name"].as_str(), Some("computer_use" | "browser_exec")))
    );
}
#[cfg(unix)]
#[test]
fn tools_are_offered_only_once_set_up() {
    let h = home(json!({"tools":{"enabled_toolsets":["tts","vision"]}}));
    let mut cfg = common::read_config(h.path()).unwrap();
    cfg["tts"] = json!({"provider":"edge","edge":{"command":h.path().join("edge-tts")}});
    cfg["auxiliary"] = json!({"vision":{"provider":"custom"}});
    common::write_config(h.path(), &cfg).unwrap();
    let offered = |name: &str| {
        native_tools::descriptors(h.path(), "tester")
            .unwrap()
            .iter()
            .any(|d| d["name"] == name)
    };
    let missing = native_tools::not_set_up(h.path(), "tester").unwrap();
    assert!(missing.contains(&"tts") && missing.contains(&"vision"));
    assert!(!offered("text_to_speech") && !offered("vision_analyze"));

    script(h.path(), "edge-tts", "");
    cfg["auxiliary"]["vision"]["base_url"] = json!("http://127.0.0.1:9");
    common::write_config(h.path(), &cfg).unwrap();
    let missing = native_tools::not_set_up(h.path(), "tester").unwrap();
    assert!(!missing.contains(&"tts") && !missing.contains(&"vision"));
    assert!(offered("text_to_speech") && offered("vision_analyze"));
}
/// A computer from before Hexbot kept whether it should be on: the watchdog
/// takes a running one as on, so it comes back after the next restart, and a
/// stopped one as turned off.
#[cfg(unix)]
#[tokio::test]
async fn the_watchdog_learns_whether_a_computer_from_before_should_be_on() {
    use hexbot_core::computers;
    let h = running_computer().await;
    let saved = h.path().join("computer.json");
    let on = || {
        serde_json::from_str::<Value>(&std::fs::read_to_string(&saved).unwrap()).unwrap()["on"]
            .clone()
    };
    std::fs::write(&saved, r#"{"size":"small"}"#).unwrap();
    computers::check(h.path()).await;
    assert_eq!(on(), true);
    std::fs::write(h.path().join("engine-down"), "").unwrap();
    computers::check(h.path()).await;
    assert_eq!(computer_status(h.path()).await["state"], "running");
    // Stopped before `on` was kept: left off, and not looked at again.
    assert_eq!(computer_step(h.path(), "stop").await["state"], "stopped");
    std::fs::write(&saved, r#"{"size":"small"}"#).unwrap();
    computers::check(h.path()).await;
    assert_eq!(on(), false);
    let before = cua_log(h.path()).len();
    computers::check(h.path()).await;
    assert_eq!(cua_log(h.path()).len(), before);
}
