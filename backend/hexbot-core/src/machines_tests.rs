use super::*;
use std::fs;

fn setup() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    db::open(home.path())
        .unwrap()
        .execute_batch(
            "INSERT INTO users(id,display_name,role,created_at) VALUES ('alice','Alice','admin',0);
         INSERT INTO bots(name,owner_id) VALUES ('owl','alice'),('fox','alice');
         INSERT INTO devices(id,name,platform,token_hash,owner_id,created_at) VALUES
           ('mac','MacBook','desktop','h1','alice',0),
           ('here','This computer','local','h2','alice',0);",
        )
        .unwrap();
    for bot in ["owl", "fox"] {
        fs::create_dir_all(home.path().join("profiles").join(bot)).unwrap();
    }
    // The fox has no terminal toolset; the owl has the defaults.
    fs::write(
        home.path().join("profiles/fox/config.yaml"),
        "tools:\n  enabled_toolsets: [file, web]\n",
    )
    .unwrap();
    home
}

#[test]
fn a_daemon_from_before_computers_keeps_what_its_bots_had() {
    let home = setup();
    let h = home.path();
    // Every bot had the bots' computer's desktop; the terminal toolset gave
    // this computer's terminal.
    assert!(has(h, "owl", VM, DESKTOP).unwrap());
    assert!(has(h, "owl", HOST, TERMINAL).unwrap());
    assert!(!has(h, "owl", VM, TERMINAL).unwrap());
    assert!(has(h, "fox", VM, DESKTOP).unwrap());
    assert!(!has(h, "fox", HOST, TERMINAL).unwrap());
    let owl = crate::connectors::toolsets(h, "owl").unwrap();
    assert!(owl.contains(&"terminal".to_owned()) && owl.contains(&"computer_use".to_owned()));
    let fox = crate::connectors::toolsets(h, "fox").unwrap();
    assert!(!fox.contains(&"terminal".to_owned()) && fox.contains(&"computer_use".to_owned()));
    // Writing it down changes nothing a bot has.
    migrate(h).unwrap();
    assert_eq!(
        common::read_config(h).unwrap()["computers"],
        // New bots keep what the daemon gave them: its default toolsets
        // include the terminal.
        json!({"vm":{"terminal":[],"desktop":["fox","owl"]},"host":{"terminal":["owl"],"desktop":[]},"defaults":{"host_terminal":true}})
    );
    assert_eq!(crate::connectors::toolsets(h, "owl").unwrap(), owl);
    assert_eq!(crate::connectors::toolsets(h, "fox").unwrap(), fox);
    // Running it again keeps later changes.
    set(h, VM, TERMINAL, "fox", true).unwrap();
    migrate(h).unwrap();
    assert!(has(h, "fox", VM, TERMINAL).unwrap());
}

#[test]
fn grants_decide_the_terminal_and_computer_use_tools_both_ways() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, VM, DESKTOP, "fox", false).unwrap();
    assert!(
        !crate::connectors::toolsets(h, "fox")
            .unwrap()
            .contains(&"computer_use".to_owned())
    );
    set(h, VM, TERMINAL, "fox", true).unwrap();
    assert!(
        crate::connectors::toolsets(h, "fox")
            .unwrap()
            .contains(&"terminal".to_owned())
    );
    set(h, VM, TERMINAL, "fox", false).unwrap();
    assert!(
        !crate::connectors::toolsets(h, "fox")
            .unwrap()
            .contains(&"terminal".to_owned())
    );
    // Turning the bots' computer off takes it from every bot until it is back.
    common::update_config(h, |c| {
        c["computers"]["vm"]["off"] = json!(true);
        Ok(())
    })
    .unwrap();
    assert!(!has(h, "owl", VM, DESKTOP).unwrap());
    assert!(!any(h, "owl", DESKTOP).unwrap());
    common::update_config(h, |c| {
        c["computers"]["vm"]["off"] = json!(false);
        Ok(())
    })
    .unwrap();
    assert!(has(h, "owl", VM, DESKTOP).unwrap());
    assert!(set(h, "elsewhere", TERMINAL, "owl", true).is_err());
    assert!(set(h, VM, "printer", "owl", true).is_err());
}

#[test]
fn the_tool_switches_give_and_take_computers() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    // Cua is there, whatever the machine running the test has.
    let cua = h.join("cua");
    std::fs::write(&cua, "#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(&cua, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    common::update_config(h, |c| {
        c["computer_use"]["command"] = json!(cua.to_string_lossy());
        Ok(())
    })
    .unwrap();
    sync_tools(h, "owl", false, false, true).unwrap();
    assert!(granted(h, "owl").unwrap().is_empty());
    // On again: the default computer for each, the bots' computer first.
    sync_tools(h, "owl", true, true, true).unwrap();
    assert!(has(h, "owl", VM, TERMINAL).unwrap());
    assert!(has(h, "owl", VM, DESKTOP).unwrap());
    // Already on: nothing moves.
    set(h, HOST, TERMINAL, "owl", true).unwrap();
    set(h, VM, TERMINAL, "owl", false).unwrap();
    sync_tools(h, "owl", true, true, true).unwrap();
    assert!(has(h, "owl", HOST, TERMINAL).unwrap());
    assert!(!has(h, "owl", VM, TERMINAL).unwrap());
}

#[test]
fn a_deleted_bot_leaves_every_computer_and_its_apps() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    allow_app(h, "device:mac", "owl", "s1", "Safari", true).unwrap();
    allow_app(h, "device:mac", "owl", "s1", "Notes", false).unwrap();
    forget_bot(h, "owl").unwrap();
    assert!(granted(h, "owl").unwrap().is_empty());
    assert!(always_apps(h, "device:mac", "owl").unwrap().is_empty());
    assert!(!app_allowed(h, "device:mac", "owl", "s1", "Notes").unwrap());
}

#[test]
fn sections_freeze_their_computers_and_the_prompt_names_them() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, VM, TERMINAL, "owl", true).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    // A revoked or unknown device is left out.
    set(h, "device:gone", DESKTOP, "owl", true).unwrap();
    let list = session_list(h, "alice", "owl").unwrap();
    let ids = list
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids, ["vm", "host", "device:mac"]);
    assert_eq!(list[2]["name"], "MacBook");
    assert_eq!(default_for(&list, TERMINAL).as_deref(), Some("vm"));
    assert_eq!(default_for(&list, DESKTOP).as_deref(), Some("vm"));
    let prompt = prompt_block(&list);
    assert!(prompt.contains("# Computers"));
    assert!(prompt.contains("Without it, bash runs on vm and computer_use acts on vm."));
    assert!(prompt.contains("- device:mac: MacBook"));
    assert!(prompt.contains("desktop"));
    // Nothing to say without computers.
    assert_eq!(prompt_block(&json!([])), "");
}

#[test]
fn a_click_reaches_every_app_with_a_window_under_it() {
    let windows = vec![
        json!({"app":"Notes","focused":false,"position":[0.0,0.0],"size":[500.0,500.0],"state":"normal"}),
        json!({"app":"Safari","focused":true,"position":[400.0,0.0],"size":[500.0,500.0],"state":"normal"}),
        json!({"app":"Mail","focused":false,"position":[0.0,600.0],"size":[300.0,300.0],"state":"minimized"}),
    ];
    // Cua doesn't say which window is in front, so an overlap reaches both.
    assert_eq!(apps_at(&windows, Some((450., 100.))), ["Notes", "Safari"]);
    assert_eq!(apps_at(&windows, Some((100., 100.))), ["Notes"]);
    // A minimized window takes no click, and nothing else is there: unknown.
    assert!(apps_at(&windows, Some((100., 700.))).is_empty());
    // Without a point, keys go to the focused window.
    assert_eq!(apps_at(&windows, None), ["Safari"]);
    assert!(apps_at(&[], None).is_empty());
}

#[test]
fn editors_and_ides_never_take_input() {
    for app in [
        "Code",
        "Visual Studio Code",
        "Cursor",
        "Zed",
        "Xcode",
        "IntelliJ IDEA",
        "PyCharm CE",
        "Android Studio",
    ] {
        assert!(blocked_app(app).is_some(), "{app}");
    }
    for app in ["Notes", "Safari", "Figma", "Mail"] {
        assert!(blocked_app(app).is_none(), "{app}");
    }
}

#[test]
fn terminals_and_hexbot_never_take_input_and_browsers_warn() {
    for app in [
        "Terminal",
        "iTerm2",
        "Ghostty",
        "Windows Terminal",
        "Hexbot",
        "Hexbot Nightly",
        "powershell",
    ] {
        assert!(blocked_app(app).is_some(), "{app}");
    }
    for app in ["Safari", "Notes", "Figma"] {
        assert!(blocked_app(app).is_none(), "{app}");
    }
    assert!(app_warning("Google Chrome").is_some());
    assert!(app_warning("Finder").is_some());
    assert!(app_warning("Notes").is_none());
}

#[test]
fn allowed_apps_last_for_the_conversation_or_always() {
    let home = setup();
    let h = home.path();
    allow_app(h, HOST, "owl", "s1", "Notes", false).unwrap();
    assert!(app_allowed(h, HOST, "owl", "s1", "notes").unwrap());
    assert!(!app_allowed(h, HOST, "owl", "s2", "Notes").unwrap());
    assert!(!app_allowed(h, HOST, "fox", "s1", "Notes").unwrap());
    allow_app(h, HOST, "owl", "s1", "Safari", true).unwrap();
    allow_app(h, HOST, "owl", "s1", "safari", true).unwrap();
    assert_eq!(always_apps(h, HOST, "owl").unwrap(), ["Safari"]);
    assert!(app_allowed(h, HOST, "owl", "s9", "Safari").unwrap());
    remove_app(h, HOST, "owl", "SAFARI").unwrap();
    assert!(!app_allowed(h, HOST, "owl", "s9", "Safari").unwrap());
    remove_app(h, HOST, "owl", "Notes").unwrap();
    assert!(!app_allowed(h, HOST, "owl", "s1", "Notes").unwrap());
}

