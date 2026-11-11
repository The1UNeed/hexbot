use super::*;
use axum::{Form, Json, Router, routing::post};
use std::sync::{Arc, Mutex as StdMutex};

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    origin
}

/// A daemon home whose `service` requests all go to `origin`, with the
/// user's own client saved as the connector's fields would save it.
fn home_for(service: &str, origin: &str, env: &str) -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    crate::db::migrate(home.path()).unwrap();
    std::fs::write(
        home.path().join("config.yaml"),
        format!("accounts:\n  {service}:\n    endpoint: {origin}\n"),
    )
    .unwrap();
    std::fs::write(home.path().join(".env"), env).unwrap();
    home
}

fn id_token(claims: Value) -> String {
    let part = |v: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
    format!("{}.{}.sig", part(&json!({"alg":"none"})), part(&claims))
}

type Seen = Arc<StdMutex<Vec<HashMap<String, String>>>>;

const GMAIL: &str = "gmail";
const OUTLOOK: &str = "outlook";

#[tokio::test]
async fn google_signs_in_with_pkce_through_the_loopback_return() {
    let seen: Seen = Default::default();
    let record = seen.clone();
    let origin = serve(Router::new().route(
        "/token",
        post(move |Form(form): Form<HashMap<String, String>>| {
            let record = record.clone();
            async move {
                record.lock().unwrap().push(form);
                // Google's own words for a full grant.
                Json(json!({
                    "access_token": "at-1",
                    "refresh_token": "rt-1",
                    "expires_in": 3599,
                    "scope": "https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly openid https://www.googleapis.com/auth/userinfo.email",
                    "id_token": id_token(json!({"email":"ana@example.com"})),
                }))
            }
        }),
    ))
    .await;
    let home = home_for(
        "google",
        &origin,
        "GOOGLE_OAUTH_CLIENT_ID=\"own-client\"\nGOOGLE_OAUTH_CLIENT_SECRET=\"own-secret\"\n",
    );
    let started = start(home.path(), "alice", &[GMAIL], 9119).await.unwrap();
    assert_eq!(started["mode"], "browser");
    let url = url::Url::parse(started["url"].as_str().unwrap()).unwrap();
    let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(query["client_id"], "own-client");
    assert_eq!(query["redirect_uri"], "http://127.0.0.1:9119/oauth/google");
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["access_type"], "offline");
    assert!(query["scope"].contains("gmail.compose"));

    // A test that failed before this sign-in, which the sign-in forgets.
    let tests = || -> i64 {
        crate::db::open(home.path())
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key='connector_test:gmail'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    };
    crate::db::open(home.path())
        .unwrap()
        .execute(
            "INSERT INTO settings(key,value) VALUES ('connector_test:gmail','{\"ok\":false}')",
            [],
        )
        .unwrap();
    assert_eq!(tests(), 1);

    // A return for another sign-in is refused, and the real one finishes it.
    let (ok, page) = callback(home.path(), "code=abc&state=wrong").await;
    assert!(!ok);
    assert!(page.contains("isn't waiting for this sign-in"), "{page}");
    let (ok, page) = callback(home.path(), &format!("code=abc&state={}", query["state"])).await;
    assert!(ok, "{page}");
    assert!(page.contains("Signed in as ana@example.com"));
    assert_eq!(tests(), 0);

    let sent = seen.lock().unwrap()[0].clone();
    assert_eq!(sent["grant_type"], "authorization_code");
    assert_eq!(sent["code"], "abc");
    assert_eq!(sent["client_secret"], "own-secret");
    assert_eq!(challenge(&sent["code_verifier"]), query["code_challenge"]);
    assert_eq!(sent["redirect_uri"], "http://127.0.0.1:9119/oauth/google");

    let summary = summary(home.path(), GOOGLE).unwrap().unwrap();
    assert_eq!(summary["email"], "ana@example.com");
    assert!(summary.get("refresh_token").is_none());
    assert!(connected(home.path(), GOOGLE).unwrap());
    let login = started["login_id"].as_str().unwrap();
    assert_eq!(
        poll(home.path(), "alice", login, false).unwrap()["status"],
        "done"
    );
    // Another user can't read someone's sign-in.
    assert!(poll(home.path(), "bob", login, false).is_err());
    // The grant is a credential file no bot reads.
    assert!(crate::credentials::credential_name(
        home.path(),
        &home.path().join("accounts/gmail.json")
    ));
}

