//! The daemon's own screen, for the bots the user picked in Settings,
//! Computers. The daemon's `cua` drives it (`cua mcp --sandbox host`) once the
//! user has let it (`cua do-host-consent`); on macOS the system also asks for
//! Screen Recording and Accessibility.
//!
//! It is the user's real desktop, so it differs from the bots' computer in
//! three ways. The extension asks first, as the approval mode says. Bots
//! never click, type or press keys on Hexbot's own windows, in the app or a
//! browser, so a bot cannot answer its own approval card. And there is no
//! shell here: commands go through the terminal, in the workspace sandbox.
use super::{
    TURN_WAIT, command, display_name, overrides, paused_error, png_size, point, request_on,
    unavailable, with,
};
use crate::{Error, Result};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

/// The MCP connection name, one `cua mcp --sandbox host` per bot that uses it.
pub const SERVER: &str = "hexbot-host-screen";

/// Which screen: the daemon's own, or a computer a desktop app lent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Screen {
    Host,
    Device(String),
}

/// Each screen keeps its own turns, pause and screenshot size, apart from
/// the bots' computer's.
fn key(home: &Path, screen: &Screen) -> PathBuf {
    match screen {
        Screen::Host => home.join(".daemon-screen"),
        Screen::Device(device) => home.join(format!(".lent-screen-{device}")),
    }
}

/// Calls Cua's screen tools on one screen, within one bot's turn.
struct Driver<'a> {
    home: &'a Path,
    bot: &'a str,
    screen: &'a Screen,
    server: Option<Value>,
    turn: Arc<tokio::sync::OwnedMutexGuard<()>>,
}
impl Driver<'_> {
    async fn call(&self, tool: &str, params: Value) -> Result<Value> {
        match (self.screen, &self.server) {
            (Screen::Host, Some(server)) => {
                request_on(
                    SERVER, self.home, self.bot, server, tool, params, &self.turn,
                )
                .await
            }
            (Screen::Device(device), _) => {
                // The app relays the call to its own `cua mcp --sandbox host`.
                let result = crate::computer_lend::request(
                    self.home,
                    device,
                    "mcp",
                    json!({"tool": tool, "arguments": params}),
                )
                .await?;
                if result["isError"] == true {
                    return Err(Error::new(
                        4211,
                        format!(
                            "computer action {tool} failed: {}",
                            text_of(&result).unwrap_or_default()
                        ),
                    ));
                }
                Ok(result)
            }
            (Screen::Host, None) => Err(unavailable()),
        }
    }
}

fn text_of(result: &Value) -> Option<String> {
    result["content"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|part| part["text"].as_str())
        .map(str::to_owned)
}

fn server(home: &Path, bot: &str, cfg: &Value, env: &BTreeMap<String, String>) -> Result<Value> {
    Ok(json!({
        "command": command(cfg, env).ok_or_else(unavailable)?,
        "args": ["mcp", "--sandbox", "host", "--permissions", "computer:all"],
        "isolated_env": true,
        "env": overrides(cfg),
        "client_name": display_name(home, bot),
    }))
}

/// Let the daemon's `cua` act on this computer's desktop. The user chose it
/// in Settings, on a device they signed in with.
pub async fn consent(home: &Path) -> Result<()> {
    let (cfg, env) = super::setup(home)?;
    // Consent also points the user's own `cua do` at this desktop; Hexbot
    // names its target on every call, so the user's choice is put back.
    let target = cua_home(&env).join("do_target.json");
    let before = std::fs::read(&target).ok();
    let out = super::cua(&cfg, &env, &["do-host-consent", "--json"], 60).await;
    restore(&target, before);
    let out = out?;
    if out.code != 0 {
        return Err(super::failure(
            &out.stderr,
            "Cua could not get permission to use this screen.",
        ));
    }
    Ok(())
}

/// Cua keeps its state in `CUA_HOME`, or `~/.cua`.
fn cua_home(env: &BTreeMap<String, String>) -> PathBuf {
    env.get("CUA_HOME")
        .cloned()
        .or_else(|| std::env::var("CUA_HOME").ok())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".cua"))
}

/// Put a file back as it was: its old bytes, or gone if there were none.
fn restore(path: &Path, before: Option<Vec<u8>>) {
    let _ = match before {
        Some(bytes) => std::fs::write(path, bytes),
        None => std::fs::remove_file(path),
    };
}

fn text_json(result: &Value) -> Value {
    text_of(result)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null)
}

/// Hexbot's own windows: the app's, or a browser's showing it.
pub(crate) fn is_hexbot(window: &Value) -> bool {
    ["app", "app_name", "title"].iter().any(|field| {
        window[field]
            .as_str()
            .is_some_and(|text| text.to_lowercase().contains("hexbot"))
    })
}