#[tokio::test]
async fn desktop_checks_refuse_what_is_not_granted_or_set_up() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    let click = json!({"action":"click","coordinate":[1,2]});
    // The bots' computer needs no app check.
    assert!(matches!(
        check_desktop(h, "alice", "owl", "s1", VM, "smart", &click)
            .await
            .unwrap(),
        Needs::Nothing
    ));
    // Not granted.
    let err = check_desktop(h, "alice", "owl", "s1", HOST, "smart", &click)
        .await
        .err()
        .unwrap();
    assert!(err.message.contains("can't use the desktop of host"));
    // Granted, but this computer's desktop is not shared.
    set(h, HOST, DESKTOP, "owl", true).unwrap();
    let err = check_desktop(h, "alice", "owl", "s1", HOST, "smart", &click)
        .await
        .err()
        .unwrap();
    assert!(err.message.contains("not set up for bots"));
    // shell is refused on a user's computer, before anything reaches it.
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    let shell = json!({"action":"shell","command":"ls"});
    let err = check_desktop(h, "alice", "owl", "s1", "device:mac", "off", &shell)
        .await
        .err()
        .unwrap();
    assert!(err.message.contains("Use bash"));
    // Looking needs no app.
    assert!(matches!(
        check_desktop(
            h,
            "alice",
            "owl",
            "s1",
            "device:mac",
            "smart",
            &json!({"action":"screenshot"})
        )
        .await
        .unwrap(),
        Needs::Nothing
    ));
    // Launching names its app: a terminal is refused in every mode, another app asks.
    let err = check_desktop(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        "off",
        &json!({"action":"launch","app":"Terminal"}),
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("Terminal apps"));
    match check_desktop(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        "smart",
        &json!({"action":"launch","app":"Safari"}),
    )
    .await
    .unwrap()
    {
        Needs::App {
            app,
            command,
            reason,
        } => {
            assert_eq!(app, "Safari");
            assert_eq!(command, "Use Safari on MacBook");
            assert!(reason.contains("signed in to your accounts"));
        }
        Needs::Nothing => panic!("Safari should ask"),
    }
    // Bypass asks for no app.
    assert!(matches!(
        check_desktop(
            h,
            "alice",
            "owl",
            "s1",
            "device:mac",
            "off",
            &json!({"action":"launch","app":"Safari"})
        )
        .await
        .unwrap(),
        Needs::Nothing
    ));
}

#[tokio::test]
async fn a_user_computer_attaches_answers_and_goes_offline() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", TERMINAL, "owl", true).unwrap();
    // Offline: the tool says so.
    let err = terminal(h, "alice", "owl", "device:mac", "ls", None, || Ok(()))
        .await
        .err()
        .unwrap();
    assert!(err.message.contains("offline"));
    // The daemon's own app can't attach as a user's computer.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    assert!(attach(h, "alice", "here", 1, tx.clone(), &json!({"terminal":true})).is_err());
    let connection = connection_id();
    attach(
        h,
        "alice",
        "mac",
        connection,
        tx,
        &json!({"terminal":true,"desktop":false,"os":"macOS","name":"mac"}),
    )
    .unwrap();
    let listed = list(h, "alice").await.unwrap();
    let mac = listed["computers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "device:mac")
        .unwrap()
        .clone();
    assert_eq!(mac["online"], true);
    assert_eq!(mac["os"], "macOS");
    assert_eq!(mac["terminal"]["bots"], json!(["owl"]));
    // A command goes to that connection; its answer comes back.
    let home2 = h.to_owned();
    let run = tokio::spawn(async move {
        terminal(
            &home2,
            "alice",
            "owl",
            "device:mac",
            "ls ~",
            Some(5),
            || Ok(()),
        )
        .await
    });
    let frame = rx.recv().await.unwrap();
    assert_eq!(frame["params"]["type"], "hexbot.computers.request");
    let payload = &frame["params"]["payload"];
    assert_eq!(payload["kind"], "terminal");
    assert_eq!(payload["command"], "ls ~");
    let id = payload["request_id"].as_str().unwrap().to_owned();
    // Another device can't answer it.
    assert!(reply(h, "other", &json!({"request_id":id})).is_err());
    reply(
        h,
        "mac",
        &json!({"request_id":id,"result":{"output":"Documents\n","exit_code":0}}),
    )
    .unwrap();
    let result = run.await.unwrap().unwrap();
    assert_eq!(result["output"], "Documents\n");
    // The desktop was not allowed on that computer.
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    let err = act(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        || Ok("smart".into()),
        &json!({"action":"screenshot"}),
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("does not let bots use its desktop"));
    // Closing the connection fails what still waits and takes it offline.
    let home3 = h.to_owned();
    let waiting = tokio::spawn(async move {
        terminal(
            &home3,
            "alice",
            "owl",
            "device:mac",
            "sleep 9",
            Some(30),
            || Ok(()),
        )
        .await
    });
    rx.recv().await.unwrap();
    detach(h, "mac", connection + 1000);
    detach(h, "mac", connection);
    let err = waiting.await.unwrap().err().unwrap();
    assert!(err.message.contains("offline"));
    let listed = list(h, "alice").await.unwrap();
    let mac = listed["computers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "device:mac")
        .unwrap()
        .clone();
    assert_eq!(mac["online"], false);
    // Its grants stay, so the user can still manage them.
    assert_eq!(mac["terminal"]["bots"], json!(["owl"]));
}

#[test]
fn command_output_keeps_its_end_and_says_how_it_ended() {
    let long = "x".repeat(OUTPUT_CAP + 10) + "END";
    let result = command_result(long, 0, false, 5);
    let text = result["output"].as_str().unwrap();
    assert!(text.starts_with("[earlier output cut]"));
    assert!(text.ends_with("END"));
    assert!(
        command_result("".into(), 2, false, 5)["output"]
            .as_str()
            .unwrap()
            .contains("[exit code 2]")
    );
    assert!(
        command_result("".into(), 124, true, 5)["output"]
            .as_str()
            .unwrap()
            .contains("Stopped after 5 s")
    );
}

#[test]
fn new_bots_get_the_bots_computer_or_this_computers_terminal() {
    let home = setup();
    let h = home.path();
    // Before computers are kept, nothing is written.
    new_bot(h, "owl").unwrap();
    assert!(configured(h).unwrap().is_none());
    migrate(h).unwrap();
    // Cua is missing here, so a new bot gets this computer's terminal.
    common::update_config(h, |c| {
        c["computer_use"]["command"] = json!("/nonexistent/cua");
        Ok(())
    })
    .unwrap();
    db::open(h)
        .unwrap()
        .execute(
            "INSERT INTO bots(name,owner_id) VALUES ('newt','alice')",
            [],
        )
        .unwrap();
    new_bot(h, "newt").unwrap();
    assert!(has(h, "newt", HOST, TERMINAL).unwrap());
    assert!(!has(h, "newt", VM, TERMINAL).unwrap());
}

#[test]
fn setup_saying_no_to_this_computer_holds_without_the_bots_computer() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    common::update_config(h, |c| {
        c["computer_use"]["command"] = json!("/nonexistent/cua");
        c["computers"]["defaults"] = json!({"host_terminal": false, "host_desktop": false});
        Ok(())
    })
    .unwrap();
    db::open(h)
        .unwrap()
        .execute(
            "INSERT INTO bots(name,owner_id) VALUES ('newt','alice')",
            [],
        )
        .unwrap();
    new_bot(h, "newt").unwrap();
    assert!(granted(h, "newt").unwrap().is_empty());
}

/// A user's computer that answers like Cua: its window list is whatever the
/// test sets, and every other action succeeds and is recorded.
fn fake_mac(
    h: &Path,
    windows: std::sync::Arc<Mutex<Value>>,
) -> (u64, std::sync::Arc<Mutex<Vec<String>>>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let connection = connection_id();
    attach(
        h,
        "alice",
        "mac",
        connection,
        tx,
        &json!({"terminal":true,"desktop":true,"os":"macOS"}),
    )
    .unwrap();
    let done = std::sync::Arc::new(Mutex::new(vec![]));
    let (home, seen) = (h.to_owned(), done.clone());
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let payload = &frame["params"]["payload"];
            let id = payload["request_id"].as_str().unwrap().to_owned();
            let tool = payload["tool"].as_str().unwrap_or("").to_owned();
            // Looking at the screen's size warms the session: not an action.
            let result = if tool == "computer_get_screen_size" {
                json!({"content":[{"type":"text","text":"{\"width\":1200}"}]})
            } else if tool == "computer_window_list" {
                let text = json!({"windows": windows.lock().unwrap().clone()}).to_string();
                json!({"content":[{"type":"text","text":text}]})
            } else {
                seen.lock().unwrap().push(tool.clone());
                json!({"content":[{"type":"text","text":"ok"}]})
            };
            reply(&home, "mac", &json!({"request_id":id,"result":result})).unwrap();
        }
    });
    (connection, done)
}

/// As if the bot had just taken a screenshot of `computer` this wide, on a
/// screen 1200 points wide (what the fake computer reports).
fn shot(home: &Path, computer: &str, width: f64) {
    shot_on(home, computer, width, 1200.);
}
fn shot_on(home: &Path, computer: &str, width: f64, points: f64) {
    SHOTS.get_or_init(Default::default).lock().unwrap().insert(
        (home.to_owned(), computer.to_owned()),
        (width, (points, 0.)),
    );
}
fn window(app: &str, focused: bool, x: f64) -> Value {
    json!({"app":app,"focused":focused,"position":[x,0.0],"size":[400.0,400.0],"state":"normal"})
}

