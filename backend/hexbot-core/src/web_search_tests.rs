//! Web search and page reading without a key: the free services, the
//! fallback while SearXNG cannot run here, and the built-in reader.
use super::*;
use axum::{Router, http::StatusCode, response::IntoResponse, routing::get};
use std::collections::BTreeMap;

/// A local server for one test; returns its origin.
async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (origin, server)
}
fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

#[test]
fn snippets_lose_tags_and_entities() {
    assert_eq!(
        html_text(
            "<span class=\"searchmatch\">Rust</span> &lt;3 &#39;fast&#x27;&nbsp;and&amp;safe"
        ),
        "Rust <3 'fast' and&safe"
    );
    assert_eq!(decode_entities("&unknown; &#xZZ;"), "&unknown; &#xZZ;");
}

#[test]
fn a_page_reads_as_its_article_without_menus() {
    let html = r#"<!doctype html><html><head><title>Rust &amp; You</title>
<style>body{color:red}</style><script>track()</script></head>
<body><nav><a href="/">Home</a> <a href="/about">About</a></nav>
<main class="content"><h1>Ownership</h1><p>Each value has an <a href="/owner">owner</a>.</p>


<p>Second.</p><form><input name="q"></form></main>
<footer>Copyright</footer></body></html>"#;
    let (title, markdown) = page_markdown(html);
    assert_eq!(title, "Rust & You");
    assert!(markdown.starts_with("# Ownership"), "{markdown}");
    assert!(markdown.contains("[owner](/owner)"), "{markdown}");
    for gone in ["Home", "About", "Copyright", "track()", "color:red"] {
        assert!(!markdown.contains(gone), "{gone} in {markdown}");
    }
    assert!(!markdown.contains("\n\n\n"), "{markdown}");
    // A page without <main> or <article> keeps its whole body.
    let (_, plain) = page_markdown("<body><p>Just text</p><mainframe>x</mainframe></body>");
    assert_eq!(plain, "Just text\n\nx");
}

#[test]
fn search_defaults_to_searxng_and_pages_to_the_built_in_reader() {
    let none = BTreeMap::new();
    assert_eq!(web_backend(&json!({}), &none, false), "searxng");
    assert_eq!(web_backend(&json!({}), &none, true), "builtin");
    for free in ["wikipedia", "marginalia", "searxng", "brave"] {
        let cfg = json!({"web":{"backend":free}});
        assert_eq!(web_backend(&cfg, &none, false), free);
        assert_eq!(web_backend(&cfg, &none, true), "builtin", "{free}");
    }
    // A saved key still wins, for search and for pages.
    let exa = env(&[("EXA_API_KEY", "k")]);
    assert_eq!(web_backend(&json!({}), &exa, false), "exa");
    assert_eq!(
        web_backend(&json!({"web":{"backend":"wikipedia"}}), &exa, true),
        "exa"
    );
    // Tavily without a key reads pages itself, as before.
    assert_eq!(
        web_backend(&json!({"web":{"backend":"tavily"}}), &none, true),
        "tavily"
    );
}

#[tokio::test]
async fn without_searxng_search_falls_back_to_tavily_then_wikipedia() {
    let home = tempfile::tempdir().unwrap();
    let (origin, server) = serve(
        Router::new()
            .route(
                "/search",
                axum::routing::post(|| async { StatusCode::TOO_MANY_REQUESTS }),
            )
            .route(
                "/w/api.php",
                get(|| async {
                    axum::Json(
                        json!({"query":{"search":[{"title":"Rust","snippet":"A language"}]}}),
                    )
                }),
            ),
    )
    .await;
    let env = env(&[("TAVILY_BASE_URL", &origin), ("WIKIPEDIA_URL", &origin)]);
    // SearXNG is the default, and a test home never runs Docker.
    let result = search(home.path(), &json!({}), &env, &json!({"query":"rust"}))
        .await
        .unwrap();
    assert_eq!(
        result["data"]["web"][0]["url"],
        format!("{origin}/wiki/Rust")
    );
    assert_eq!(result["data"]["web"][0]["position"], 1);
    server.abort();
}