fn refused() -> Error {
    Error::new(
        4302,
        "That lands on Hexbot's own window. Bots never click or type in Hexbot on the user's screen. Use another window, or ask the user.",
    )
}

/// Whether a screenshot point lands inside a window, given the screen's size
/// in points and the screenshot's in pixels.
pub(crate) fn inside(window: &Value, at: (i64, i64), screen: (f64, f64), shot: (f64, f64)) -> bool {
    let Some((left, top, width, height)) = frame(window) else {
        // A window without a frame might be anywhere: count it.
        return true;
    };
    let x = at.0 as f64 * screen.0 / shot.0.max(1.);
    let y = at.1 as f64 * screen.1 / shot.1.max(1.);
    x >= left && x <= left + width && y >= top && y <= top + height
}

/// A window's frame in screen points, as Cua reports it on Linux
/// (`position`, `size`) or macOS (`bounds`, a list or an object).
fn frame(window: &Value) -> Option<(f64, f64, f64, f64)> {
    let at = |list: &Value, i: usize| list.get(i).and_then(Value::as_f64);
    if let (Some(position), Some(size)) = (window.get("position"), window.get("size")) {
        return Some((
            at(position, 0)?,
            at(position, 1)?,
            at(size, 0)?,
            at(size, 1)?,
        ));
    }
    let bounds = window.get("bounds")?;
    if bounds.is_array() {
        return Some((
            at(bounds, 0)?,
            at(bounds, 1)?,
            at(bounds, 2)?,
            at(bounds, 3)?,
        ));
    }
    let field = |name: &str| bounds.get(name).and_then(Value::as_f64);
    Some((field("x")?, field("y")?, field("width")?, field("height")?))
}

/// The windows Cua listed: `{windows: [...]}` or a bare list, as text or
/// structured content. None when it can't be read, so the guard refuses.
fn windows(listed: &Value) -> Option<Vec<Value>> {
    let parsed = text_json(listed);
    [&parsed, &listed["structuredContent"]]
        .into_iter()
        .find_map(|value| {
            value
                .as_array()
                .or_else(|| value["windows"].as_array())
                .cloned()
        })
}

/// Refuse a click, drag, scroll or keystroke that would reach Hexbot.
async fn guard(driver: &Driver<'_>, action: &str, args: &Value) -> Result<()> {
    let keyboard = matches!(action, "type" | "key");
    let pointer = matches!(
        action,
        "click" | "double_click" | "right_click" | "middle_click" | "drag" | "scroll" | "move"
    );
    if !keyboard && !pointer {
        return Ok(());
    }
    let listed = driver.call("computer_window_list", json!({})).await?;
    // Unreadable means unknown: Hexbot may be under the pointer, so refuse.
    let Some(listed) = windows(&listed) else {
        return Err(Error::new(
            4302,
            "Hexbot couldn't read this screen's windows, so it won't click or type there. Try again, or ask the user.",
        ));
    };
    let ours = listed
        .into_iter()
        .filter(|window| is_hexbot(window) && window["state"] != "minimized")
        .collect::<Vec<_>>();
    if ours.is_empty() {
        return Ok(());
    }
    if ours.iter().any(|window| window["focused"] == true) {
        return Err(refused());
    }
    if keyboard {
        return Ok(());
    }
    let Some(shot) = with(&key(driver.home, driver.screen), |c| c.screen) else {
        return Err(Error::new(
            4302,
            "Take a screenshot of this screen first: coordinates are in the latest screenshot.",
        ));
    };
    let size = text_json(&driver.call("computer_get_screen_size", json!({})).await?);
    let screen = (
        size["size"]["width"].as_f64().unwrap_or(shot.0),
        size["size"]["height"].as_f64().unwrap_or(shot.1),
    );
    let points = [
        point(args, "coordinate").ok(),
        point(args, "from_coordinate").ok(),
        point(args, "to_coordinate").ok(),
    ];
    for at in points.into_iter().flatten() {
        if ours.iter().any(|window| inside(window, at, screen, shot)) {
            return Err(refused());
        }
    }
    Ok(())
}