#[tokio::test]
async fn typing_goes_to_the_focused_app_whatever_point_the_bot_names() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    let windows = std::sync::Arc::new(Mutex::new(json!([
        window("Terminal", true, 0.),
        window("Notes", false, 500.)
    ])));
    let (connection, _) = fake_mac(h, windows.clone());
    allow_app(h, "device:mac", "owl", "s1", "Notes", true).unwrap();
    // A point inside Notes can't disguise typing that lands in Terminal.
    let err = check_desktop(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        "off",
        &json!({"action":"type","text":"rm -rf ~","coordinate":[600,100]}),
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("focused window"), "{}", err.message);
    let err = check_desktop(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        "off",
        &json!({"action":"type","text":"rm -rf ~"}),
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("Terminal apps"), "{}", err.message);
    // A click checks the window under it, once a screenshot gave the scale.
    shot(h, "device:mac", 1200.);
    assert!(matches!(
        check_desktop(
            h,
            "alice",
            "owl",
            "s1",
            "device:mac",
            "smart",
            &json!({"action":"click","coordinate":[600,100]})
        )
        .await
        .unwrap(),
        Needs::Nothing
    ));
    // A click must name its point, and a point on no listed window is refused.
    let err = check_desktop(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        "off",
        &json!({"action":"click"}),
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("coordinate"), "{}", err.message);
    let err = check_desktop(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        "off",
        &json!({"action":"click","coordinate":[2000,2000]}),
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("Can't tell which app"));
    // open can't be checked, so it is refused.
    let err = check_desktop(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        "off",
        &json!({"action":"open","url":"https://x.example"}),
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("open is refused"));
    // A terminal over an allowed, focused app still blocks the click.
    *windows.lock().unwrap() = json!([window("Notes", true, 0.), window("iTerm2", false, 200.)]);
    let err = check_desktop(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        "off",
        &json!({"action":"click","coordinate":[300,100]}),
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("Terminal apps"), "{}", err.message);
    // An editor takes no input at all, clicks included, even once allowed.
    *windows.lock().unwrap() = json!([window("Code", true, 0.)]);
    allow_app(h, "device:mac", "owl", "s1", "Code", true).unwrap();
    let err = check_desktop(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        "off",
        &json!({"action":"click","coordinate":[100,100]}),
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("Editors and IDEs"), "{}", err.message);
    // A drag reaches both ends.
    *windows.lock().unwrap() = json!([window("Notes", true, 0.), window("Safari", false, 500.)]);
    match check_desktop(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        "smart",
        &json!({"action":"drag","coordinate":[100,100],"to_coordinate":[600,100]}),
    )
    .await
    .unwrap()
    {
        Needs::App { app, .. } => assert_eq!(app, "Safari"),
        Needs::Nothing => panic!("the drag's end in Safari should ask"),
    }
    // The point checked is the point pressed: a malformed coordinate is
    // refused, never swapped for from_coordinate somewhere unchecked.
    for start in [json!([100, 100, 0]), json!([100.5, 100])] {
        let args = json!({"action":"drag","coordinate":start,"from_coordinate":[600,100],"to_coordinate":[120,100]});
        assert!(
            check_desktop(h, "alice", "owl", "s1", "device:mac", "off", &args)
                .await
                .is_err(),
            "{args}"
        );
        assert!(crate::computers::translate(&args).is_err(), "{args}");
        // `translate` refuses it first in check_desktop; the drag check
        // refuses it on its own too.
        assert!(
            target_apps(h, "alice", "owl", "device:mac", "drag", &args)
                .await
                .is_err(),
            "{args}"
        );
    }
    // from_coordinate alone is the start, for both.
    let args = json!({"action":"drag","from_coordinate":[600,100],"to_coordinate":[120,100]});
    match check_desktop(h, "alice", "owl", "s1", "device:mac", "smart", &args)
        .await
        .unwrap()
    {
        Needs::App { app, .. } => assert_eq!(app, "Safari"),
        Needs::Nothing => panic!("the drag's start in Safari should ask"),
    }
    assert_eq!(
        crate::computers::translate(&args).unwrap().2["start_x"],
        600
    );
    detach(h, "mac", connection);
}

#[tokio::test]
async fn an_action_rechecks_its_target_and_grant_right_before_it_runs() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    let windows = std::sync::Arc::new(Mutex::new(json!([window("Notes", true, 0.)])));
    let (connection, done) = fake_mac(h, windows.clone());
    allow_app(h, "device:mac", "owl", "s1", "Notes", false).unwrap();
    let key = json!({"action":"key","keys":"enter"});
    act(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        || Ok("smart".into()),
        &key,
    )
    .await
    .unwrap();
    assert_eq!(*done.lock().unwrap(), ["computer_key"]);
    // Focus moved to an app the user never allowed: the old yes doesn't carry it.
    *windows.lock().unwrap() = json!([window("Mail", true, 0.)]);
    let err = act(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        || Ok("smart".into()),
        &key,
    )
    .await
    .err()
    .unwrap();
    assert!(
        err.message.contains("The screen changed"),
        "{}",
        err.message
    );
    // Or to a terminal, which is refused even in Bypass.
    *windows.lock().unwrap() = json!([window("iTerm2", true, 0.)]);
    let err = act(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        || Ok("off".into()),
        &key,
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("Terminal apps"));
    // The grant taken away while a card waited.
    *windows.lock().unwrap() = json!([window("Notes", true, 0.)]);
    set(h, "device:mac", DESKTOP, "owl", false).unwrap();
    let err = act(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        || Ok("smart".into()),
        &key,
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("can't use the desktop"));
    assert_eq!(
        done.lock().unwrap().len(),
        1,
        "nothing else reached the computer"
    );
    detach(h, "mac", connection);
}

#[test]
fn creating_hexbot_keeps_setups_no_to_this_computer() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    common::update_config(h, |c| {
        c["computer_use"]["command"] = json!("/nonexistent/cua");
        c["computers"]["defaults"] = json!({"host_terminal": false, "host_desktop": false});
        Ok(())
    })
    .unwrap();
    let created = crate::catalog::call(h, "alice", "hexbot.bots.create_primary", &json!({}))
        .expect("recognized method")
        .unwrap();
    let name = created["bot"]["name"].as_str().unwrap();
    // Its tool list names Terminal, but setup said no and there is no bots' computer.
    assert!(
        granted(h, name).unwrap().is_empty(),
        "{:?}",
        granted(h, name).unwrap()
    );
}

#[test]
fn restricted_sections_keep_the_computers_their_tools_reach() {
    let list = json!([
        {"id":"vm","name":"The bots' computer","kind":"vm","os":"Linux","terminal":true,"desktop":true},
        {"id":"host","name":"studio","kind":"host","os":"macOS","terminal":true,"desktop":false},
        {"id":"device:mac","name":"MacBook","kind":"device","os":"macOS","terminal":false,"desktop":true}
    ]);
    let bash_only = restricted_list(&list, true, false);
    assert_eq!(
        grants_of(&bash_only),
        json!([["vm", true, false], ["host", true, false]])
    );
    assert_eq!(restricted_list(&list, false, false), json!([]));
    assert_eq!(
        grants_of(&restricted_list(&list, true, true)),
        grants_of(&list)
    );
}

#[test]
fn what_a_computer_reports_never_rebuilds_a_chat() {
    let before = json!([{"id":"device:mac","name":"MacBook","kind":"device","os":"a desktop","terminal":true,"desktop":false}]);
    let after = json!([{"id":"device:mac","name":"MacBook Pro","kind":"device","os":"macOS","terminal":true,"desktop":false}]);
    assert_eq!(grants_of(&before), grants_of(&after));
    let more = json!([{"id":"device:mac","name":"MacBook","kind":"device","os":"macOS","terminal":true,"desktop":true}]);
    assert_ne!(grants_of(&before), grants_of(&more));
}

#[test]
fn a_point_with_an_unknown_window_on_it_is_unknown() {
    let allowed = json!({"app":"Notes","focused":true,"position":[0.0,0.0],"size":[500.0,500.0],"state":"normal"});
    let unnamed = json!({"app":"","focused":false,"position":[100.0,100.0],"size":[100.0,100.0],"state":"normal"});
    let unplaced = json!({"app":"Terminal","focused":false,"state":"normal"});
    assert!(apps_at(&[allowed.clone(), unnamed], Some((150., 150.))).is_empty());
    // A window that can't be placed may be anywhere, so it counts everywhere.
    assert_eq!(
        apps_at(&[allowed, unplaced], Some((10., 10.))),
        ["Notes", "Terminal"]
    );
}

#[test]
fn more_terminal_emulators_and_shells_are_blocked() {
    for app in [
        "foot",
        "urxvt",
        "rxvt-unicode",
        "st",
        "xfce4-terminal",
        "Tabby",
        "PuTTY",
        "Command Prompt",
        "pwsh",
        "WezTerm",
        "cool-retro-term",
    ] {
        assert!(blocked_app(app).is_some(), "{app}");
    }
}

#[test]
fn the_bots_computer_runs_a_command_as_written_and_cleans_up() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("seen");
    let command = format!(
        "printf '%s|' 'a b' \"it's\"; echo done > {}",
        marker.display()
    );
    let line = vm_line("unit", &command);
    assert!(line.starts_with("setsid -w sh -c "));
    // This computer may lack setsid; the rest of the line is plain sh.
    let out = std::process::Command::new("sh")
        .arg("-c")
        .arg(line.replacen("setsid -w ", "", 1))
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "a b|it's|");
    assert!(marker.exists());
    assert!(!Path::new("/tmp/hexbot-run-unit").exists());
}

