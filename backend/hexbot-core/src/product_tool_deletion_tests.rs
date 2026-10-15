//! Pause the real blocking product closure after admission, before its write.
use super::*;
use crate::{native_tools, server::App};
use std::sync::{Arc, OnceLock, mpsc};
use std::time::Duration;
use tokio::sync::oneshot;

struct Hooks {
    admitted: Option<(oneshot::Sender<()>, mpsc::Receiver<()>)>,
    waiting: Option<oneshot::Sender<()>>,
    finished: Option<oneshot::Sender<()>>,
}
fn hooks() -> &'static Mutex<HashMap<PathBuf, Hooks>> {
    static HOOKS: OnceLock<Mutex<HashMap<PathBuf, Hooks>>> = OnceLock::new();
    HOOKS.get_or_init(Default::default)
}
pub(crate) fn admitted(home: &Path) {
    let pause = hooks()
        .lock()
        .unwrap()
        .get_mut(home)
        .and_then(|h| h.admitted.take());
    if let Some((entered, resume)) = pause {
        let _ = entered.send(());
        let _ = resume.recv();
    }
}
pub(crate) fn deletion_waiting(home: &Path) {
    if let Some(sender) = hooks()
        .lock()
        .unwrap()
        .get_mut(home)
        .and_then(|h| h.waiting.take())
    {
        let _ = sender.send(());
    }
}
pub(crate) struct Finished<'a>(pub &'a Path);
impl Drop for Finished<'_> {
    fn drop(&mut self) {
        if let Some(sender) = hooks()
            .lock()
            .unwrap()
            .get_mut(self.0)
            .and_then(|h| h.finished.take())
        {
            let _ = sender.send(());
        }
    }
}
struct Pause {
    home: PathBuf,
    resume: Option<mpsc::Sender<()>>,
}
impl Pause {
    fn install(
        home: &Path,
    ) -> (
        Self,
        oneshot::Receiver<()>,
        oneshot::Receiver<()>,
        oneshot::Receiver<()>,
    ) {
        let (entered, admitted) = oneshot::channel();
        let (resume, release) = mpsc::channel();
        let (waiting, blocked) = oneshot::channel();
        let (finished, done) = oneshot::channel();
        hooks().lock().unwrap().insert(
            home.into(),
            Hooks {
                admitted: Some((entered, release)),
                waiting: Some(waiting),
                finished: Some(finished),
            },
        );
        (
            Self {
                home: home.into(),
                resume: Some(resume),
            },
            admitted,
            blocked,
            done,
        )
    }
    fn release(&mut self) {
        if let Some(resume) = self.resume.take() {
            let _ = resume.send(());
        }
    }
}
impl Drop for Pause {
    fn drop(&mut self) {
        self.release();
        hooks().lock().unwrap().remove(&self.home);
    }
}

const SKILL: &str = "---\nname: plan\ndescription: Use for planning.\n---\nOriginal skill.\n";
fn setup() -> (common::TestHome, Arc<App>, String) {
    let home = common::TestHome::new();
    let h = home.path();
    // Outside Tokio: no scheduler or description task, no Pi or provider.
    let app = App::new(
        h.into(),
        "127.0.0.1:0".parse().unwrap(),
        h.join("never-run-pi"),
        None,
    )
    .unwrap();
    let created = catalog::call(
        h,
        "local",
        "hexbot.bots.create",
        &json!({"name":"owl","description":"Fixture"}),
    )
    .unwrap()
    .unwrap();
    let root = created["section"]["id"].as_str().unwrap().to_owned();
    fs::write(
        h.join("profiles/owl/config.yaml"),
        "tools:\n  enabled_toolsets: [todo, skills]\n",
    )
    .unwrap();
    let conn = runtime_store::open(h).unwrap();
    let cwd = home.workspace();
    for (stored, options) in [
        (&root[..], json!({"cwd":cwd})),
        ("child", json!({"parent_session":root,"cwd":cwd})),
    ] {
        conn.execute(
            "INSERT INTO native_sessions VALUES(?,'local','owl','frozen',?)",
            params![stored, options.to_string()],
        )
        .unwrap();
    }
    let skill = h.join("profiles/owl/skills/plan/SKILL.md");
    fs::create_dir_all(skill.parent().unwrap()).unwrap();
    fs::write(skill, SKILL).unwrap();
    (home, app, root)
}
fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
async fn signal(receiver: oneshot::Receiver<()>) {
    tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .unwrap()
        .unwrap();
}