#[tokio::test]
async fn wikipedia_and_marginalia_answer_without_a_key() {
    let home = tempfile::tempdir().unwrap();
    let (origin, server) = serve(
        Router::new()
            .route(
                "/w/api.php",
                get(|headers: axum::http::HeaderMap| async move {
                    // Wikimedia asks every client to say what it is.
                    assert!(headers["user-agent"].to_str().unwrap().starts_with("Hexbot/"));
                    axum::Json(json!({"query":{"search":[{"title":"Rust (programming language)","snippet":"<span class=\"searchmatch\">Rust</span> is fast"}]}}))
                }),
            )
            .route(
                "/search",
                get(|headers: axum::http::HeaderMap| async move {
                    if headers["api-key"] == "public" {
                        (StatusCode::SERVICE_UNAVAILABLE, "QPM Limit Exceeded").into_response()
                    } else {
                        axum::Json(json!({"results":[{"url":"https://small.example/","title":"Small","description":"A small site"}]}))
                            .into_response()
                    }
                }),
            ),
    )
    .await;
    let wiki = search(
        home.path(),
        &json!({"web":{"backend":"wikipedia"}}),
        &env(&[("WIKIPEDIA_URL", &origin)]),
        &json!({"query":"rust"}),
    )
    .await
    .unwrap();
    assert_eq!(
        wiki["data"]["web"][0],
        json!({"title":"Rust (programming language)","url":format!("{origin}/wiki/Rust_%28programming_language%29"),"description":"Rust is fast","position":1})
    );
    let marginalia = json!({"web":{"backend":"marginalia"}});
    let busy = search(
        home.path(),
        &marginalia,
        &env(&[("MARGINALIA_URL", &origin)]),
        &json!({"query":"rust"}),
    )
    .await
    .unwrap_err();
    assert!(
        busy.message.contains("shared key is busy"),
        "{}",
        busy.message
    );
    let own = search(
        home.path(),
        &marginalia,
        &env(&[("MARGINALIA_URL", &origin), ("MARGINALIA_API_KEY", "mine")]),
        &json!({"query":"rust"}),
    )
    .await
    .unwrap();
    assert_eq!(own["data"]["web"][0]["url"], "https://small.example/");
    server.abort();
}

#[tokio::test]
async fn a_searxng_without_json_says_how_to_turn_it_on() {
    let home = tempfile::tempdir().unwrap();
    let (origin, server) =
        serve(Router::new().route("/search", get(|| async { StatusCode::FORBIDDEN }))).await;
    let error = search(
        home.path(),
        &json!({"web":{"backend":"searxng"}}),
        &env(&[("SEARXNG_URL", &origin)]),
        &json!({"query":"rust"}),
    )
    .await
    .unwrap_err();
    assert!(
        error.message.contains("search.formats"),
        "{}",
        error.message
    );
    server.abort();
}

#[tokio::test]
async fn the_built_in_reader_reads_pages_and_refuses_files() {
    let (origin, server) = serve(
        Router::new()
            .route(
                "/page",
                get(|headers: axum::http::HeaderMap| async move {
                    assert!(headers["user-agent"].to_str().unwrap().contains("Hexbot/"));
                    axum::response::Html(
                        "<title>Hello</title><article><h2>Hi</h2><p>There</p></article>",
                    )
                }),
            )
            .route("/notes.txt", get(|| async { "plain words" }))
            .route(
                "/photo.png",
                get(|| async { ([("content-type", "image/png")], vec![0u8, 1, 2]) }),
            )
            .route("/gone", get(|| async { StatusCode::NOT_FOUND })),
    )
    .await;
    let read = |path: &str| {
        let url = format!("{origin}{path}");
        async move { read_page(common::safe_get(&url, true).await.unwrap()).await }
    };
    let page = read("/page").await;
    assert_eq!(page["title"], "Hello");
    assert_eq!(page["content"], "## Hi\n\nThere");
    assert_eq!(read("/notes.txt").await["content"], "plain words");
    assert_eq!(
        read("/photo.png").await["error"],
        "This is image/png, not a web page."
    );
    assert_eq!(read("/gone").await["error"], "The page answered HTTP 404.");
    server.abort();
}

#[tokio::test]
async fn web_extract_uses_the_built_in_reader_by_default() {
    let home = super::safety_tests::fixture();
    common::write_config(
        home.path(),
        &json!({"security":{"allow_private_urls":true}}),
    )
    .unwrap();
    let (origin, server) = serve(Router::new().route(
        "/",
        get(|| async { axum::response::Html("<main><p>Read here</p></main>") }),
    ))
    .await;
    let result = extract(
        home.path(),
        "owl",
        &json!({}),
        &Default::default(),
        &json!({"urls":[format!("{origin}/")]}),
    )
    .await
    .unwrap();
    assert_eq!(result["results"][0]["content"], "Read here", "{result}");
    server.abort();
}