#[test]
fn a_page_showing_hexbot_counts_as_hexbot_in_any_app() {
    let windows = vec![
        json!({"app":"Google Chrome","title":"Hexbot — Google Chrome","focused":true,"position":[0.0,0.0],"size":[500.0,500.0],"state":"normal"}),
    ];
    let apps = apps_at(&windows, Some((10., 10.)));
    assert_eq!(apps, ["Hexbot in Google Chrome"]);
    assert!(blocked_app(&apps[0]).is_some());
    assert_eq!(apps_at(&windows, None), ["Hexbot in Google Chrome"]);
    // Hex Connect's pages sign apps in to the owner's daemons: the same.
    let connect = vec![
        json!({"app":"Google Chrome","title":"Connect the app | Hex Connect – Google Chrome","focused":true}),
    ];
    assert_eq!(apps_at(&connect, None), ["Hexbot in Google Chrome"]);
}

#[test]
fn the_terminal_switch_in_bot_settings_takes_and_gives_computers() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    assert!(has(h, "owl", HOST, TERMINAL).unwrap());
    let tools = |list: &[&str]| json!({"name":"owl","tools":list});
    crate::catalog::call(
        h,
        "alice",
        "hexbot.bots.update",
        &tools(&["files", "computer_use"]),
    )
    .expect("recognized method")
    .unwrap();
    assert!(!any(h, "owl", TERMINAL).unwrap());
    assert!(
        !crate::connectors::toolsets(h, "owl")
            .unwrap()
            .contains(&"terminal".to_owned())
    );
    crate::catalog::call(
        h,
        "alice",
        "hexbot.bots.update",
        &tools(&["files", "terminal", "computer_use"]),
    )
    .expect("recognized method")
    .unwrap();
    assert!(any(h, "owl", TERMINAL).unwrap());
}

#[tokio::test]
async fn a_stopped_command_tells_the_computer_to_end_it() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", TERMINAL, "owl", true).unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let connection = connection_id();
    attach(h, "alice", "mac", connection, tx, &json!({"terminal":true})).unwrap();
    let home2 = h.to_owned();
    let running = tokio::spawn(async move {
        terminal(
            &home2,
            "alice",
            "owl",
            "device:mac",
            "sleep 60; rm -rf ~/work",
            Some(120),
            || Ok(()),
        )
        .await
    });
    let request = rx.recv().await.unwrap();
    let id = request["params"]["payload"]["request_id"]
        .as_str()
        .unwrap()
        .to_owned();
    running.abort();
    let cancel = rx.recv().await.unwrap();
    assert_eq!(cancel["params"]["payload"]["kind"], "cancel");
    assert_eq!(cancel["params"]["payload"]["cancels"], id);
    detach(h, "mac", connection);
}

#[test]
fn a_stop_before_the_command_starts_still_stops_it() {
    let run = format!("unit-{}", std::process::id());
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("ran");
    // The stop comes first: the command sees its marker and never runs.
    std::process::Command::new("sh")
        .arg("-c")
        .arg(vm_stop_line(&run))
        .status()
        .unwrap();
    let line = vm_line(&run, &format!("touch {}", marker.display()));
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(line.replacen("setsid -w ", "", 1))
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(130));
    assert!(!marker.exists());
    assert!(!Path::new(&format!("/tmp/hexbot-stop-{run}")).exists());
}

#[test]
fn turning_terminal_back_on_without_cua_gives_this_computer() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    common::update_config(h, |c| {
        c["computer_use"]["command"] = json!("/nonexistent/cua");
        Ok(())
    })
    .unwrap();
    sync_tools(h, "owl", false, true, true).unwrap();
    assert!(!any(h, "owl", TERMINAL).unwrap());
    sync_tools(h, "owl", true, true, true).unwrap();
    assert!(has(h, "owl", HOST, TERMINAL).unwrap());
    assert!(!has(h, "owl", VM, TERMINAL).unwrap());
}

#[tokio::test]
async fn a_request_that_times_out_is_cancelled_on_the_computer() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let connection = connection_id();
    attach(h, "alice", "mac", connection, tx, &json!({"desktop":true})).unwrap();
    let err = device_call(
        h,
        "alice",
        "mac",
        DESKTOP,
        json!({"tool":"computer_click"}),
        Duration::from_millis(50),
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("took too long"));
    let request = rx.recv().await.unwrap();
    let cancel = rx.recv().await.unwrap();
    assert_eq!(cancel["params"]["payload"]["kind"], "cancel");
    assert_eq!(
        cancel["params"]["payload"]["cancels"],
        request["params"]["payload"]["request_id"]
    );
    detach(h, "mac", connection);
}

/// The command line as the bots' computer runs it, with a new session made
/// by python where this computer has no setsid.
#[cfg(unix)]
fn local_vm_line(line: &str) -> String {
    line.replacen(
        "setsid -w ",
        "python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' ",
        1,
    )
}

#[cfg(unix)]
#[test]
fn a_stop_ends_a_running_command_and_what_it_started_under_dash_too() {
    for shell in ["/bin/sh", "/bin/dash"] {
        if !Path::new(shell).exists() {
            continue;
        }
        let run = format!("unit-running-{}-{}", std::process::id(), shell.len());
        let dir = tempfile::tempdir().unwrap();
        let after = dir.path().join("after");
        let line = local_vm_line(&vm_line(
            &run,
            &format!("sleep 30 & sleep 30; touch {}", after.display()),
        ));
        let mut child = std::process::Command::new(shell)
            .arg("-c")
            .arg(&line)
            .spawn()
            .unwrap();
        let file = format!("/tmp/hexbot-run-{run}");
        let started = std::time::Instant::now();
        // The file appears, then its id: wait for both.
        while std::fs::read_to_string(&file).map_or(true, |s| s.trim().is_empty())
            && started.elapsed() < Duration::from_secs(5)
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        let group: i32 = std::fs::read_to_string(&file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let status = std::process::Command::new(shell)
            .arg("-c")
            .arg(vm_stop_line(&run))
            .status()
            .unwrap();
        assert!(status.success(), "{shell}");
        let done = child.wait().unwrap();
        assert!(!done.success(), "{shell}: the command was killed");
        assert!(started.elapsed() < Duration::from_secs(10), "{shell}");
        assert!(!after.exists(), "{shell}");
        // Nothing of its group is left, background job included.
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            unsafe { libc::kill(-group, 0) } != 0,
            "{shell}: group still alive"
        );
        let _ = std::fs::remove_file(format!("/tmp/hexbot-stop-{run}"));
    }
}

#[test]
fn a_bots_computer_desktop_taken_away_stops_its_next_action() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, VM, DESKTOP, "owl", false).unwrap();
    let err = crate::computers::still_granted_for_tests(h, "owl")
        .err()
        .unwrap();
    assert!(err.message.contains("any more"));
    set(h, VM, DESKTOP, "owl", true).unwrap();
    assert!(crate::computers::still_granted_for_tests(h, "owl").is_ok());
}

#[tokio::test]
async fn a_command_whose_mode_changed_while_it_waited_is_refused() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", TERMINAL, "owl", true).unwrap();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let connection = connection_id();
    attach(h, "alice", "mac", connection, tx, &json!({"terminal":true})).unwrap();
    let err = terminal(h, "alice", "owl", "device:mac", "ls", Some(5), || {
        Err(Error::new(
            4302,
            "The approval mode changed before this ran. Try again.",
        ))
    })
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("approval mode changed"));
    // A card answered after the computer was taken away records nothing.
    set(h, "device:mac", DESKTOP, "owl", false).unwrap();
    assert!(may_use_desktop(h, "owl", "device:mac").is_err());
    detach(h, "mac", connection);
}

#[tokio::test]
async fn forgetting_a_computer_forgets_its_apps_for_this_conversation_too() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    allow_app(h, "device:mac", "owl", "s1", "Safari", false).unwrap();
    assert!(app_allowed(h, "device:mac", "owl", "s1", "Safari").unwrap());
    call(
        h,
        "alice",
        "hexbot.computers.forget",
        &json!({"computer":"device:mac"}),
    )
    .await
    .unwrap()
    .unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    assert!(!app_allowed(h, "device:mac", "owl", "s1", "Safari").unwrap());
}

#[tokio::test]
async fn a_look_after_an_action_checks_the_grant_again() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    let windows = std::sync::Arc::new(Mutex::new(json!([window("Notes", true, 0.)])));
    let (connection, done) = fake_mac(h, windows);
    allow_app(h, "device:mac", "owl", "s1", "Notes", true).unwrap();
    let home2 = h.to_owned();
    let acting = tokio::spawn(async move {
        act(
            &home2,
            "alice",
            "owl",
            "s1",
            "device:mac",
            || Ok("smart".into()),
            &json!({"action":"key","keys":"enter","capture_after":true}),
        )
        .await
    });
    // The key goes out; the grant goes during the wait before the look.
    while done.lock().unwrap().is_empty() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    set(h, "device:mac", DESKTOP, "owl", false).unwrap();
    let err = acting.await.unwrap().err().unwrap();
    assert!(
        err.message.contains("can't use the desktop"),
        "{}",
        err.message
    );
    assert_eq!(
        *done.lock().unwrap(),
        ["computer_key"],
        "no screenshot was taken"
    );
    detach(h, "mac", connection);
}

#[test]
fn a_chat_from_before_computers_compares_against_what_it_had() {
    let legacy = legacy_list(&json!(["file", "terminal", "computer_use"]));
    // What the migration writes for that bot: no change, no rebuild.
    let migrated = json!([
        {"id":"vm","name":"The bots' computer","kind":"vm","os":"Linux","terminal":false,"desktop":true},
        {"id":"host","name":"studio","kind":"host","os":"macOS","terminal":true,"desktop":false}
    ]);
    assert_eq!(grants_of(&legacy), grants_of(&migrated));
    // A computer added later is a change.
    let mut more = migrated.as_array().unwrap().clone();
    more.push(json!({"id":"device:mac","terminal":true,"desktop":false}));
    assert_ne!(grants_of(&legacy), grants_of(&json!(more)));
    assert_eq!(legacy_list(&json!(["file"])), json!([]));
}