#[test]
fn admitted_todo_writes_settle_before_deletion() {
    for (child, route, purge) in [
        (false, "public", false),
        (true, "public", true),
        (true, "catalog", false),
        (true, "store", true),
        (true, "room", true),
        (true, "last-member", true),
    ] {
        check_deletion("todo_list", child, route, purge, false);
    }
}
#[test]
fn admitted_skill_writes_settle_before_deletion() {
    for (child, route, purge) in [
        (false, "public", false),
        (true, "public", true),
        (true, "catalog", true),
        (true, "bot", true),
    ] {
        check_deletion("skill_manage", child, route, purge, false);
    }
}
#[test]
fn cancelled_awaiter_keeps_the_blocking_product_guard() {
    for name in ["todo_list", "skill_manage"] {
        for (route, purge) in [
            ("public", false),
            ("public", true),
            ("catalog", false),
            ("bot", true),
            ("room", true),
            ("last-member", true),
        ] {
            check_deletion(name, true, route, purge, true);
        }
    }
}
fn check_deletion(
    name: &'static str,
    child: bool,
    route: &'static str,
    purge: bool,
    cancelled: bool,
) {
    eprintln!(
        "product deletion case: {name}, child={child}, {route}, purge={purge}, cancelled={cancelled}"
    );
    let (home, app, root) = setup();
    let room = if matches!(route, "room" | "last-member") {
        let created = crate::rooms::call(
            home.path(),
            "local",
            "hexbot.rooms.create",
            &json!({"name":"Room","members":["owl"]}),
        )
        .unwrap()
        .unwrap();
        let room = created["room"]["id"].as_str().unwrap().to_owned();
        db::open(home.path())
            .unwrap()
            .execute(
                "INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES(?,'owl',?)",
                params![room, root],
            )
            .unwrap();
        Some(room)
    } else {
        None
    };
    let source = if child { "child" } else { &root }.to_owned();
    let todo = home
        .path()
        .join("runtime/sessions")
        .join(&source)
        .join("todo.json");
    let skill = home.path().join("profiles/owl/skills/plan/SKILL.md");
    run(async {
        // Positive controls for both catalog and native-only sources.
        for stored in [&root[..], "child"] {
            native_tools::call(
                home.path(),
                "local",
                "owl",
                stored,
                "todo_list",
                &json!({"todos":[{"id":"first","content":"Original task","status":"pending"}]}),
            )
            .await
            .unwrap();
        }
        let args = if name == "todo_list" {
            json!({"todos":[{"id":"changed","content":"Admitted task","status":"pending"}]})
        } else {
            json!({"operations":[{"name":"plan","action":"patch","old_string":"Original skill.","new_string":"Admitted skill."}]})
        };
        let (mut pause, entered, waiting, finished) = Pause::install(home.path());
        let h = home.path().to_path_buf();
        let s = source.clone();
        let mut tool = Some(tokio::spawn(async move {
            native_tools::call(&h, "local", "owl", &s, name, &args).await
        }));
        signal(entered).await;
        if cancelled {
            // This drops product::call's awaiting future, while the
            // actual spawn_blocking closure still owns its guard.
            native_tools::close_session(home.path(), &source).await;
            assert_eq!(tool.take().unwrap().await.unwrap().unwrap_err().code, 5201);
        }
        let a = app.clone();
        let h = home.path().to_path_buf();
        let id = root.clone();
        let mut deletion = tokio::task::spawn_blocking(move || match route {
            "public" => run(a.call(
                "local",
                "hexbot.sections.delete",
                &json!({"id":id,"purge_memory":purge}),
            )),
            "bot" => run(a.call("local", "hexbot.bots.delete", &json!({"name":"owl"}))),
            "catalog" => catalog::call(
                &h,
                "local",
                "hexbot.sections.delete",
                &json!({"id":id,"purge_memory":purge}),
            )
            .unwrap(),
            "store" => runtime_store::delete(&h, &id).map(|()| json!({"deleted":true})),
            "room" => crate::rooms::delete(&h, room.as_deref().unwrap()),
            "last-member" => crate::rooms::remove_bot(&h, "local", room.as_deref().unwrap(), "owl"),
            _ => unreachable!(),
        });
        let early = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::select! {
                blocked = waiting => { blocked.unwrap(); None },
                result = &mut deletion => Some(result.unwrap().unwrap()),
            }
        })
        .await
        .unwrap();
        let at_return = if early.is_some() {
            Some((fs::read(&todo).ok(), fs::read(&skill).ok()))
        } else {
            // Waiting for the product closure must not reserve either SQLite
            // writer. The closure may itself need those databases to finish.
            for mut conn in [
                runtime_store::open(home.path()).unwrap(),
                db::open(home.path()).unwrap(),
            ] {
                conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .unwrap()
                    .rollback()
                    .unwrap();
            }
            None
        };
        pause.release();
        signal(finished).await;
        if let Some(tool) = tool {
            tool.await.unwrap().unwrap();
        }
        if let Some(before) = at_return {
            // Negative control verifies a real late filesystem write,
            // even when cancellation discarded the tool's reply.
            assert_eq!(
                before,
                (fs::read(&todo).ok(), fs::read(&skill).ok()),
                "late {name} write after {route} deletion returned, child={child}, cancelled={cancelled}"
            );
            panic!("deletion returned before admitted work settled");
        }
        deletion.await.unwrap().unwrap();
        if !purge {
            assert!(
                fs::read_to_string(&todo)
                    .unwrap()
                    .contains(if name == "todo_list" {
                        "Admitted task"
                    } else {
                        "Original task"
                    })
            );
        } else {
            assert!(!todo.exists());
        }
        if route == "bot" {
            assert!(!skill.exists());
        } else if name == "skill_manage" {
            assert!(
                fs::read_to_string(&skill)
                    .unwrap()
                    .contains("Admitted skill.")
            );
        }
        let settled = (fs::read(&todo).ok(), fs::read(&skill).ok());
        for (tool, args) in [
            ("todo_list", json!({"todos":[]})),
            (
                "skill_manage",
                json!({"operations":[{"name":"plan","action":"delete"}]}),
            ),
        ] {
            assert_eq!(
                super::call(home.path(), "local", "owl", &source, tool, &args)
                    .await
                    .unwrap()
                    .unwrap_err()
                    .code,
                if route == "bot" { 4205 } else { 4001 }
            );
        }
        assert_eq!(settled, (fs::read(&todo).ok(), fs::read(&skill).ok()));
        app.shutdown().await;
    });
    let before = (fs::read(&todo).ok(), fs::read(&skill).ok());
    let restarted = App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        home.path().join("never-run-pi"),
        None,
    )
    .unwrap();
    assert_eq!(before, (fs::read(&todo).ok(), fs::read(&skill).ok()));
    run(restarted.shutdown());
}