/// Against real Docker: `cargo test -- --ignored real_searxng --nocapture`.
/// Starts this home's SearXNG, searches through it, then removes it.
#[tokio::test]
#[ignore = "needs Docker and the network"]
async fn real_searxng_starts_in_docker_and_searches() {
    let home = tempfile::tempdir().unwrap();
    common::write_config(home.path(), &json!({"web":{"searxng":{"docker":"docker"}}})).unwrap();
    assert!(crate::searxng::wanted(home.path()));
    let docker = native_tools_on_path("docker");
    let run = |args: &[&str]| {
        let out = std::process::Command::new(&docker)
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    };
    // A container this computer left behind for a home that is gone.
    let host = format!(
        "app.hexbot.host={}",
        crate::osutil::hostname().unwrap_or_default()
    );
    run(&[
        "create",
        "--name",
        "hexbot-searxng-left-behind",
        "--label",
        "app.hexbot.searxng=1",
        "--label",
        "app.hexbot.home=/nowhere/.hexbot",
        "--label",
        &host,
        crate::searxng::IMAGE,
    ]);
    let started = std::time::Instant::now();
    let url = crate::searxng::ensure(home.path()).await.unwrap();
    println!("SearXNG answered at {url} after {:?}", started.elapsed());
    let left = run(&[
        "ps",
        "--all",
        "--quiet",
        "--filter",
        "name=hexbot-searxng-left-behind",
    ]);
    println!("left-behind container after the sweep: {:?}", left);
    assert!(left.is_empty());
    let result = search(
        home.path(),
        &json!({}),
        &Default::default(),
        &json!({"query":"rust programming language","limit":3}),
    )
    .await
    .unwrap();
    for row in result["data"]["web"].as_array().unwrap() {
        println!(
            "  {}. {} — {}",
            row["position"],
            row["title"].as_str().unwrap(),
            row["url"].as_str().unwrap()
        );
    }
    assert_eq!(result["data"]["web"].as_array().unwrap().len(), 3);
    let name = crate::searxng::container(home.path());
    let ports = run(&[
        "inspect",
        "--format",
        "{{json .HostConfig.PortBindings}}",
        &name,
    ]);
    println!("{name} ports: {ports}");
    assert!(ports.contains("\"HostIp\":\"127.0.0.1\""));
    crate::searxng::stop(home.path()).await;
    let state = run(&["inspect", "--format", "{{.State.Status}}", &name]);
    println!("{name} after the daemon stops: {state}");
    assert_eq!(state, "exited");
    run(&["rm", "-f", &name]);
}
fn native_tools_on_path(name: &str) -> PathBuf {
    on_path(name).expect("on PATH")
}

/// Against the real services: `cargo test -- --ignored real_free --nocapture`.
#[tokio::test]
#[ignore = "needs the network"]
async fn real_free_providers_answer() {
    let home = tempfile::tempdir().unwrap();
    for backend in ["tavily", "wikipedia", "marginalia"] {
        let cfg = json!({"web":{"backend":backend}});
        match search(
            home.path(),
            &cfg,
            &Default::default(),
            &json!({"query":"rust programming language","limit":3}),
        )
        .await
        {
            Ok(result) => {
                let rows = result["data"]["web"].as_array().unwrap();
                println!(
                    "{backend}: {} results, first {}",
                    rows.len(),
                    rows.first().map_or("-", |r| r["url"].as_str().unwrap())
                );
            }
            Err(e) => println!("{backend}: {}", e.message),
        }
    }
    let page = read_page(
        common::safe_get("https://www.rust-lang.org/", false)
            .await
            .unwrap(),
    )
    .await;
    let content = page["content"].as_str().unwrap();
    println!(
        "built-in reader: {:?}, {} chars, starts {:?}",
        page["title"],
        content.chars().count(),
        content.chars().take(120).collect::<String>()
    );
    assert!(!content.is_empty());
}

/// Against real Docker: `cargo test -- --ignored real_shutdown --nocapture`.
/// Once the daemon is stopping, a start that reaches `docker start` does not
/// run it, so nothing it started outlives the daemon.
#[tokio::test]
#[ignore = "needs Docker"]
async fn real_shutdown_stops_a_later_start_from_launching() {
    let home = tempfile::tempdir().unwrap();
    common::write_config(home.path(), &json!({"web":{"searxng":{"docker":"docker"}}})).unwrap();
    crate::searxng::stop(home.path()).await;
    let started = crate::searxng::ensure(home.path()).await;
    println!(
        "start after shutdown: {:?}",
        started.as_ref().map_err(|e| &e.message)
    );
    assert_eq!(started.unwrap_err().message, "Hexbot is stopping");
    let docker = native_tools_on_path("docker");
    let name = crate::searxng::container(home.path());
    let state = std::process::Command::new(&docker)
        .args(["inspect", "--format", "{{.State.Status}}", &name])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&state.stdout).trim().to_owned();
    println!("{name} after a start during shutdown: {state:?}");
    std::process::Command::new(&docker)
        .args(["rm", "-f", &name])
        .output()
        .unwrap();
    assert_ne!(state, "running");
}