#[tokio::test]
async fn forgetting_an_online_computer_takes_it_offline_at_once() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", TERMINAL, "owl", true).unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    attach(
        h,
        "alice",
        "mac",
        connection_id(),
        tx,
        &json!({"terminal":true,"os":"macOS"}),
    )
    .unwrap();
    // A command is running there when the user forgets the computer.
    let home2 = h.to_owned();
    let running = tokio::spawn(async move {
        terminal(
            &home2,
            "alice",
            "owl",
            "device:mac",
            "sleep 60",
            Some(120),
            || Ok(()),
        )
        .await
    });
    rx.recv().await.unwrap();
    // The app confirms it ended what bots started there.
    let home3 = h.to_owned();
    let app = tokio::spawn(async move {
        let release = rx.recv().await.unwrap();
        assert_eq!(release["params"]["payload"]["kind"], "release");
        let id = release["params"]["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_owned();
        reply(
            &home3,
            "mac",
            &json!({"request_id":id,"result":{"released":true}}),
        )
        .unwrap();
    });
    let forgotten = call(
        h,
        "alice",
        "hexbot.computers.forget",
        &json!({"computer":"device:mac"}),
    )
    .await
    .unwrap()
    .unwrap();
    app.await.unwrap();
    assert_eq!(forgotten["released"], true);
    assert!(running.await.unwrap().is_err());
    let listed = list(h, "alice").await.unwrap();
    assert!(
        !listed["computers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == "device:mac"),
        "{listed}"
    );
}

#[tokio::test]
async fn forget_says_so_when_the_app_does_not_confirm() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    attach(
        h,
        "alice",
        "mac",
        connection_id(),
        tx,
        &json!({"terminal":true}),
    )
    .unwrap();
    let forgotten = forget(h, "alice", &json!({"computer":"device:mac"}))
        .await
        .unwrap();
    assert_eq!(forgotten["released"], false);
    assert!(
        forgotten["note"]
            .as_str()
            .unwrap()
            .contains("Stop bots on this computer")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn turning_this_desktop_off_wins_over_a_setup_still_running() {
    use std::os::unix::fs::PermissionsExt;
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    // A Cua whose setup is slow and whose target appears once setup ends.
    let marker = h.join("setup-done");
    let cua = h.join("fake-cua");
    fs::write(
        &cua,
        format!(
            "#!/bin/sh\ncase \"$1 $2\" in\n\"sb ls\") if [ -e {m} ]; then echo '[{{\"id\":\"direct:127.0.0.1:3211\",\"location\":\"direct\",\"state\":\"running\"}}]'; else echo '[]'; fi ;;\n\"host setup\") sleep 1; touch {m} ;;\nesac\n",
            m = marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&cua, fs::Permissions::from_mode(0o755)).unwrap();
    common::update_config(h, |c| {
        c["computer_use"]["command"] = json!(cua);
        Ok(())
    })
    .unwrap();
    *HOST_TARGET.get_or_init(Default::default).lock().unwrap() = None;
    let home2 = h.to_owned();
    let enabling = tokio::spawn(async move {
        call(
            &home2,
            "alice",
            "hexbot.computers.set",
            &json!({"computer":"host","desktop":true}),
        )
        .await
        .unwrap()
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    call(
        h,
        "alice",
        "hexbot.computers.set",
        &json!({"computer":"host","desktop":false}),
    )
    .await
    .unwrap()
    .unwrap();
    let err = enabling.await.unwrap().err().unwrap();
    assert!(
        err.message.contains("stays as you set it last"),
        "{}",
        err.message
    );
    assert!(!host_desktop_on(h).unwrap());
}

#[tokio::test]
async fn a_stopped_desktop_action_is_cancelled_on_the_computer() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    allow_app(h, "device:mac", "owl", "s1", "Notes", true).unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    attach(
        h,
        "alice",
        "mac",
        connection_id(),
        tx,
        &json!({"desktop":true}),
    )
    .unwrap();
    let home2 = h.to_owned();
    let acting = tokio::spawn(async move {
        act(
            &home2,
            "alice",
            "owl",
            "s1",
            "device:mac",
            || Ok("smart".into()),
            &json!({"action":"key","keys":"enter"}),
        )
        .await
    });
    // Answer the look-ups like Cua; hold the key itself.
    let key_id = loop {
        let frame = rx.recv().await.unwrap();
        let payload = &frame["params"]["payload"];
        let id = payload["request_id"].as_str().unwrap().to_owned();
        match payload["tool"].as_str().unwrap_or("") {
            "computer_window_list" => {
                let text = json!({"windows":[window("Notes", true, 0.)]}).to_string();
                reply(
                    h,
                    "mac",
                    &json!({"request_id":id,"result":{"content":[{"type":"text","text":text}]}}),
                )
                .unwrap();
            }
            "computer_key" => break id,
            _ => {
                reply(
                    h,
                    "mac",
                    &json!({"request_id":id,"result":{"content":[{"type":"text","text":"{}"}]}}),
                )
                .unwrap();
            }
        }
    };
    // The user stops the chat while the key is on its way.
    acting.abort();
    let cancel = rx.recv().await.unwrap();
    assert_eq!(cancel["params"]["payload"]["kind"], "cancel");
    assert_eq!(cancel["params"]["payload"]["cancels"], key_id);
    // The computer stays held until that request settles.
    let lock = desktop_lock(h, "device:mac");
    assert!(lock.try_lock().is_err());
    reply(
        h,
        "mac",
        &json!({"request_id":key_id,"error":"The request was stopped."}),
    )
    .unwrap();
    let _free = tokio::time::timeout(Duration::from_secs(5), lock.lock())
        .await
        .unwrap();
}

#[tokio::test]
async fn an_action_stopped_or_revoked_before_it_is_queued_is_never_sent() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    attach(
        h,
        "alice",
        "mac",
        connection_id(),
        tx,
        &json!({"desktop":true}),
    )
    .unwrap();
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(true);
    let err = desktop_send_until(
        h,
        "alice",
        "owl",
        "device:mac",
        None,
        "computer_key",
        json!({"key":"enter"}),
        Some(stop_rx),
        true,
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("stopped"));
    drop(stop_tx);
    set(h, "device:mac", DESKTOP, "owl", false).unwrap();
    let err = desktop_send_until(
        h,
        "alice",
        "owl",
        "device:mac",
        None,
        "computer_key",
        json!({"key":"enter"}),
        None,
        true,
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("can't use the desktop"));
    assert!(rx.try_recv().is_err(), "nothing reached the computer");
}

#[test]
fn another_tool_switch_keeps_a_desktop_on_a_users_computer_without_cua_here() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    common::update_config(h, |c| {
        c["computer_use"]["command"] = json!("/nonexistent/cua");
        Ok(())
    })
    .unwrap();
    set(h, VM, DESKTOP, "owl", false).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    // Bot settings list Computer use, and saving another tool keeps it.
    assert!(
        !crate::native_tools::not_set_up(h, "owl")
            .unwrap()
            .contains(&"computer_use")
    );
    crate::catalog::call(
        h,
        "alice",
        "hexbot.bots.update",
        &json!({"name":"owl","tools":["files","terminal","computer_use","vision"]}),
    )
    .expect("recognized method")
    .unwrap();
    assert!(has(h, "owl", "device:mac", DESKTOP).unwrap());
}

#[cfg(unix)]
#[tokio::test]
async fn a_stopped_action_never_reaches_this_computers_desktop() {
    use std::os::unix::fs::PermissionsExt;
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    // A Cua that answers every MCP request and logs what it was sent.
    let log = h.join("cua.log");
    let cua = h.join("fake-cua");
    fs::write(
        &cua,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {log}.args\nwhile IFS= read -r line; do\n  printf '%s\\n' \"$line\" >> {log}\n  id=$(printf '%s' \"$line\" | sed -n 's/.*\"id\":\\([0-9][0-9]*\\).*/\\1/p')\n  [ -z \"$id\" ] && continue\n  case \"$line\" in\n    *'\"initialize\"'*) echo '{{\"jsonrpc\":\"2.0\",\"id\":'$id',\"result\":{{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{{\"tools\":{{}}}},\"serverInfo\":{{\"name\":\"f\",\"version\":\"1\"}}}}}}' ;;\n    *) echo '{{\"jsonrpc\":\"2.0\",\"id\":'$id',\"result\":{{\"content\":[{{\"type\":\"text\",\"text\":\"ok\"}}]}}}}' ;;\n  esac\ndone\n",
            log = log.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&cua, fs::Permissions::from_mode(0o755)).unwrap();
    common::update_config(h, |c| {
        c["computer_use"]["command"] = json!(cua);
        c["computers"][HOST]["desktop_on"] = json!(true);
        Ok(())
    })
    .unwrap();
    set(h, HOST, DESKTOP, "owl", true).unwrap();
    let target = Some("direct:127.0.0.1:3211");
    // The warm-up starts the session the final send must find up.
    desktop_send(
        h,
        "alice",
        "owl",
        HOST,
        target,
        "computer_get_screen_size",
        json!({}),
    )
    .await
    .unwrap();
    let (_stop_tx, stopped) = tokio::sync::watch::channel(true);
    let err = desktop_send_until(
        h,
        "alice",
        "owl",
        HOST,
        target,
        "computer_key",
        json!({"key":"enter"}),
        Some(stopped),
        true,
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("stopped"), "{}", err.message);
    assert!(!fs::read_to_string(&log).unwrap().contains("computer_key"));
    // Not stopped: the same action goes through on the same session.
    let (_go_tx, go) = tokio::sync::watch::channel(false);
    desktop_send_until(
        h,
        "alice",
        "owl",
        HOST,
        target,
        "computer_key",
        json!({"key":"enter"}),
        Some(go),
        true,
    )
    .await
    .unwrap();
    assert!(fs::read_to_string(&log).unwrap().contains("computer_key"));
    // Cua was started with only the desktop tool groups, never all of them.
    let args = fs::read_to_string(log.with_extension("log.args")).unwrap();
    assert!(
        args.contains(&format!("--permissions {DESKTOP_PERMISSIONS}")),
        "{args}"
    );
    assert!(!args.contains("computer:all"), "{args}");
    crate::connectors::close_config(h, "owl", "hexbot-this-computer").await;
}

#[test]
fn a_tool_save_without_cua_keeps_the_bots_computers_desktop() {
    let home = setup();
    let h = home.path();
    // An upgraded install: every bot has the bots' computer's desktop.
    migrate(h).unwrap();
    set(h, VM, DESKTOP, "owl", true).unwrap();
    common::update_config(h, |c| {
        c["computer_use"]["command"] = json!("/nonexistent/cua");
        Ok(())
    })
    .unwrap();
    let call = |method: &str, p: Value| {
        crate::catalog::call(h, "alice", method, &p)
            .expect("recognized method")
            .unwrap()
    };
    // Bot settings hides the switch, yet the bot's tools still list it.
    let bot = call("hexbot.bots.get", json!({"name":"owl"}))["bot"].clone();
    assert!(
        !bot["available_tools"]
            .as_array()
            .unwrap()
            .contains(&json!("computer_use"))
    );
    let mut tools = bot["tools"].as_array().unwrap().clone();
    assert!(tools.contains(&json!("computer_use")));
    // The apps save another switch with the list as they got it: kept.
    tools.push(json!("vision"));
    call("hexbot.bots.update", json!({"name":"owl","tools":tools}));
    assert!(has(h, "owl", VM, DESKTOP).unwrap());
    // A list without it, as the API or the primary bot sends: taken.
    call(
        "hexbot.bots.update",
        json!({"name":"owl","tools":["files","terminal","vision"]}),
    );
    assert!(!has(h, "owl", VM, DESKTOP).unwrap());
}

#[test]
fn script_apps_and_more_editors_never_take_input() {
    for app in [
        "Script Editor",
        "Automator",
        "Shortcuts",
        "Run",
        "VSCodium",
        "Emacs",
        "MacVim",
        "Eclipse",
        "RStudio",
        "Positron",
        "Kate",
        "Alfred 5",
        "Raycast",
        "KRunner",
        "PowerToys.PowerLauncher",
        "TeamViewer",
        "AnyDesk",
        "Parsec",
        "RustDesk",
        "Microsoft Remote Desktop",
        "mstsc",
        "Jump Desktop",
        "iPhone Mirroring",
        "Windows App",
        "VNC Viewer",
        "RealVNC Viewer",
        "Spotlight",
        "SearchHost",
        "StartMenuExperienceHost",
        "Search",
        "bash.exe",
        "/bin/zsh",
        "-zsh",
        "nu",
        "python3",
        "C:\\Windows\\System32\\wsl.exe",
        "Code.exe",
        "C:\\Program Files\\Microsoft VS Code\\Code.exe",
        "zed.exe",
        "kate.exe",
        "Ptyxis",
        "Black Box",
        "Task Manager",
        "Taskmgr.exe",
        "Task Scheduler",
        "mmc.exe",
        "Notepad++",
        "IDLE",
        "Xshell 8",
        "SecureCRT",
        "Claude",
        "Codex",
        "T3 Code",
        "Antigravity",
        "Kiro",
        "Trae",
        "Void",
        "Goose",
        "OpenCode",
        "Conductor",
        "Docker Desktop",
        "Wave",
        "Prompt 3",
        "Rio",
        "foot",
        "footclient",
        "WarpPreview",
        "Warp",
        "Hyper",
        "kitty",
        "Tilda",
        "Remmina",
        "NoMachine",
        "Splashtop Business",
        "Royal TSX",
        "Spyder",
        "Thonny",
        "JupyterLab",
        "(bash)",
        "[zsh]",
        "Power Automate",
        "PAD.Designer",
        "Keyboard Maestro",
        "Flow Launcher",
        "Wox",
        "Albert",
        "Ulauncher",
        "rofi",
        "wofi",
        "dmenu_run",
        "xfce4-appfinder",
        "env",
        "nohup",
        "julia",
        "R",
    ] {
        assert!(blocked_app(app).is_some(), "{app}");
    }
    for app in [
        "Notes",
        "Safari",
        "Mail",
        "Runner's Log",
        "Wavebox",
        "Microsoft Excel",
        "Priority Matrix",
        "Albertsons",
        "Wordle",
        "Screenshot",
        "Calendario",
        "Recordatorios",
        "Calendário",
        "Footnote",
        "Hyperbolic",
    ] {
        assert!(blocked_app(app).is_none(), "{app}");
    }
    assert!(app_warning("Microsoft Excel").unwrap().contains("macros"));
    for office in [
        "EXCEL.EXE",
        "WINWORD.EXE",
        "olk.exe",
        "LibreOffice Calc",
        "soffice",
    ] {
        assert!(app_warning(office).unwrap().contains("macros"), "{office}");
    }
    assert!(app_warning("msedge.exe").unwrap().contains("browser"));
    for launcher in ["Dock", "Launchpad"] {
        assert!(
            app_warning(launcher)
                .unwrap()
                .contains("open or run any program"),
            "{launcher}"
        );
    }
    assert_eq!(app_warning("Dockside"), None);
    assert!(app_warning("Microsoft Edge").unwrap().contains("browser"));
    assert!(app_warning("Arc").unwrap().contains("browser"));
    assert_eq!(app_warning("Search"), None);
    assert_eq!(app_warning("Knowledge"), None);
    assert!(
        app_warning("File Explorer")
            .unwrap()
            .contains("run commands")
    );
}

#[test]
fn system_wide_shortcuts_are_refused_on_real_computers() {
    for keys in [
        "win+r",
        "super",
        "Meta+E",
        "ctrl+alt+t",
        "cmd+space",
        "alt+f2",
        "alt+space",
        "option+space",
        "ctrl+esc",
        "ctrl+shift+escape",
        "Super_L",
        "winleft+r",
        "cmdright+space",
        "Control_L+Alt_R+t",
        "alt+f3",
        "Hyper_L+r",
        "hyper+t",
    ] {
        assert!(system_shortcut(keys, true), "{keys}");
        assert!(system_shortcut(keys, false), "{keys}");
    }
    // Outside macOS (or when the OS isn't known) Cmd is the Windows or Super
    // key: Cmd+R opens Run, Cmd+D a tiling desktop's launcher.
    for keys in ["cmd+r", "command+d", "cmd+x", "cmd"] {
        assert!(system_shortcut(keys, false), "{keys}");
        assert!(!system_shortcut(keys, true), "{keys}");
    }
    for keys in [
        "cmd+c",
        "ctrl+s",
        "enter",
        "alt+tab",
        "ctrl+t",
        "right",
        "ctrl+left",
        "space",
    ] {
        assert!(!system_shortcut(keys, true), "{keys}");
    }
}

#[tokio::test]
async fn cmd_is_the_windows_or_super_key_outside_macos() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    let windows = std::sync::Arc::new(Mutex::new(json!([window("Notes", true, 0.)])));
    let (connection, _) = fake_mac(h, windows);
    let key = |keys: &str| json!({"action":"key","keys":keys});
    // On macOS Cmd+C copies.
    assert!(
        check_desktop(h, "alice", "owl", "s1", "device:mac", "off", &key("cmd+c"))
            .await
            .is_ok()
    );
    // The same computer reporting Windows: Cmd is the Windows key, so Cmd+R
    // (Run) is refused, Bypass too.
    common::update_config(h, |config| {
        config["computers"]["device:mac"]["os"] = json!("Windows");
        Ok(())
    })
    .unwrap();
    let err = check_desktop(h, "alice", "owl", "s1", "device:mac", "off", &key("cmd+r"))
        .await
        .err()
        .unwrap();
    assert!(err.message.contains("System-wide"), "{}", err.message);
    detach(h, "mac", connection);
}

#[tokio::test]
async fn a_click_is_checked_where_it_lands_on_a_hidpi_screen_or_refused() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    // Notes at points 0-400, Terminal at 500-900; the screen is 1200 points.
    let windows = std::sync::Arc::new(Mutex::new(json!([
        window("Notes", true, 0.),
        window("Terminal", false, 500.)
    ])));
    let _device = fake_mac(h, windows.clone());
    allow_app(h, "device:mac", "owl", "s1", "Notes", true).unwrap();
    let click = |x: i64| json!({"action":"click","coordinate":[x,100]});
    // No screenshot yet: the scale is unknown, so the click is refused.
    let err = check_desktop(h, "alice", "owl", "s1", "device:mac", "off", &click(700))
        .await
        .err()
        .unwrap();
    assert!(err.message.contains("Take a screenshot"), "{}", err.message);
    // A 2x screenshot (2400 px): pixel 700 is point 350, inside Notes...
    shot(h, "device:mac", 2400.);
    assert!(matches!(
        check_desktop(h, "alice", "owl", "s1", "device:mac", "off", &click(700))
            .await
            .unwrap(),
        Needs::Nothing
    ));
    // ...and pixel 1400 is point 700, inside Terminal, whatever pixel 1400
    // would mean on a 1x screen.
    let err = check_desktop(h, "alice", "owl", "s1", "device:mac", "off", &click(1400))
        .await
        .err()
        .unwrap();
    assert!(err.message.contains("Terminal apps"), "{}", err.message);
    // A screenshot from when the screen was 600 points wide no longer says
    // where pixel 700 lands: refused until the bot looks again.
    shot_on(h, "device:mac", 2400., 600.);
    let err = check_desktop(h, "alice", "owl", "s1", "device:mac", "off", &click(700))
        .await
        .err()
        .unwrap();
    assert!(err.message.contains("screen changed"), "{}", err.message);
}