/// One action on the daemon's screen or a lent one, translated by `act`.
#[allow(clippy::too_many_arguments)]
pub async fn act(
    home: &Path,
    bot: &str,
    cfg: &Value,
    env: &BTreeMap<String, String>,
    screen: Screen,
    action: &str,
    tool: &str,
    params: Value,
    args: &Value,
) -> Result<Value> {
    if action == "shell" {
        return Err(Error::new(
            4302,
            "There is no shell on this screen. Run commands on that computer with your terminal and its computer id, in its sandbox.",
        ));
    }
    let key = key(home, &screen);
    // Pause bots stops them on every screen, not only the bots' computer.
    let paused = || with(home, |c| c.paused) || with(&key, |c| c.paused);
    if paused() {
        return Err(paused_error());
    }
    let server = match screen {
        Screen::Host => {
            if command(cfg, env).is_none() {
                return Err(unavailable());
            }
            Some(server(home, bot, cfg, env)?)
        }
        Screen::Device(_) => None,
    };
    // One pointer and one focus: one action at a time.
    let turn = tokio::time::timeout(TURN_WAIT, super::turns(&key).lock_owned())
        .await
        .map_err(|_| Error::new(4209, "Another bot kept the screen busy. Try again."))?;
    let driver = Driver {
        home,
        bot,
        screen: &screen,
        server,
        turn: Arc::new(turn),
    };
    // The user may have paused the bots while this one waited its turn.
    if paused() {
        return Err(paused_error());
    }
    guard(&driver, action, args).await?;
    with(&key, |c| {
        c.actor = Some(bot.to_owned());
        c.activity = Some(action.to_owned());
    });
    let look = |result: Value| {
        if let Some(size) = png_size(&result) {
            with(&key, |c| c.screen = Some(size));
        }
        crate::native_tools::save_capture(home, bot, result)
    };
    // A scroll lands where the pointer is: put it where the guard looked.
    if action == "scroll"
        && let Ok((x, y)) = point(args, "coordinate")
    {
        driver
            .call("computer_move_cursor", json!({"x": x, "y": y}))
            .await?;
    }
    let result = match driver.call(tool, params).await {
        Ok(result) if action == "screenshot" => look(result),
        Ok(result) if args["capture_after"] == true => {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            driver
                .call("computer_screenshot", json!({}))
                .await
                .and_then(look)
                .map(|capture| {
                    let mut content = result["content"].as_array().cloned().unwrap_or_default();
                    content.extend(capture["content"].as_array().cloned().unwrap_or_default());
                    json!({"content":content,"screenshot_path":capture["screenshot_path"]})
                })
        }
        other => other,
    };
    with(&key, |c| {
        c.actor = None;
        c.activity = None;
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_users_own_cua_target_is_put_back() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("do_target.json");
        std::fs::write(&target, "host").unwrap();
        restore(&target, Some(b"dev".to_vec()));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "dev");
        restore(&target, None);
        assert!(!target.exists());
        let env = BTreeMap::from([("CUA_HOME".to_owned(), "/tmp/cua-x".to_owned())]);
        assert_eq!(cua_home(&env), PathBuf::from("/tmp/cua-x"));
    }

    #[test]
    fn hexbot_windows_are_known_by_app_or_title() {
        assert!(is_hexbot(&json!({"app":"Hexbot Nightly","title":"Owl"})));
        assert!(is_hexbot(
            &json!({"app":"Google Chrome","title":"Owl – Hexbot"})
        ));
        assert!(!is_hexbot(&json!({"app":"Safari","title":"Weather"})));
    }

    #[test]
    fn windows_are_read_in_either_shape_and_unreadable_means_refuse() {
        let text = |body: &str| json!({"content":[{"type":"text","text":body}]});
        assert_eq!(
            windows(&text(r#"{"windows":[{"app":"Hexbot"}]}"#))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            windows(&text(r#"[{"app_name":"Hexbot"}]"#)).unwrap().len(),
            1
        );
        assert_eq!(
            windows(&json!({"content":[],"structuredContent":{"windows":[]}}))
                .unwrap()
                .len(),
            0
        );
        assert!(windows(&text("not json")).is_none());
        assert!(is_hexbot(&json!({"app_name":"Hexbot Nightly"})));
        // macOS bounds, as a list or an object.
        let (screen, shot) = ((1280., 800.), (1280., 800.));
        assert!(inside(
            &json!({"bounds":[100, 100, 200, 100]}),
            (150, 150),
            screen,
            shot
        ));
        assert!(!inside(
            &json!({"bounds":{"x":100,"y":100,"width":200,"height":100}}),
            (50, 150),
            screen,
            shot
        ));
    }

    #[test]
    fn screenshot_points_map_onto_window_frames() {
        // A 1200 × 750 screenshot of a 1280 × 800 screen.
        let window = json!({"position":[100.0, 100.0],"size":[200.0, 100.0]});
        let (screen, shot) = ((1280., 800.), (1200., 750.));
        // 150 px is 160 points: inside. 90 px is 96 points: outside.
        assert!(inside(&window, (150, 150), screen, shot));
        assert!(!inside(&window, (90, 150), screen, shot));
        assert!(!inside(&window, (150, 300), screen, shot));
        // No frame: assume it could be under the point.
        assert!(inside(&json!({"app":"Hexbot"}), (5, 5), screen, shot));
    }
}
