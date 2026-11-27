use super::*;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

/// A home with the daemon's own computer and a paired laptop.
fn home() -> (tempfile::TempDir, String, String) {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    let token = auth::local_token(home.path()).unwrap();
    let local = auth::verify_token(home.path(), &token).unwrap().unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let code = auth::new_code(home.path(), "local").unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned();
    let laptop = auth::redeem_code_from(home.path(), &code, "Laptop", "browser", "test", None)
        .unwrap()["device_id"]
        .as_str()
        .unwrap()
        .to_owned();
    (home, local, laptop)
}
fn app(app_id: &str, version: &str) -> Value {
    json!({"app_id":app_id,"version":version,"edition":"client","platform":"darwin",
        "track":"stable","hosts_daemon":false,"updater":{"status":"up-to-date"},"request":null})
}
fn reporter(
    home: &Path,
    device: &str,
    connection: u64,
    report_value: Value,
) -> UnboundedReceiver<Value> {
    let (sender, receiver) = unbounded_channel();
    report(home, "local", device, connection, sender, &report_value).unwrap();
    receiver
}

#[test]
fn each_app_reports_on_its_own_connection_and_leaves_with_it() {
    let (home, local, laptop) = home();
    let home = home.path();
    let _a = reporter(home, &local, 1001, app("app.hexbot.desktop", "0.1.5"));
    // A Stable and a Nightly app on one computer are two apps.
    let _b = reporter(
        home,
        &local,
        1002,
        app("app.hexbot.desktop.nightly", "0.1.6-nightly.20261127.1"),
    );
    let _c = reporter(home, &laptop, 1003, app("app.hexbot.client", "0.1.4"));
    let listed = list(home, "local", 1003).unwrap();
    let apps = listed["apps"].as_array().unwrap();
    assert_eq!(apps.len(), 3);
    let laptop_app = apps
        .iter()
        .find(|a| a["device"] == laptop.as_str())
        .unwrap();
    assert_eq!(laptop_app["label"], "Laptop");
    assert_eq!(laptop_app["current"], true);
    // The daemon's own computer goes by its name, not "This computer".
    let own = apps
        .iter()
        .find(|a| a["app_id"] == "app.hexbot.desktop")
        .unwrap();
    assert_eq!(own["label"], auth::daemon_name());
    assert_eq!(own["current"], false);
    // A reconnect replaces the old connection; the old one closing leaves it.
    let _c2 = reporter(home, &laptop, 1004, app("app.hexbot.client", "0.1.4"));
    detach(home, 1003);
    assert_eq!(
        list(home, "local", 0).unwrap()["apps"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    detach(home, 1004);
    assert_eq!(
        list(home, "local", 0).unwrap()["apps"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn an_app_that_never_reports_is_listed_as_older() {
    let (home, _local, laptop) = home();
    let home = home.path();
    connected(home, "local", &laptop, 2001);
    let listed = list(home, "local", 0).unwrap();
    assert_eq!(
        listed["older"],
        json!([{"device": laptop, "label": "Laptop"}])
    );
    let _a = reporter(home, &laptop, 2001, app("app.hexbot.client", "0.1.5"));
    assert_eq!(list(home, "local", 0).unwrap()["older"], json!([]));
    detach(home, 2001);
}

#[test]
fn a_request_reaches_only_that_app_and_only_from_its_owner() {
    let (home, local, laptop) = home();
    let home = home.path();
    let mut own = reporter(home, &local, 3001, app("app.hexbot.desktop", "0.1.5"));
    let mut other = reporter(home, &laptop, 3002, app("app.hexbot.client", "0.1.5"));
    update(
        home,
        "local",
        &json!({"device":laptop,"app_id":"app.hexbot.client","action":"prepare","request_id":"r1","version":"0.1.6","track":"stable"}),
    )
    .unwrap();
    let frame = other.try_recv().unwrap();
    assert_eq!(frame["params"]["type"], "hexbot.apps.update_requested");
    assert_eq!(
        frame["params"]["payload"],
        json!({"action":"prepare","request_id":"r1","version":"0.1.6","track":"stable"})
    );
    assert!(own.try_recv().is_err());
    let send = |p: Value| update(home, "local", &p).unwrap_err().code;
    assert_eq!(
        send(
            json!({"device":laptop,"app_id":"app.hexbot.other","action":"commit","request_id":"r1"})
        ),
        4404
    );
    assert_eq!(
        send(
            json!({"device":"nobody","app_id":"app.hexbot.client","action":"commit","request_id":"r1"})
        ),
        4302
    );
    assert_eq!(
        send(
            json!({"device":laptop,"app_id":"app.hexbot.client","action":"install","request_id":"r1"})
        ),
        4200
    );
    assert_eq!(
        send(
            json!({"device":laptop,"app_id":"app.hexbot.client","action":"commit","request_id":"../x"})
        ),
        4200
    );
    detach(home, 3001);
    detach(home, 3002);
}

#[test]
fn an_app_can_say_only_what_a_report_holds() {
    let (home, local, _laptop) = home();
    let (sender, _receiver) = unbounded_channel();
    let mut bad = app("app/../x", "0.1.5");
    assert_eq!(
        report(home.path(), "local", &local, 4001, sender.clone(), &bad)
            .unwrap_err()
            .code,
        4200
    );
    bad = app("app.hexbot.desktop", "0.1.5");
    bad["request"] = json!({"id":"r1","state":"exploded"});
    assert!(report(home.path(), "local", &local, 4001, sender.clone(), &bad).is_err());
    let mut good = app("app.hexbot.desktop", "0.1.5");
    good["extra"] = json!("ignored");
    good["request"] = json!({"id":"r1","state":"ready","downloaded_version":"0.1.6"});
    good["updater"]["percent"] = json!(250);
    report(home.path(), "local", &local, 4001, sender, &good).unwrap();
    let listed = list(home.path(), "local", 0).unwrap();
    let reported = &listed["apps"][0];
    assert!(reported.get("extra").is_none());
    assert_eq!(reported["request"]["state"], "ready");
    assert_eq!(reported["updater"]["percent"], 100.0);
    detach(home.path(), 4001);
}

#[test]
fn one_run_at_a_time_and_the_same_run_may_claim_again() {
    let (home, local, laptop) = home();
    let home = home.path();
    let claim = |device: &str, run_id: &str, action: &str| {
        run(
            home,
            "local",
            device,
            &json!({"run_id":run_id,"action":action}),
        )
    };
    claim(&local, "run-a", "begin").unwrap();
    assert_eq!(claim(&laptop, "run-b", "begin").unwrap_err().code, 4409);
    // After the daemon restarts, the driver claims its run again.
    claim(&local, "run-a", "begin").unwrap();
    assert_eq!(list(home, "local", 0).unwrap()["run"]["run_id"], "run-a");
    // Ending someone else's run does nothing.
    claim(&laptop, "run-b", "end").unwrap();
    assert_eq!(claim(&laptop, "run-b", "begin").unwrap_err().code, 4409);
    claim(&local, "run-a", "end").unwrap();
    claim(&laptop, "run-b", "begin").unwrap();
    // An expired claim no longer blocks anyone.
    let mut stale = read_run(home).unwrap().unwrap();
    stale["expires_at"] = json!(common::now() - 1.0);
    std::fs::write(home.join(RUN), stale.to_string()).unwrap();
    assert!(list(home, "local", 0).unwrap()["run"].is_null());
    claim(&local, "run-c", "begin").unwrap();
}