#[test]
fn a_browsers_devtools_window_never_takes_input_whatever_page_it_inspects() {
    let devtools = json!({"app":"Google Chrome","title":"DevTools - 192.168.1.5:9119/","focused":true,"position":[0.0,0.0],"size":[400.0,400.0],"state":"normal"});
    let apps = apps_at(&[devtools], None);
    assert_eq!(apps, ["DevTools in Google Chrome"]);
    assert!(blocked_app(&apps[0]).unwrap().contains("developer tools"));
    for title in [
        "Web Inspector — 192.168.1.5",
        "Browser Toolbox",
        "Developer Tools - mac.tailnet.ts.net",
    ] {
        let w = json!({"app":"Safari","title":title,"focused":true});
        assert!(blocked_app(&apps_at(&[w], None)[0]).is_some(), "{title}");
    }
    // An ordinary browser window is still just the browser.
    let page = json!({"app":"Google Chrome","title":"Recipes","focused":true});
    assert_eq!(apps_at(&[page], None), ["Google Chrome"]);
}

#[test]
fn every_focused_window_must_pass_for_typing() {
    let windows = vec![window("Notes", true, 0.), window("Terminal", true, 500.)];
    let apps = apps_at(&windows, None);
    assert!(apps.contains(&"Notes".to_owned()) && apps.contains(&"Terminal".to_owned()));
    let unnamed = vec![window("Notes", true, 0.), json!({"focused":true})];
    assert!(apps_at(&unnamed, None).is_empty());
}