#[tokio::test]
async fn a_pasted_address_finishes_google_and_a_refusal_says_so() {
    let origin = serve(Router::new().route(
        "/token",
        post(|| async {
            Json(json!({"access_token":"at","refresh_token":"rt","expires_in":3600,"id_token":id_token(json!({"email":"ana@example.com"}))}))
        }),
    ))
    .await;
    let home = home_for("google", &origin, "GOOGLE_OAUTH_CLIENT_ID=\"own\"\n");
    let started = start(home.path(), "alice", &[GMAIL], 9119).await.unwrap();
    let login = started["login_id"].as_str().unwrap();
    let state = url::Url::parse(started["url"].as_str().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let error = finish(home.path(), Some("alice"), Some(login), "not a url")
        .await
        .unwrap_err();
    assert_eq!(error.code, 4202);
    let declined = finish(
        home.path(),
        Some("alice"),
        Some(login),
        &format!("http://127.0.0.1:9119/oauth/google?error=access_denied&state={state}"),
    )
    .await
    .unwrap();
    assert_eq!(declined["status"], "error");
    assert_eq!(declined["message"], "The sign-in was declined.");

    let again = start(home.path(), "alice", &[GMAIL], 9119).await.unwrap();
    let state = url::Url::parse(again["url"].as_str().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let done = finish(
        home.path(),
        Some("alice"),
        Some(again["login_id"].as_str().unwrap()),
        &format!("http://127.0.0.1:9119/oauth/google?state={state}&code=xyz&scope=email"),
    )
    .await
    .unwrap();
    assert_eq!(done["status"], "done");
    assert_eq!(done["email"], "ana@example.com");
    assert_eq!(done["connected"], json!(["gmail"]));
}

#[tokio::test]
async fn microsoft_signs_in_with_a_device_code() {
    let polls = Arc::new(StdMutex::new(0));
    let count = polls.clone();
    let origin = serve(
        Router::new()
            .route(
                "/common/oauth2/v2.0/devicecode",
                post(|Form(form): Form<HashMap<String, String>>| async move {
                    assert_eq!(form["client_id"], "ms-client");
                    assert!(form["scope"].contains("Mail.Send"));
                    Json(json!({"device_code":"dc","user_code":"ABCD-1234","verification_uri":"https://microsoft.com/devicelogin","interval":1,"expires_in":900}))
                }),
            )
            .route(
                "/common/oauth2/v2.0/token",
                post(move |Form(form): Form<HashMap<String, String>>| {
                    let count = count.clone();
                    async move {
                        assert_eq!(form["device_code"], "dc");
                        let mut n = count.lock().unwrap();
                        *n += 1;
                        if *n == 1 {
                            (
                                axum::http::StatusCode::BAD_REQUEST,
                                Json(json!({"error":"authorization_pending"})),
                            )
                        } else {
                            (
                                axum::http::StatusCode::OK,
                                Json(json!({"access_token":"at","refresh_token":"rt","expires_in":3600,"id_token":id_token(json!({"preferred_username":"sam@contoso.com"}))})),
                            )
                        }
                    }
                }),
            ),
    )
    .await;
    let home = home_for(
        "microsoft",
        &origin,
        "MICROSOFT_OAUTH_CLIENT_ID=\"ms-client\"\n",
    );
    let started = start(home.path(), "alice", &[OUTLOOK], 9119).await.unwrap();
    assert_eq!(started["mode"], "device");
    assert_eq!(started["code"], "ABCD-1234");
    let login = started["login_id"].as_str().unwrap().to_owned();
    // The spawned poll runs too; whichever poll comes second takes the grant.
    for _ in 0..50 {
        if poll(home.path(), "alice", &login, false).unwrap()["status"] != "pending" {
            break;
        }
        let _ = poll_device(&login).await;
    }
    let done = poll(home.path(), "alice", &login, false).unwrap();
    assert_eq!(done["status"], "done", "{done}");
    assert_eq!(
        summary(home.path(), MICROSOFT).unwrap().unwrap()["email"],
        "sam@contoso.com"
    );
}

/// Declining on Google's page ends the sign-in that is waiting, and a
/// grant with a Gmail box unticked is refused rather than half working.
#[tokio::test]
async fn a_declined_or_partial_google_grant_ends_the_sign_in() {
    let origin = serve(Router::new().route(
        "/token",
        post(|| async {
            Json(json!({"access_token":"at","refresh_token":"rt","expires_in":3600,
                "scope":"openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly"}))
        }),
    ))
    .await;
    let home = home_for("google", &origin, "GOOGLE_OAUTH_CLIENT_ID=\"own\"\n");
    let state_of = |started: &Value| {
        url::Url::parse(started["url"].as_str().unwrap())
            .unwrap()
            .query_pairs()
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .into_owned()
    };
    let started = start(home.path(), "alice", &[GMAIL], 9119).await.unwrap();
    let login = started["login_id"].as_str().unwrap();
    let (ok, page) = callback(
        home.path(),
        &format!("error=access_denied&state={}", state_of(&started)),
    )
    .await;
    assert!(!ok);
    assert!(page.contains("declined"), "{page}");
    let polled = poll(home.path(), "alice", login, false).unwrap();
    assert_eq!(polled["status"], "error");
    assert_eq!(polled["message"], "The sign-in was declined.");

    let started = start(home.path(), "alice", &[GMAIL], 9119).await.unwrap();
    let (ok, page) = callback(home.path(), &format!("code=c&state={}", state_of(&started))).await;
    assert!(!ok);
    assert!(page.contains("leave every box ticked"), "{page}");
    assert!(!connected(home.path(), GOOGLE).unwrap());
}

/// Signing out ends a sign-in still waiting, so finishing it later doesn't
/// sign the user back in.
#[tokio::test]
async fn signing_out_ends_a_sign_in_still_waiting() {
    let home = home_for(
        "google",
        "http://127.0.0.1:9",
        "GOOGLE_OAUTH_CLIENT_ID=\"own\"\n",
    );
    let started = start(home.path(), "alice", &[GMAIL], 9119).await.unwrap();
    let state = url::Url::parse(started["url"].as_str().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    disconnect(home.path(), service(GOOGLE).unwrap())
        .await
        .unwrap();
    let (ok, _) = callback(home.path(), &format!("code=c&state={state}")).await;
    assert!(!ok);
    assert!(!connected(home.path(), GOOGLE).unwrap());
    let login = started["login_id"].as_str().unwrap();
    assert_eq!(
        poll(home.path(), "alice", login, false).unwrap()["status"],
        "cancelled"
    );
}

/// Signing out while a token renews keeps the user signed out.
#[tokio::test]
async fn a_sign_out_during_a_refresh_stays_signed_out() {
    let home = tempfile::tempdir().unwrap();
    crate::db::migrate(home.path()).unwrap();
    let file = home.path().join("accounts/outlook.json");
    let gone = file.clone();
    let origin = serve(Router::new().route(
        "/common/oauth2/v2.0/token",
        post(move || {
            let gone = gone.clone();
            async move {
                // The user signs out while Microsoft answers.
                std::fs::remove_file(&gone).unwrap();
                Json(json!({"access_token":"fresh","expires_in":3600,"refresh_token":"rt-2"}))
            }
        }),
    ))
    .await;
    std::fs::write(
        home.path().join("config.yaml"),
        format!("accounts:\n  microsoft:\n    endpoint: {origin}\n"),
    )
    .unwrap();
    let svc = service(MICROSOFT).unwrap();
    write(
        home.path(),
        svc,
        &json!({"email":"sam@contoso.com","client_id":"ms","access_token":"old","refresh_token":"rt-1","expires_at":0,"connected_at":1.0}),
    )
    .unwrap();
    assert_eq!(access_token(home.path(), svc).await.unwrap_err().code, 4210);
    assert!(!file.exists());
}

#[tokio::test]
async fn tokens_refresh_and_a_revoked_grant_asks_for_sign_in_again() {
    let answer = Arc::new(StdMutex::new(
        json!({"access_token":"fresh","expires_in":3600,"refresh_token":"rt-2"}),
    ));
    let next = answer.clone();
    let origin = serve(Router::new().route(
        "/common/oauth2/v2.0/token",
        post(move |Form(form): Form<HashMap<String, String>>| {
            let next = next.clone();
            async move {
                assert_eq!(form["grant_type"], "refresh_token");
                let body = next.lock().unwrap().clone();
                if body["error"].is_string() {
                    (axum::http::StatusCode::BAD_REQUEST, Json(body))
                } else {
                    assert_eq!(form["refresh_token"], "rt-1");
                    (axum::http::StatusCode::OK, Json(body))
                }
            }
        }),
    ))
    .await;
    let home = home_for("microsoft", &origin, "");
    let svc = service(MICROSOFT).unwrap();
    write(
        home.path(),
        svc,
        &json!({"email":"sam@contoso.com","client_id":"ms","access_token":"old","refresh_token":"rt-1","expires_at":common::now() + 30.0}),
    )
    .unwrap();
    // Under a minute left: refreshed, with Microsoft's new refresh token kept.
    assert_eq!(access_token(home.path(), svc).await.unwrap(), "fresh");
    assert_eq!(
        read(home.path(), svc).unwrap().unwrap()["refresh_token"],
        "rt-2"
    );
    assert_eq!(access_token(home.path(), svc).await.unwrap(), "fresh");

    let mut stale = read(home.path(), svc).unwrap().unwrap();
    stale["expires_at"] = json!(0);
    stale["refresh_token"] = json!("rt-1");
    write(home.path(), svc, &stale).unwrap();
    *answer.lock().unwrap() = json!({"error":"invalid_grant"});
    let error = access_token(home.path(), svc).await.unwrap_err();
    assert_eq!(error.code, 4210);
    assert!(error.message.contains("Sign in again"), "{}", error.message);
    assert!(!connected(home.path(), MICROSOFT).unwrap());
    assert_eq!(
        summary(home.path(), MICROSOFT).unwrap().unwrap()["expired"],
        true
    );

    // A token for another grant than the one asked for is refused.
    let mut fresh = read(home.path(), svc).unwrap().unwrap();
    fresh["expired"] = json!(false);
    fresh["connected_at"] = json!(2.0);
    write(home.path(), svc, &fresh).unwrap();
    let error = access_token_for(home.path(), svc, Some(&json!(1.0)))
        .await
        .unwrap_err();
    assert!(
        error.message.contains("another account"),
        "{}",
        error.message
    );

    disconnect(home.path(), svc).await.unwrap();
    assert!(summary(home.path(), MICROSOFT).unwrap().is_none());
}

#[tokio::test]
async fn without_a_client_sign_in_says_what_to_add() {
    let home = tempfile::tempdir().unwrap();
    crate::db::migrate(home.path()).unwrap();
    for id in [GOOGLE, MICROSOFT] {
        let svc = service(id).unwrap();
        if svc.provider.built_in.is_some_and(|c| !c.is_empty()) {
            continue;
        }
        let error = start(home.path(), "alice", &[id], 9119).await.unwrap_err();
        assert_eq!(error.code, 4210);
        assert!(error.message.contains("own OAuth client ID"));
    }
}

#[test]
fn endpoint_overrides_stay_on_https_or_loopback() {
    let home = tempfile::tempdir().unwrap();
    crate::db::migrate(home.path()).unwrap();
    let svc = service(GOOGLE).unwrap();
    assert_eq!(
        url_at(home.path(), svc, svc.api, "/x").unwrap(),
        "https://gmail.googleapis.com/x"
    );
    std::fs::write(
        home.path().join("config.yaml"),
        "accounts:\n  google:\n    endpoint: http://evil.example\n",
    )
    .unwrap();
    assert_eq!(
        url_at(home.path(), svc, svc.api, "/x").unwrap_err().code,
        4211
    );
}

fn query_of(started: &Value) -> HashMap<String, String> {
    url::Url::parse(started["url"].as_str().unwrap())
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect()
}

/// One sign-in may connect several of an account's connectors. Each gets a
/// grant of its own, and one whose box the user unticked is left out.
#[tokio::test]
async fn one_sign_in_connects_several_connectors_and_leaves_out_an_unticked_one() {
    let origin = serve(Router::new().route(
        "/token",
        post(|| async {
            // Everything asked for but Drive's read permission.
            Json(json!({"access_token":"at","refresh_token":"rt","expires_in":3600,
                "scope":"openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.file",
                "id_token": id_token(json!({"email":"ana@example.com"}))}))
        }),
    ))
    .await;
    let home = home_for("google", &origin, "GOOGLE_OAUTH_CLIENT_ID=\"own\"\n");
    let h = home.path();
    let started = start(
        h,
        "alice",
        &[GMAIL, "google_calendar", "google_drive", GMAIL],
        9119,
    )
    .await
    .unwrap();
    assert_eq!(
        started["services"],
        json!(["gmail", "google_calendar", "google_drive"])
    );
    assert_eq!(started["provider"], "google");
    let query = query_of(&started);
    // Every permission once, and no account to offer yet.
    let scopes = query["scope"].split(' ').collect::<Vec<_>>();
    for scope in [
        "openid",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/drive.readonly",
    ] {
        assert_eq!(scopes.iter().filter(|s| **s == scope).count(), 1, "{scope}");
    }
    assert!(!query.contains_key("login_hint"));
    let (ok, page) = callback(h, &format!("code=c&state={}", query["state"])).await;
    assert!(ok, "{page}");
    let done = poll(h, "alice", started["login_id"].as_str().unwrap(), false).unwrap();
    assert_eq!(done["connected"], json!(["gmail", "google_calendar"]));
    assert_eq!(done["skipped"], json!(["google_drive"]));
    assert_eq!(
        done["message"],
        "Connected Gmail and Google Calendar. Google didn't allow Google Drive: connect it again and leave every box ticked."
    );
    assert!(connected(h, "gmail").unwrap() && connected(h, "google_calendar").unwrap());
    assert!(!connected(h, "google_drive").unwrap());
    // Each grant names its own permissions, whatever the sign-in covered.
    let calendar = read(h, service("google_calendar").unwrap())
        .unwrap()
        .unwrap();
    assert!(
        calendar["scope"]
            .as_str()
            .unwrap()
            .contains("calendar.events")
    );
    assert!(!calendar["scope"].as_str().unwrap().contains("gmail"));
    // The next sign-in offers the account that is already there.
    let next = start(h, "alice", &["google_drive"], 9119).await.unwrap();
    assert_eq!(query_of(&next)["login_hint"], "ana@example.com");
    assert!(!query_of(&next)["scope"].contains("gmail"));
    // A sign-in covers one account, and only connectors that sign in.
    assert_eq!(
        start(h, "alice", &[GMAIL, OUTLOOK], 9119)
            .await
            .unwrap_err()
            .code,
        4202
    );
    assert_eq!(
        start(h, "alice", &["notion"], 9119).await.unwrap_err().code,
        4202
    );
    assert_eq!(start(h, "alice", &[], 9119).await.unwrap_err().code, 4200);
}

/// Disconnecting one connector leaves the others of its account working:
/// Google ends every grant an account gave at once, so its grant is revoked
/// there only with the account's last connector.
#[tokio::test]
async fn google_is_told_to_revoke_only_with_an_accounts_last_connector() {
    let revoked: Seen = Default::default();
    let record = revoked.clone();
    let origin = serve(Router::new().route(
        "/revoke",
        post(move |Form(form): Form<HashMap<String, String>>| {
            let record = record.clone();
            async move {
                record.lock().unwrap().push(form);
                Json(json!({}))
            }
        }),
    ))
    .await;
    let home = home_for("google", &origin, "");
    let h = home.path();
    let grant = |email: &str, token: &str| json!({"email":email,"client_id":"c","access_token":"t","refresh_token":token,"expires_at":common::now() + 3600.0,"connected_at":1.0});
    write(
        h,
        service("gmail").unwrap(),
        &grant("ana@example.com", "rt-ana"),
    )
    .unwrap();
    write(
        h,
        service("google_calendar").unwrap(),
        &grant("Ana@Example.com", "rt-ana"),
    )
    .unwrap();
    write(
        h,
        service("google_tasks").unwrap(),
        &grant("work@example.com", "rt-work"),
    )
    .unwrap();

    disconnect(h, service("gmail").unwrap()).await.unwrap();
    assert!(!connected(h, "gmail").unwrap() && connected(h, "google_calendar").unwrap());
    assert!(revoked.lock().unwrap().is_empty());
    // Another account's connector is that account's last.
    disconnect(h, service("google_tasks").unwrap())
        .await
        .unwrap();
    assert_eq!(revoked.lock().unwrap()[0]["token"], "rt-work");
    disconnect(h, service("google_calendar").unwrap())
        .await
        .unwrap();
    assert_eq!(revoked.lock().unwrap()[1]["token"], "rt-ana");
    assert_eq!(revoked.lock().unwrap().len(), 2);
}

/// A Microsoft token is renewed for its connector's own permissions, so a
/// connector connected with others still can't reach theirs.
#[tokio::test]
async fn a_renewed_microsoft_token_is_narrowed_to_its_connector() {
    let seen: Seen = Default::default();
    let record = seen.clone();
    let origin = serve(Router::new().route(
        "/common/oauth2/v2.0/token",
        post(move |Form(form): Form<HashMap<String, String>>| {
            let record = record.clone();
            async move {
                record.lock().unwrap().push(form);
                Json(json!({"access_token":"fresh","expires_in":3600}))
            }
        }),
    ))
    .await;
    let home = home_for("microsoft", &origin, "");
    let svc = service("outlook_calendar").unwrap();
    write(
        home.path(),
        svc,
        &json!({"email":"sam@contoso.com","client_id":"ms","access_token":"old","refresh_token":"rt","expires_at":0}),
    )
    .unwrap();
    assert_eq!(access_token(home.path(), svc).await.unwrap(), "fresh");
    let scope = seen.lock().unwrap()[0]["scope"].clone();
    assert!(
        scope.contains("Calendars.ReadWrite") && scope.contains("offline_access"),
        "{scope}"
    );
    assert!(!scope.contains("Mail."), "{scope}");
}

#[test]
fn a_token_goes_only_to_its_providers_own_hosts() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    let (gmail, word) = (service("gmail").unwrap(), service("word").unwrap());
    assert!(trusted(
        h,
        gmail,
        "https://gmail.googleapis.com/gmail/v1/users/me/profile"
    ));
    assert!(trusted(
        h,
        gmail,
        "https://www.googleapis.com/upload/drive/v3/files?upload_id=x"
    ));
    assert!(trusted(
        h,
        word,
        "https://graph.microsoft.com/v1.0/me/drive"
    ));
    for url in [
        "https://evil.example/googleapis.com",
        "https://googleapis.com.evil.example/x",
        // A host of Google's that serves anyone's files.
        "https://storage.googleapis.com/someones-bucket/x",
        "http://www.googleapis.com/x",
        "https://graph.microsoft.com/x",
        "not a url",
    ] {
        assert!(!trusted(h, gmail, url), "{url}");
    }
    assert!(!trusted(
        h,
        word,
        "https://contoso.sharepoint.com/download?tempauth=x"
    ));
    // With an endpoint standing in, that address alone, port and all.
    std::fs::write(
        h.join("config.yaml"),
        "accounts:\n  google:\n    endpoint: http://127.0.0.1:4010\n",
    )
    .unwrap();
    assert!(trusted(h, gmail, "http://127.0.0.1:4010/upload?x=1"));
    assert!(!trusted(h, gmail, "http://127.0.0.1:40100/upload"));
    assert!(!trusted(h, gmail, "https://www.googleapis.com/x"));
}

#[test]
fn every_account_connector_in_the_catalog_has_a_service_and_the_reverse() {
    let catalog = crate::connectors::catalog();
    let with_accounts = catalog
        .iter()
        .filter(|c| c["account"].is_string())
        .collect::<Vec<_>>();
    assert_eq!(with_accounts.len(), SERVICES.len());
    for entry in with_accounts {
        let svc = service(entry["id"].as_str().unwrap()).unwrap();
        assert_eq!(entry["account"], svc.provider.id, "{}", svc.id);
        assert_eq!(entry["family"], svc.provider.id);
        assert_eq!(entry["name"], svc.name);
        assert_eq!(entry["toolsets"], json!([svc.id]));
    }
    // The names an account's one connector once had still find its mail.
    assert_eq!(service(GOOGLE).unwrap().id, "gmail");
    assert_eq!(service(MICROSOFT).unwrap().id, "outlook");
    assert!(service("google_workspace").is_err_and(|e| e.code == 4202));
}
