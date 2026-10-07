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
async fn persistent_python_state_errors_reset_and_authorization() {
    let h = home(json!({"tools":{"enabled_toolsets":["code_execution"]}}));
    assert_eq!(
        call(
            h.path(),
            "execute_code",
            json!({"code":"answer=40\nprint(answer)"})
        )
        .await
        .unwrap()["output"],
        "40\n"
    );
    assert_eq!(
        call(
            h.path(),
            "execute_code",
            json!({"code":"answer+=2\nprint(answer)"})
        )
        .await
        .unwrap()["output"],
        "42\n"
    );
    let failure = call(
        h.path(),
        "execute_code",
        json!({"code":"raise ValueError('expected failure')"}),
    )
    .await
    .unwrap();
    assert_eq!(failure["success"], false);
    assert!(
        failure["stderr"]
            .as_str()
            .unwrap()
            .contains("expected failure")
    );
    assert_eq!(
        call(
            h.path(),
            "execute_code",
            json!({"code":"print('answer' in globals())","reset":true})
        )
        .await
        .unwrap()["output"],
        "False\n"
    );
    assert_eq!(
        call(h.path(), "web_search", json!({"query":"unused"}))
            .await
            .unwrap_err()
            .code,
        4302
    );
    assert_eq!(
        native_tools::call(
            h.path(),
            "stranger",
            "tester",
            "conversation",
            "execute_code",
            &json!({"code":"print('not allowed')"})
        )
        .await
        .unwrap_err()
        .code,
        4302
    );
    native_tools::close_session(h.path(), "conversation").await;
}
#[tokio::test]
async fn python_timeout_resets_worker_and_output_is_bounded() {
    let h = home(
        json!({"tools":{"enabled_toolsets":["code_execution"]},"code_execution":{"timeout":1}}),
    );
    assert!(
        call(h.path(), "execute_code", json!({"code":"while True: pass"}))
            .await
            .unwrap_err()
            .message
            .contains("timed out")
    );
    let result = call(
        h.path(),
        "execute_code",
        json!({"code":"print('x'*500000)"}),
    )
    .await
    .unwrap();
    assert!(result["output"].as_str().unwrap().len() < 101000);
    assert_eq!(
        std::fs::read_to_string(result["output_path"].as_str().unwrap())
            .unwrap()
            .len(),
        500001
    );
    native_tools::close_session(h.path(), "conversation").await;
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
async fn cdp_attaches_to_target_and_routes_response() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let message = socket.next().await.unwrap().unwrap();
        let attach: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        assert_eq!(attach["method"], "Target.attachToTarget");
        assert_eq!(attach["params"]["targetId"], "tab-id");
        socket
            .send(Message::Text(
                json!({"id":attach["id"],"result":{"sessionId":"session-id"}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let message = socket.next().await.unwrap().unwrap();
        let command: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        assert_eq!(command["sessionId"], "session-id");
        assert_eq!(command["method"], "Page.getLayoutMetrics");
        socket
            .send(Message::Text(
                json!({"method":"Page.frameNavigated","params":{}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                json!({"id":command["id"],"result":{"result":{"value":42}}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
    });
    let h = home(
        json!({"tools":{"enabled_toolsets":["browser"]},"browser":{"cdp_url":format!("ws://{address}")}}),
    );
    assert!(
        native_tools::descriptors(h.path(), "tester")
            .unwrap()
            .iter()
            .any(|t| t["name"] == "browser_cdp")
    );
    let result = call(
        h.path(),
        "browser_cdp",
        json!({"method":"Page.getLayoutMetrics","params":{},"target_id":"tab-id"}),
    )
    .await
    .unwrap();
    assert_eq!(result["result"]["value"], 42);
    server.await.unwrap();
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
async fn python_hermes_tools_calls_conversation_dispatcher_and_propagates_denial() {
    let h = home(json!({"tools":{"enabled_toolsets":["code_execution"]}}));
    let requests = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
    let recorded = requests.clone();
    native_tools::register_dispatcher(
        h.path(),
        "conversation",
        Arc::new(move |name, args| {
            let recorded = recorded.clone();
            Box::pin(async move {
                recorded.lock().unwrap().push((name.clone(), args.clone()));
                if name == "web_search" {
                    Ok(json!({"results":[args["query"].clone()]}))
                } else {
                    Err(hexbot_core::Error::new(4302, "tool denied"))
                }
            })
        }),
    );
    let result=call(h.path(),"execute_code",json!({"code":"from hermes_tools import web_search\nresult=web_search('meaning of life')\nprint(result['results'][0])"})).await.unwrap();
    assert_eq!(result["output"], "meaning of life\n");
    assert_eq!(requests.lock().unwrap()[0].0, "web_search");
    let denied = call(
        h.path(),
        "execute_code",
        json!({"code":"from hermes_tools import forbidden\nforbidden()"}),
    )
    .await
    .unwrap();
    assert_eq!(denied["success"], false);
    assert!(denied["stderr"].as_str().unwrap().contains("tool denied"));
    native_tools::close_session(h.path(), "conversation").await;
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
#[cfg(unix)]
#[tokio::test]
async fn cloud_browser_creates_uses_and_releases_session() {
    let requests: Requests = Default::default();
    let created = requests.clone();
    let released = requests.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .route(
            "/v1/sessions",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let recorded = created.clone();
                async move {
                    recorded.lock().unwrap().push((headers, body));
                    Json(
                        json!({"id":"remote-browser","connectUrl":"wss://browser.invalid/session"}),
                    )
                }
            }),
        )
        .route(
            "/v1/sessions/remote-browser",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let recorded = released.clone();
                async move {
                    recorded.lock().unwrap().push((headers, body));
                    Json(json!({"ok":true}))
                }
            }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let h = home(
        json!({"tools":{"enabled_toolsets":["browser"]},"browser":{"cloud_provider":"browserbase"}}),
    );
    let cli = script(
        h.path(),
        "agent-browser-test",
        r#"import json,sys,pathlib
with pathlib.Path(__file__).with_suffix('.log').open('a') as f: f.write(json.dumps(sys.argv[1:])+'\n')
print(json.dumps({'success':True,'data':{'snapshot':'[e1] Button','refs':{'e1':'Button'}}}))
"#,
    );
    let mut config = common::read_config(h.path()).unwrap();
    config["browser"]["command"] = json!(cli);
    common::write_config(h.path(), &config).unwrap();
    std::fs::write(h.path().join(".env"),format!("BROWSERBASE_API_KEY=browser-key\nBROWSERBASE_PROJECT_ID=project\nBROWSERBASE_BASE_URL=http://{address}\n")).unwrap();
    assert!(
        call(
            h.path(),
            "browser_navigate",
            json!({"url":format!("http://{address}/")})
        )
        .await
        .is_err()
    );
    let result = call(h.path(), "browser_snapshot", json!({})).await.unwrap();
    assert_eq!(result["data"]["snapshot"], "[e1] Button");
    assert_eq!(
        call(h.path(), "browser_click", json!({"ref":"e1"}))
            .await
            .unwrap_err()
            .code,
        4302
    );
    native_tools::close_session(h.path(), "conversation").await;
    let saved = requests.lock().unwrap();
    assert_eq!(saved.len(), 2);
    assert_eq!(saved[0].0["x-bb-api-key"], "browser-key");
    assert_eq!(saved[0].1["projectId"], "project");
    assert_eq!(saved[1].1["status"], "REQUEST_RELEASE");
    let log = std::fs::read_to_string(cli.with_extension("log")).unwrap_or_default();
    assert!(log.contains("wss://browser.invalid/session"));
    server.abort();
}
#[cfg(unix)]
#[tokio::test]
async fn computer_actions_use_captured_window_and_snapshot_token() {
    let h = home(json!({"tools":{"enabled_toolsets":["computer_use"]}}));
    let driver = script(
        h.path(),
        "cua-driver-test",
        r#"import json,sys,pathlib,os
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r: continue
 method=r.get('method')
 if method=='initialize': result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'cua-test','version':'1'}}
 elif method=='tools/list': result={'tools':[{'name':n,'inputSchema':{'type':'object','properties':{}},'description':n} for n in ['start_session','end_session','list_windows','get_window_state','click']]}
 elif method=='tools/call':
  name=r['params']['name'];args=r['params'].get('arguments',{})
  with pathlib.Path(__file__).with_suffix('.log').open('a') as f: f.write(json.dumps({'name':name,'args':args,'secret':os.getenv('OPENAI_API_KEY')})+'\n')
  data={}
  if name=='list_windows': data={'windows':[{'pid':42,'window_id':7,'app_name':'Test App','z_index':1,'is_on_screen':True}]}
  elif name=='get_window_state': data={'elements':[{'element_index':1,'element_token':'snapshot-1:1','role':'button','label':'Run'}]}
  elif name=='click': data={'ok':True,'verdict':'confirmed'}
  result={'structuredContent':data,'content':[{'type':'text','text':json.dumps(data)}]}
 else: result={}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}),flush=True)
"#,
    );
    let mut cfg = common::read_config(h.path()).unwrap();
    cfg["computer_use"] = json!({"args":[]});
    std::fs::write(
        h.path().join(".env"),
        format!(
            "HEXBOT_CUA_DRIVER_CMD={}\nHERMES_CUA_DRIVER_CMD=/nonexistent\n",
            driver.display()
        ),
    )
    .unwrap();
    common::write_config(h.path(), &cfg).unwrap();
    assert!(
        native_tools::descriptors(h.path(), "tester")
            .unwrap()
            .iter()
            .any(|d| d["name"] == "computer_use")
    );
    std::fs::write(
        h.path().join(".env"),
        format!("OPENAI_API_KEY=must-not-reach-driver\nHEXBOT_CUA_DRIVER_CMD={}\nHERMES_CUA_DRIVER_CMD=/nonexistent\n", driver.display()),
    )
    .unwrap();
    assert!(
        call(
            h.path(),
            "computer_use",
            json!({"action":"click","element":1})
        )
        .await
        .unwrap_err()
        .message
        .contains("capture first")
    );
    call(
        h.path(),
        "computer_use",
        json!({"action":"capture","app":"Test App"}),
    )
    .await
    .unwrap();
    let result = call(
        h.path(),
        "computer_use",
        json!({"action":"click","element":1}),
    )
    .await
    .unwrap();
    assert_eq!(result["structuredContent"]["verdict"], "confirmed");
    let lines = std::fs::read_to_string(driver.with_extension("log")).unwrap();
    let rows = lines
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(rows.iter().all(|row| row["secret"].is_null()));
    let click = rows.iter().find(|row| row["name"] == "click").unwrap();
    assert_eq!(click["args"]["pid"], 42);
    assert_eq!(click["args"]["window_id"], 7);
    assert_eq!(click["args"]["element_token"], "snapshot-1:1");
    native_tools::close_session(h.path(), "conversation").await;
    hexbot_core::connectors::close_bot(h.path(), "tester").await;
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
async fn closing_conversation_interrupts_running_kernel() {
    let h = home(
        json!({"tools":{"enabled_toolsets":["code_execution"]},"code_execution":{"timeout":120}}),
    );
    let started = Arc::new(tokio::sync::Notify::new());
    let signal = started.clone();
    native_tools::register_dispatcher(
        h.path(),
        "conversation",
        Arc::new(move |_, _| {
            let signal = signal.clone();
            Box::pin(async move {
                signal.notify_one();
                Ok(json!({"ok":true}))
            })
        }),
    );
    let path = h.path().to_owned();
    let task = tokio::spawn(async move {
        call(
            &path,
            "execute_code",
            json!({"code":"from hermes_tools import ready\nready()\nwhile True: pass"}),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        native_tools::close_session(h.path(), "conversation"),
    )
    .await
    .unwrap();
    assert_eq!(task.await.unwrap().unwrap_err().code, 5201);
    assert_eq!(
        call(
            h.path(),
            "execute_code",
            json!({"code":"print('recovered')"})
        )
        .await
        .unwrap()["output"],
        "recovered\n"
    );
    native_tools::close_session(h.path(), "conversation").await;
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
#[cfg(unix)]
#[tokio::test]
async fn browser_use_backend_is_not_set_up() {
    let h =
        home(json!({"tools":{"enabled_toolsets":["browser"]},"browser":{"backend":"browser-use"}}));
    std::fs::create_dir_all(h.path().join("bin")).unwrap();
    script(
        &h.path().join("bin"),
        "uvx",
        "import sys,json,os\nprint(json.dumps({'args':sys.argv[1:],'code':sys.stdin.read(),'session':os.environ['BU_NAME']}))",
    );
    // browser_exec needs network interception that was never ported, so the
    // browser-use backend leaves the browser toolset without a working tool.
    assert!(
        !native_tools::descriptors(h.path(), "tester")
            .unwrap()
            .iter()
            .any(|d| d["name"] == "browser_exec")
    );
    assert!(
        native_tools::not_set_up(h.path(), "tester")
            .unwrap()
            .contains(&"browser")
    );
    let error = call(h.path(), "browser_exec", json!({"code":"print('test')"}))
        .await
        .unwrap_err();
    assert_eq!(error.code, 4302);
    assert!(error.message.contains("not set up"));
    native_tools::close_session(h.path(), "conversation").await;
}