#[tokio::test]
async fn a_request_on_a_replaced_connection_fails_once_the_app_confirms_it_stopped() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    let (tx_a, mut rx_a) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let a = connection_id();
    attach(h, "alice", "mac", a, tx_a, &json!({"terminal":true})).unwrap();
    let home2 = h.to_owned();
    let mut waiting = tokio::spawn(async move {
        device_call(
            &home2,
            "alice",
            "mac",
            TERMINAL,
            json!({"command":"ls"}),
            Duration::from_secs(60),
        )
        .await
    });
    // The request went out on A, which (as after sleep) never answers.
    rx_a.recv().await.unwrap();
    // The app is back on B before anyone noticed A was dead. It is asked,
    // on B, to stop what bots started there; until it answers, the request
    // on A keeps the computer.
    let (tx_b, mut rx_b) = tokio::sync::mpsc::unbounded_channel::<Value>();
    attach(
        h,
        "alice",
        "mac",
        connection_id(),
        tx_b,
        &json!({"terminal":true}),
    )
    .unwrap();
    let release = rx_b.recv().await.unwrap();
    let payload = &release["params"]["payload"];
    assert_eq!(payload["kind"], "release");
    assert!(futures_util::poll!(&mut waiting).is_pending());
    reply(
        h,
        "mac",
        &json!({"request_id":payload["request_id"],"result":{"released":true}}),
    )
    .unwrap();
    let err = tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .expect("failed once the app confirmed, not at its 60 s timeout")
        .unwrap()
        .err()
        .unwrap();
    // The computer is back: the bot is told to try again, not that it's offline.
    assert!(err.message.contains("was replaced"), "{}", err.message);
    // The bot reads which computer, not "That computer".
    assert!(!err.message.contains("That computer"), "{}", err.message);
    assert_eq!(payload["reason"], "replaced");
    // A closing later touches nothing on B.
    detach(h, "mac", a);
    assert!(online(h, "mac").is_some());
}

#[tokio::test]
async fn a_request_on_a_replaced_connection_waits_without_confirmation_until_it_closes() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    let (tx_a, mut rx_a) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let a = connection_id();
    attach(h, "alice", "mac", a, tx_a, &json!({"terminal":true})).unwrap();
    let home2 = h.to_owned();
    let mut waiting = tokio::spawn(async move {
        device_call(
            &home2,
            "alice",
            "mac",
            TERMINAL,
            json!({"command":"ls"}),
            Duration::from_secs(60),
        )
        .await
    });
    rx_a.recv().await.unwrap();
    let (tx_b, mut rx_b) = tokio::sync::mpsc::unbounded_channel::<Value>();
    attach(
        h,
        "alice",
        "mac",
        connection_id(),
        tx_b,
        &json!({"terminal":true}),
    )
    .unwrap();
    // The app doesn't confirm: the request on A still holds on.
    let release = rx_b.recv().await.unwrap();
    reply(
        h,
        "mac",
        &json!({"request_id":release["params"]["payload"]["request_id"],"result":{"released":false}}),
    )
    .unwrap();
    tokio::task::yield_now().await;
    assert!(futures_util::poll!(&mut waiting).is_pending());
    // A closing ends it at once, even with B attached.
    detach(h, "mac", a);
    let err = tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .expect("failed when A closed")
        .unwrap()
        .err()
        .unwrap();
    assert!(err.message.contains("offline"), "{}", err.message);
}

#[test]
fn a_section_lists_only_the_computers_its_tools_reach() {
    let list = json!([
        {"id":"vm","terminal":true,"desktop":true},
        {"id":"host","terminal":true,"desktop":false},
        {"id":"device:mac","terminal":false,"desktop":true}
    ]);
    let ids = |v: &Value| {
        v.as_array()
            .unwrap()
            .iter()
            .map(|c| {
                format!(
                    "{}:{}{}",
                    c["id"].as_str().unwrap(),
                    c["terminal"],
                    c["desktop"]
                )
            })
            .collect::<Vec<_>>()
    };
    // Everything, when the bots' computer runs and both tools are there.
    assert_eq!(ids(&reachable_list(&list, true, true, true)).len(), 3);
    // No Cua here: the bots' computer goes, a user's desktop stays.
    assert_eq!(
        ids(&reachable_list(&list, true, true, false)),
        ["host:truefalse", "device:mac:falsetrue"]
    );
    // A heartbeat (no bash, no computer_use) lists nothing.
    assert!(
        reachable_list(&list, false, false, true)
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn typed_text_with_a_line_break_is_refused_on_real_computers() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    let err = check_desktop(
        h,
        "alice",
        "owl",
        "s1",
        "device:mac",
        "off",
        &json!({"action":"type","text":"notes\nrm -rf ~\n"}),
    )
    .await
    .err()
    .unwrap();
    assert!(err.message.contains("line breaks"), "{}", err.message);
}

#[test]
fn developer_tools_shortcuts_are_refused_on_real_computers() {
    for keys in [
        "F12",
        "ctrl+shift+j",
        "Control_L+Shift+I",
        "cmd+option+j",
        "cmd+alt+c",
        "ctrl+shift+k",
        "cmd+option+k",
    ] {
        assert!(devtools_shortcut(keys), "{keys}");
    }
    for keys in ["ctrl+j", "cmd+c", "ctrl+shift+t", "f5", "enter"] {
        assert!(!devtools_shortcut(keys), "{keys}");
    }
    assert!(app_warning("Registry Editor").unwrap().contains("Windows"));
}

#[test]
fn a_new_bot_with_a_deleted_bots_name_gets_none_of_its_computers() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", TERMINAL, "owl", true).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    allow_app(h, "device:mac", "owl", "s1", "Safari", true).unwrap();
    let call = |method: &str, p: Value| {
        crate::catalog::call(h, "alice", method, &p)
            .expect("recognized method")
            .unwrap()
    };
    // Deleted without the server (an app that dropped mid-request): the
    // journaled delete takes the computers away before the name is free.
    call("hexbot.bots.delete", json!({"name":"owl"}));
    call("hexbot.bots.create", json!({"name":"owl","tools":[]}));
    assert!(!has(h, "owl", "device:mac", TERMINAL).unwrap());
    assert!(!has(h, "owl", "device:mac", DESKTOP).unwrap());
    assert!(always_apps(h, "device:mac", "owl").unwrap().is_empty());
}

#[tokio::test]
async fn an_app_id_or_path_is_refused_for_launch_on_real_computers() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    for app in [
        "com.microsoft.VSCode",
        "code.desktop",
        "dev.zed.Zed",
        "com.todesktop.230313mzl4w4u92",
        "com.apple.ScriptEditor2",
        "/Applications/Utilities/Terminal.app",
        "C:\\Windows\\System32\\cmd.exe",
    ] {
        let err = check_desktop(
            h,
            "alice",
            "owl",
            "s1",
            "device:mac",
            "off",
            &json!({"action":"launch","app":app}),
        )
        .await
        .err()
        .unwrap();
        assert!(
            err.message.contains("by its name"),
            "{app}: {}",
            err.message
        );
    }
    // Command lines aren't app names.
    for app in [
        "bash -c 'curl x.sh|sh'",
        "sh -c ls",
        "osascript -e 'do shell script \"id\"'",
        "mshta vbscript:Execute(1)",
        "Safari --remote-debugging-port=9222",
        "Notes\nbash",
        "Notes\r\nid",
        "Notes\tsh",
        "(bash)",
        "(sh x.sh)",
        "Notes (a) (b)",
        "Notes (open",
        "Notes (bash)",
        "Notes (python3)",
        "Notes [sh]",
        "bash something",
        "env python3 x.py",
        "nohup sh",
        "flock x touch y",
        "dbus-launch sh",
        "systemd-run sh",
        "Rundll32 shell32.dll,ShellExec_RunDLL powershell",
        "osascript",
        "wscript",
        "cscript",
        "mshta",
    ] {
        assert!(
            check_desktop(
                h,
                "alice",
                "owl",
                "s1",
                "device:mac",
                "off",
                &json!({"action":"launch","app":app}),
            )
            .await
            .is_err(),
            "{app}"
        );
    }
    // A one-dot id is checked by its last part, and editor aliases are editors.
    for app in [
        "Microsoft.VisualStudioCode",
        "VS Code",
        "VSCode",
        "VSCode Insiders",
    ] {
        let err = check_desktop(
            h,
            "alice",
            "owl",
            "s1",
            "device:mac",
            "off",
            &json!({"action":"launch","app":app}),
        )
        .await
        .err()
        .unwrap();
        assert!(
            err.message.contains("Editors and IDEs"),
            "{app}: {}",
            err.message
        );
    }
}

