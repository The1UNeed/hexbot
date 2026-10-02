use axum::{
    Router,
    body::{Body, Bytes},
    response::Redirect,
    routing::get,
};
use hexbot_core::{Error, http};

#[tokio::test]
async fn shared_http_limits_known_and_streamed_bodies_and_preserves_redirect_policy() {
    let router = Router::new()
        .route("/json", get(|| async { "{\"ok\":true}" }))
        .route("/redirect", get(|| async { Redirect::temporary("/json") }))
        .route(
            "/stream",
            get(|| async {
                Body::from_stream(futures_util::stream::iter([
                    Ok::<_, std::io::Error>(Bytes::from_static(b"1234")),
                    Ok(Bytes::from_static(b"5678")),
                ]))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let client = http::client(5, 0).unwrap();
    for path in ["/json", "/stream"] {
        let response = client.get(format!("{base}{path}")).send().await.unwrap();
        let error = http::bytes(
            response,
            4,
            |_| Error::new(1, "transport"),
            Error::new(2, "limit"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, 2);
    }
    let response = client.get(format!("{base}/redirect")).send().await.unwrap();
    assert!(response.status().is_redirection());
    let response = http::client(5, 5)
        .unwrap()
        .get(format!("{base}/redirect"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        http::json(
            response,
            32,
            |_| Error::new(1, "transport"),
            Error::new(2, "limit"),
            Error::new(3, "invalid")
        )
        .await
        .unwrap(),
        serde_json::json!({"ok":true})
    );
    let response = client.get(format!("{base}/stream")).send().await.unwrap();
    assert_eq!(
        http::json(
            response,
            32,
            |_| Error::new(1, "transport"),
            Error::new(2, "limit"),
            Error::new(3, "invalid")
        )
        .await
        .unwrap(),
        serde_json::json!(12345678)
    );
    server.abort();
}
