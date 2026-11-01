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
async fn vision_and_speech_execute_configured_http_services() {
    let requests: Requests = Default::default();
    let records = requests.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .route(
            "/chat/completions",
            post(move |headers: HeaderMap, Json(payload): Json<Value>| {
                let records = records.clone();
                async move {
                    records.lock().unwrap().push((headers, payload));
                    Json(json!({"choices":[{"message":{"content":"A red square"}}]}))
                }
            }),
        )
        .route(
            "/audio/speech",
            post(|| async { b"ID3generated-test-audio".to_vec() }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let h = home(
        json!({"tools":{"enabled_toolsets":["vision","tts"]},"auxiliary":{"vision":{"provider":"openai","model":"vision-test","base_url":format!("http://{address}")}},"tts":{"provider":"openai","openai":{"base_url":format!("http://{address}")}}}),
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
    let speech = call(h.path(), "text_to_speech", json!({"text":"Hello"}))
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(speech["file_path"].as_str().unwrap()).unwrap(),
        b"ID3generated-test-audio"
    );
    assert_eq!(requests.lock().unwrap()[0].1["model"], "vision-test");
    server.abort();
}
#[tokio::test]
async fn speech_checks_the_requested_provider_instead_of_the_default() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new().route(
        "/audio/speech",
        post(|| async { b"ID3test-audio".to_vec() }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let h = home(json!({"tools":{"enabled_toolsets":["tts"]},"tts":{
        "provider":"edge","edge":{"command": "/missing/hexbot-edge-tts"},
        "openai":{"base_url":format!("http://{address}")}
    }}));
    let audio = call(
        h.path(),
        "text_to_speech",
        json!({"text":"Hello","provider":"openai"}),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(audio["file_path"].as_str().unwrap()).unwrap(),
        b"ID3test-audio"
    );
    let mut cfg = common::read_config(h.path()).unwrap();
    cfg["tts"]["provider"] = json!("openai");
    common::write_config(h.path(), &cfg).unwrap();
    let denied = call(
        h.path(),
        "text_to_speech",
        json!({"text":"Hello","provider":"elevenlabs"}),
    )
    .await
    .unwrap_err();
    assert_eq!(denied.code, 4302);
    assert!(denied.message.contains("not set up"));
    server.abort();
}

#[tokio::test]
async fn vision_crop_and_openai_image_edit_send_actual_image_bytes() {
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
    let png_reply = png.clone();
    let edit_body: Arc<Mutex<Vec<u8>>> = Default::default();
    let saved_edit = edit_body.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router=Router::new().route("/chat/completions",post(move|headers:HeaderMap,Json(payload):Json<Value>|{let records=vision_records.clone();async move{records.lock().unwrap().push((headers,payload));Json(json!({"choices":[{"message":{"content":"Cropped image"}}]}))}})).route("/images/edits",post(move|body:axum::body::Bytes|{let saved=saved_edit.clone();let png=png_reply.clone();async move{*saved.lock().unwrap()=body.to_vec();Json(json!({"data":[{"b64_json":base64::engine::general_purpose::STANDARD.encode(png)}]}))}}));
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let h = home(
        json!({"tools":{"enabled_toolsets":["vision","image_gen"]},"auxiliary":{"vision":{"provider":"openai","base_url":format!("http://{address}")}},"image_gen":{"provider":"openai","base_url":format!("http://{address}")}}),
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
    let result = call(
        h.path(),
        "image_generate",
        json!({"prompt":"Make it blue","image_url":input}),
    )
    .await
    .unwrap();
    let saved = result["images"][0]["path"].as_str().unwrap();
    assert_eq!(std::fs::read(saved).unwrap(), png);
    let body = edit_body.lock().unwrap();
    assert!(body.windows(png.len()).any(|part| part == png));
    assert!(String::from_utf8_lossy(&body).contains("name=\"image[]\""));
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
/// answering the computer tools, and a viewer link to `upstream.txt`.
#[cfg(unix)]
const FAKE_CUA: &str = r#"import json,sys,pathlib,os,base64
here=pathlib.Path(__file__).parent
state=here/'sandbox.json'
def log(row):
    row['secret']=os.getenv('OPENAI_API_KEY'); row['telemetry']=os.getenv('CUA_TELEMETRY')
    with (here/'cua.log').open('a') as f: f.write(json.dumps(row)+'\n')
args=sys.argv[1:]
log({'argv':args})
if args[:2]==['sb','info']:
    if not state.exists(): print('cua: not found: sandbox',file=sys.stderr); sys.exit(3)
    print(state.read_text()); sys.exit(0)
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
async fn keenable_mistral_and_krea_use_selected_vendor_contracts() {
    use base64::Engine;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let generated_url = format!("http://{address}/generated.png");
    let records: Requests = Default::default();
    let web_records = records.clone();
    let speech_records = records.clone();
    let image_records = records.clone();
    let router=Router::new().route("/v1/search",post(move|headers:HeaderMap,Json(body):Json<Value>|{let records=web_records.clone();async move{records.lock().unwrap().push((headers,body));Json(json!({"results":[{"url":"https://example.test","title":"Keenable","snippet":"Search snippet"}]}))}})).route("/v1/fetch",axum::routing::get(||async{Json(json!({"content":"Extracted page","title":"Page"}))})).route("/v1/audio/speech",post(move|headers:HeaderMap,Json(body):Json<Value>|{let records=speech_records.clone();async move{records.lock().unwrap().push((headers,body));Json(json!({"audio_data":base64::engine::general_purpose::STANDARD.encode(b"ID3mistral-audio")}))}})).route("/generate/image/krea/krea-2/medium",post(move|headers:HeaderMap,Json(body):Json<Value>|{let records=image_records.clone();async move{records.lock().unwrap().push((headers,body));Json(json!({"job_id":"image-job"}))}})).route("/jobs/image-job",axum::routing::get(move||{let url=generated_url.clone();async move{Json(json!({"status":"completed","result":{"urls":[url]}}))}})).route("/generated.png",axum::routing::get(||async{b"\x89PNG\r\n\x1a\nfake-image".to_vec()}));
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let h = home(
        json!({"tools":{"enabled_toolsets":["web","tts","image_gen"]},"web":{"backend":"keenable"},"tts":{"provider":"mistral","mistral":{"base_url":format!("http://{address}")}},"image_gen":{"provider":"krea","model":"krea-2-medium"}}),
    );
    std::fs::write(h.path().join(".env"),format!("KEENABLE_API_KEY=web-secret\nKEENABLE_BASE_URL=http://{address}\nMISTRAL_API_KEY=voice-secret\nKREA_API_KEY=image-secret\nKREA_BASE_URL=http://{address}\n")).unwrap();
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
    let audio = call(h.path(), "text_to_speech", json!({"text":"Hello"}))
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(audio["file_path"].as_str().unwrap()).unwrap(),
        b"ID3mistral-audio"
    );
    let image=call(h.path(),"image_generate",json!({"prompt":"Test image","aspect_ratio":"landscape","reference_image_urls":["data:image/png;base64,aW1hZ2U="]})).await.unwrap();
    assert!(std::fs::metadata(image["images"][0]["path"].as_str().unwrap()).is_ok());
    let saved = records.lock().unwrap();
    assert_eq!(saved[0].0["x-keenable-title"], "hexbot");
    assert_eq!(saved[1].1["response_format"], "mp3");
    assert_eq!(saved[2].1["aspect_ratio"], "16:9");
    assert_eq!(saved[2].1["image_style_references"][0]["strength"], 0.6);
    server.abort();
}
#[tokio::test]
async fn fal_edits_route_to_model_edit_endpoint_and_translate_references() {
    use base64::Engine;
    let records: Requests = Default::default();
    let saved = records.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let output_url = format!("http://{address}/output.png");
    let router = Router::new()
        .route(
            "/fal-ai/flux-2/klein/9b/edit",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let saved = saved.clone();
                let url = output_url.clone();
                async move {
                    saved.lock().unwrap().push((headers, body));
                    Json(json!({"images":[{"url":url}]}))
                }
            }),
        )
        .route(
            "/output.png",
            axum::routing::get(|| async { b"\x89PNG\r\n\x1a\nimage".to_vec() }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let h =
        home(json!({"tools":{"enabled_toolsets":["image_gen"]},"image_gen":{"provider":"fal"}}));
    std::fs::write(
        h.path().join(".env"),
        format!("FAL_KEY=fal-secret\nFAL_BASE_URL=http://{address}\n"),
    )
    .unwrap();
    std::fs::create_dir_all(h.workspace()).unwrap();
    let source = h.workspace().join("source.png");
    std::fs::write(&source, b"\x89PNG\r\n\x1a\nsource").unwrap();
    call(
        h.path(),
        "image_generate",
        json!({"prompt":"Change the color","image_url":source}),
    )
    .await
    .unwrap();
    let requests = records.lock().unwrap();
    assert_eq!(requests[0].0["authorization"], "Key fal-secret");
    let body = &requests[0].1;
    assert_eq!(body["num_inference_steps"], 4);
    assert!(body.get("image_size").is_none());
    assert!(body.get("image_url").is_none());
    assert_eq!(
        body["image_urls"][0],
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nsource")
        )
    );
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