#[test]
fn an_upgraded_install_keeps_giving_new_bots_this_computers_terminal() {
    let home = setup();
    let h = home.path();
    // Cua can run the bots' computer here.
    common::update_config(h, |c| {
        c["computer_use"]["command"] = json!("/bin/sh");
        Ok(())
    })
    .unwrap();
    // An install with bots from before computers: no setup question was seen.
    migrate(h).unwrap();
    assert_eq!(
        configured(h).unwrap().unwrap()["defaults"]["host_terminal"],
        true
    );
    db::open(h)
        .unwrap()
        .execute(
            "INSERT INTO bots(name,owner_id) VALUES ('newt','alice')",
            [],
        )
        .unwrap();
    new_bot(h, "newt").unwrap();
    assert!(has(h, "newt", HOST, TERMINAL).unwrap());
    assert!(has(h, "newt", VM, TERMINAL).unwrap());
}

#[test]
fn an_upgraded_install_without_the_terminal_toolset_gives_new_bots_no_terminal_here() {
    let home = setup();
    let h = home.path();
    // Cua can run, and the daemon's own toolsets leave the terminal out.
    common::update_config(h, |c| {
        c["computer_use"]["command"] = json!("/bin/sh");
        c["tools"]["enabled_toolsets"] = json!(["file", "web"]);
        Ok(())
    })
    .unwrap();
    migrate(h).unwrap();
    assert_eq!(
        configured(h).unwrap().unwrap()["defaults"]["host_terminal"],
        false
    );
    db::open(h)
        .unwrap()
        .execute(
            "INSERT INTO bots(name,owner_id) VALUES ('newt','alice')",
            [],
        )
        .unwrap();
    new_bot(h, "newt").unwrap();
    assert!(!has(h, "newt", HOST, TERMINAL).unwrap());
}

#[tokio::test]
async fn granting_an_unknown_computer_is_refused() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    let grant =
        |computer: &str| json!({"computer":computer,"capability":"terminal","bot":"owl","on":true});
    let err = call(
        h,
        "alice",
        "hexbot.computers.grant",
        &grant("device:macbook"),
    )
    .await
    .unwrap()
    .err()
    .unwrap();
    assert!(
        err.message.contains("No paired computer"),
        "{}",
        err.message
    );
    assert!(!has(h, "owl", "device:macbook", TERMINAL).unwrap());
    // A paired one is given; taking an unknown one away still works.
    call(h, "alice", "hexbot.computers.grant", &grant("device:mac"))
        .await
        .unwrap()
        .unwrap();
    assert!(has(h, "owl", "device:mac", TERMINAL).unwrap());
    call(
        h,
        "alice",
        "hexbot.computers.grant",
        &json!({"computer":"device:macbook","capability":"terminal","bot":"owl","on":false}),
    )
    .await
    .unwrap()
    .unwrap();
}

#[tokio::test]
async fn taking_back_an_app_on_a_mistyped_computer_is_refused() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    let err = call(
        h,
        "alice",
        "hexbot.computers.remove_app",
        &json!({"computer":"devise:mac","bot":"owl","app":"Notes"}),
    )
    .await
    .unwrap()
    .err()
    .unwrap();
    assert_eq!(err.code, 4202, "{}", err.message);
    let config = common::read_config(h).unwrap();
    assert!(config["computers"]["apps"].get("devise:mac").is_none());
}

#[tokio::test]
async fn a_computer_that_only_shared_once_is_not_listed() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    // It attached once (its OS is kept), then went away with no bots on it.
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let connection = connection_id();
    attach(
        h,
        "alice",
        "mac",
        connection,
        tx,
        &json!({"terminal":true,"os":"macOS"}),
    )
    .unwrap();
    detach(h, "mac", connection);
    let ids = |list: &Value| {
        list["computers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    let listed = list(h, "alice").await.unwrap();
    assert!(!ids(&listed).contains(&"device:mac".to_owned()), "{listed}");
    // With a bot on it, it stays listed while offline.
    set(h, "device:mac", TERMINAL, "owl", true).unwrap();
    let listed = list(h, "alice").await.unwrap();
    assert!(ids(&listed).contains(&"device:mac".to_owned()), "{listed}");
}

#[test]
fn turning_the_terminal_off_also_takes_a_switched_off_bots_computer() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, VM, TERMINAL, "owl", true).unwrap();
    set(h, HOST, TERMINAL, "owl", true).unwrap();
    // The bots' computer is switched off, then owl's Terminal is turned off.
    common::update_config(h, |c| {
        c["computers"]["vm"]["off"] = json!(true);
        Ok(())
    })
    .unwrap();
    crate::catalog::call(
        h,
        "alice",
        "hexbot.bots.update",
        &json!({"name":"owl","tools":["files"]}),
    )
    .expect("recognized method")
    .unwrap();
    // Switched back on, it doesn't give back the terminal taken away.
    common::update_config(h, |c| {
        c["computers"]["vm"]["off"] = json!(false);
        Ok(())
    })
    .unwrap();
    assert!(!has(h, "owl", VM, TERMINAL).unwrap());
    assert!(!has(h, "owl", HOST, TERMINAL).unwrap());
}

#[test]
fn the_desktop_app_starts_cua_with_the_same_tool_groups() {
    // The daemon and the desktop app keep one list; a change to one must
    // reach the other.
    let app = include_str!("../../../apps/desktop/src/main/computer.ts");
    assert!(
        app.contains(&format!("'{DESKTOP_PERMISSIONS}'")),
        "the desktop app's DESKTOP_PERMISSIONS differs"
    );
}

#[test]
fn another_tool_saved_while_the_bots_computer_is_off_keeps_its_grants() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    // owl's only computer is the bots' computer, which is then switched off.
    set(h, VM, TERMINAL, "owl", true).unwrap();
    set(h, VM, DESKTOP, "owl", true).unwrap();
    set(h, HOST, TERMINAL, "owl", false).unwrap();
    common::update_config(h, |c| {
        c["computers"]["vm"]["off"] = json!(true);
        Ok(())
    })
    .unwrap();
    // Its tool list now looks as if both were off; saving another tool sends
    // it back as it was.
    let tools = crate::catalog::call(h, "alice", "hexbot.bots.get", &json!({"name":"owl"}))
        .expect("recognized method")
        .unwrap()["bot"]["tools"]
        .clone();
    assert!(
        !tools.as_array().unwrap().contains(&json!("terminal")),
        "{tools}"
    );
    assert!(
        !tools.as_array().unwrap().contains(&json!("computer_use")),
        "{tools}"
    );
    crate::catalog::call(
        h,
        "alice",
        "hexbot.bots.update",
        &json!({"name":"owl","tools":["files"]}),
    )
    .expect("recognized method")
    .unwrap();
    common::update_config(h, |c| {
        c["computers"]["vm"]["off"] = json!(false);
        Ok(())
    })
    .unwrap();
    assert!(has(h, "owl", VM, TERMINAL).unwrap());
    assert!(has(h, "owl", VM, DESKTOP).unwrap());
}

#[cfg(unix)]
#[test]
fn the_bots_computers_commands_run_in_bash_even_under_dash() {
    // Ubuntu's sh is dash: the tool is bash, so the command runs in bash.
    let line = vm_line(
        "dashbash",
        "source /dev/null && [[ 1 == 1 ]] && echo {1..3}",
    );
    assert!(line.contains("bash -c"));
    if !Path::new("/bin/dash").exists() {
        return;
    }
    let out = std::process::Command::new("/bin/dash")
        .arg("-c")
        .arg(line.replacen("setsid -w sh -c ", "/bin/dash -c ", 1))
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "1 2 3",
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn a_command_cut_off_by_its_time_limit_still_has_its_group_ended() {
    let ended = |code| {
        Ok(crate::computers::Output {
            code,
            stdout: String::new(),
            stderr: String::new(),
        })
    };
    assert!(finished(&ended(0)));
    assert!(finished(&ended(1)));
    // Cua's time limit leaves the command running in its own session.
    assert!(!finished(&ended(124)));
    assert!(!finished(&Err(Error::new(5200, "lost"))));
}

#[tokio::test]
async fn real_app_names_with_parentheses_launch() {
    let home = setup();
    let h = home.path();
    migrate(h).unwrap();
    set(h, "device:mac", DESKTOP, "owl", true).unwrap();
    for app in [
        "Outlook (new)",
        "Microsoft Teams (work or school)",
        "Notes",
        "draw.io",
        "LibreOffice Calc",
        "Google Chrome",
    ] {
        assert!(
            check_desktop(
                h,
                "alice",
                "owl",
                "s1",
                "device:mac",
                "off",
                &json!({"action":"launch","app":app}),
            )
            .await
            .is_ok(),
            "{app}"
        );
    }
}
