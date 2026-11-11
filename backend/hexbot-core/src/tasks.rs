//! Google Tasks and Microsoft To Do behind one shape, for `hexbot_tasks`.
//! A task belongs to a list; both services name a task by its list and its
//! own id, so every task a bot is shown carries both.
use crate::{
    Error, Result,
    accounts::{self, Service, enc},
};
use chrono::{Duration, NaiveDate, NaiveDateTime};
use reqwest::Method;
use serde_json::{Value, json};
use std::path::Path;

const MAX_TASKS: usize = 100;
/// Lists read when a bot names none.
const MAX_LISTS: usize = 20;
const NOTE_CAP: usize = 4_000;
/// Pages of one list read before giving up on its end: 1,000 tasks.
const MAX_PAGES: usize = 10;

async fn call(
    home: &Path,
    svc: &Service,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    asked(home, svc, method, path, body, "").await
}

/// As `call`, with To Do asked to write its times in `zone`.
async fn asked(
    home: &Path,
    svc: &Service,
    method: Method,
    path: &str,
    body: Option<&Value>,
    zone: &str,
) -> Result<Value> {
    let prefer = format!("outlook.timezone=\"{zone}\"");
    let headers = [("Prefer", prefer.as_str())];
    let headers: &[(&str, &str)] = if zone.is_empty() { &[] } else { &headers };
    accounts::api(
        home, svc, None, method, svc.api, path, body, headers, "task",
    )
    .await
}

/// The zone To Do keeps the user's due dates in: a due day is the midnight
/// that starts it there, so it is read and written in that zone. Empty for
/// Google, whose due days are plain dates, and when the zone can't be read.
async fn zone(home: &Path, svc: &Service) -> String {
    if svc.google() {
        return String::new();
    }
    crate::calendar::outlook_zone(home, svc)
        .await
        .unwrap_or_default()
}

fn id(value: &str, what: &str) -> Result<String> {
    if value.is_empty() || value.len() > 1_024 {
        return Err(Error::new(4202, format!("{what} must be an id from list")));
    }
    Ok(enc(value))
}

/// The user's task lists, the default one first.
pub(crate) async fn lists(home: &Path, svc: &Service) -> Result<Vec<Value>> {
    if svc.google() {
        let found = call(
            home,
            svc,
            Method::GET,
            "/tasks/v1/users/@me/lists?maxResults=100",
            None,
        )
        .await?;
        // Google lists the default one first.
        return Ok(found["items"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(i, l)| json!({"id": l["id"], "name": l["title"], "default": i == 0}))
            .collect());
    }
    let found = call(home, svc, Method::GET, "/v1.0/me/todo/lists?$top=100", None).await?;
    let mut lists: Vec<Value> = found["value"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|l| {
            json!({
                "id": l["id"],
                "name": l["displayName"],
                "default": l["wellknownListName"] == "defaultList",
            })
        })
        .collect();
    lists.sort_by_key(|l| l["default"] != true);
    Ok(lists)
}

/// The list a call means: the one named, or the default.
async fn list_id(home: &Path, svc: &Service, list: Option<&str>) -> Result<String> {
    match list.filter(|l| !l.is_empty()) {
        Some(list) => id(list, "list"),
        None if svc.google() => Ok("@default".to_owned()),
        None => lists(home, svc)
            .await?
            .first()
            .and_then(|l| l["id"].as_str().map(enc))
            .ok_or_else(|| Error::new(4215, "Microsoft To Do has no task list yet.")),
    }
}

fn capped(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= NOTE_CAP {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(NOTE_CAP).collect();
    cut.push_str(" […]");
    cut
}

fn day(text: &str) -> &str {
    text.get(..10).unwrap_or(text)
}

fn google_task(t: &Value, list: &Value) -> Value {
    json!({
        "id": t["id"],
        "list": list["id"],
        "list_name": list["name"],
        "title": t["title"].as_str().unwrap_or(""),
        "notes": capped(t["notes"].as_str().unwrap_or("")),
        "due": day(t["due"].as_str().unwrap_or("")),
        "done": t["status"] == "completed",
        "subtask": t["parent"].is_string(),
        "link": t["webViewLink"].as_str().unwrap_or(""),
    })
}

/// The day a To Do task is due. Written in the user's zone, as asked, it
/// is the day it says. Still written in UTC, it is the midnight that starts
/// the day where the user is, some hours either side of UTC's own: from
/// 11:00 on it is the next day's, which is right from UTC-10 to UTC+13.
fn graph_day(due: &Value) -> String {
    let text = due["dateTime"].as_str().unwrap_or("");
    if due["timeZone"] != "UTC" {
        return day(text).to_owned();
    }
    match NaiveDateTime::parse_from_str(text.get(..19).unwrap_or(text), "%Y-%m-%dT%H:%M:%S") {
        Ok(at) => (at + Duration::hours(13)).date().to_string(),
        Err(_) => day(text).to_owned(),
    }
}

fn graph_task(t: &Value, list: &Value) -> Value {
    let notes = t["body"]["content"].as_str().unwrap_or("");
    let notes = if t["body"]["contentType"] == "html" {
        crate::mail::html_text(notes)
    } else {
        notes.to_owned()
    };
    json!({
        "id": t["id"],
        "list": list["id"],
        "list_name": list["name"],
        "title": t["title"].as_str().unwrap_or(""),
        "notes": capped(&notes),
        "due": graph_day(&t["dueDateTime"]),
        "done": t["status"] == "completed",
        "important": t["importance"] == "high",
    })
}

/// Every task of one list from `first`, a page at a time, and whether the
/// list went on past the pages read. Neither service sorts by due date, so
/// the soonest can only be picked from the whole list.
async fn pages(home: &Path, svc: &Service, first: &str, zone: &str) -> Result<(Vec<Value>, bool)> {
    let mut rows = vec![];
    let mut path = first.to_owned();
    for _ in 0..MAX_PAGES {
        let answer = asked(home, svc, Method::GET, &path, None, zone).await?;
        let (key, next) = if svc.google() {
            (
                "items",
                answer["nextPageToken"]
                    .as_str()
                    .map(|token| format!("{first}&pageToken={}", enc(token))),
            )
        } else {
            // Graph gives the next page's whole address; its path is asked for.
            (
                "value",
                answer["@odata.nextLink"]
                    .as_str()
                    .and_then(|link| link.find("/v1.0/").map(|at| link[at..].to_owned())),
            )
        };
        rows.extend(answer[key].as_array().cloned().unwrap_or_default());
        match next {
            Some(next) => path = next,
            None => return Ok((rows, false)),
        }
    }
    Ok((rows, true))
}

/// Tasks in `list`, or in every list when none is named. Finished ones
/// only when `done` asks for them.
pub(crate) async fn list(
    home: &Path,
    svc: &Service,
    list: Option<&str>,
    done: bool,
    max: usize,
) -> Result<Value> {
    let max = max.clamp(1, MAX_TASKS);
    let all = lists(home, svc).await?;
    let chosen: Vec<&Value> = match list.filter(|l| !l.is_empty()) {
        Some(want) => vec![all.iter().find(|l| l["id"] == want).ok_or_else(|| {
            Error::new(
                4215,
                format!("{} has no such list. lists shows them.", svc.name),
            )
        })?],
        None => all.iter().take(MAX_LISTS).collect(),
    };
    let paths = chosen
        .iter()
        .map(|l| {
            let list = enc(l["id"].as_str().unwrap_or(""));
            if svc.google() {
                format!(
                    "/tasks/v1/lists/{list}/tasks?maxResults=100&showCompleted={done}&showHidden={done}"
                )
            } else if done {
                format!("/v1.0/me/todo/lists/{list}/tasks?$top=100")
            } else {
                format!(
                    "/v1.0/me/todo/lists/{list}/tasks?$top=100&$filter={}",
                    enc("status ne 'completed'")
                )
            }
        })
        .collect::<Vec<_>>();
    let zone = zone(home, svc).await;
    let answers =
        futures_util::future::join_all(paths.iter().map(|path| pages(home, svc, path, &zone)))
            .await;
    let mut tasks = vec![];
    let mut cut = false;
    for (list, answer) in chosen.iter().zip(answers) {
        let (rows, went_on) = answer?;
        cut |= went_on;
        for row in &rows {
            tasks.push(if svc.google() {
                google_task(row, list)
            } else {
                graph_task(row, list)
            });
        }
    }
    // Open ones first, the soonest due at the top, undated ones after.
    tasks.sort_by_key(|t| {
        let due = t["due"].as_str().unwrap_or("");
        (t["done"] == true, due.is_empty(), due.to_owned())
    });
    let more = cut || tasks.len() > max;
    tasks.truncate(max);
    let mut out = json!({"account": svc.provider.id, "tasks": tasks, "more": more});
    // Lists past the cap are named: a bot must not take them for empty.
    if list.is_none_or(str::is_empty) && all.len() > MAX_LISTS {
        out["lists_not_read"] = all[MAX_LISTS..].iter().map(|l| l["name"].clone()).collect();
    }
    Ok(out)
}

/// What a bot asks a task to be. A field left out of a change stays.
#[derive(Debug, Default)]
pub(crate) struct Change {
    pub title: Option<String>,
    pub notes: Option<String>,
    /// A date, or empty to clear it.
    pub due: Option<String>,
    pub done: Option<bool>,
}

impl Change {
    pub(crate) fn parse(p: &Value) -> Result<Self> {
        let text = |key: &str, cap: usize| -> Result<Option<String>> {
            match &p[key] {
                Value::Null => Ok(None),
                Value::String(v) if v.chars().count() <= cap => Ok(Some(v.clone())),
                Value::String(_) => Err(Error::new(4202, format!("{key} is too long"))),
                _ => Err(Error::new(4202, format!("{key} must be text"))),
            }
        };
        let due = text("due", 32)?.map(|d| d.trim().to_owned());
        if let Some(due) = due.as_deref().filter(|d| !d.is_empty())
            && NaiveDate::parse_from_str(due, "%Y-%m-%d").is_err()
        {
            return Err(Error::new(4202, "due must be a date like 2026-11-12"));
        }
        Ok(Change {
            title: text("title", 1_000)?,
            notes: text("notes", 8_000)?,
            due,
            done: match &p["done"] {
                Value::Null => None,
                Value::Bool(done) => Some(*done),
                _ => return Err(Error::new(4202, "done must be true or false")),
            },
        })
    }

    /// Whether To Do's zone has to be looked up: for a due day.
    fn dated(&self) -> bool {
        self.due.as_deref().is_some_and(|due| !due.is_empty())
    }

    /// The change as the service takes it. `zone` is the one a To Do due
    /// day starts in.
    fn body(&self, google: bool, zone: &str) -> Value {
        let mut body = json!({});
        if let Some(title) = &self.title {
            body["title"] = json!(title);
        }
        if let Some(notes) = &self.notes {
            if google {
                body["notes"] = json!(notes);
            } else {
                body["body"] = json!({"content": notes, "contentType": "text"});
            }
        }
        if let Some(due) = &self.due {
            // Google keeps a due day as a midnight in UTC, To Do as the
            // midnight that starts it where the user is.
            body[if google { "due" } else { "dueDateTime" }] = match (due.is_empty(), google) {
                (true, _) => Value::Null,
                (false, true) => json!(format!("{due}T00:00:00.000Z")),
                (false, false) => json!({
                    "dateTime": format!("{due}T00:00:00"),
                    "timeZone": if zone.is_empty() { "UTC" } else { zone },
                }),
            };
        }
        if let Some(done) = self.done {
            if google {
                body["status"] = json!(if done { "completed" } else { "needsAction" });
                if !done {
                    // Google keeps a reopened task finished while this is set.
                    body["completed"] = Value::Null;
                }
            } else {
                body["status"] = json!(if done { "completed" } else { "notStarted" });
            }
        }
        body
    }
}

fn path(google: bool, list: &str, task: Option<&str>) -> String {
    let base = if google {
        format!("/tasks/v1/lists/{list}/tasks")
    } else {
        format!("/v1.0/me/todo/lists/{list}/tasks")
    };
    match task {
        Some(task) => format!("{base}/{task}"),
        None => base,
    }
}

pub(crate) async fn add(
    home: &Path,
    svc: &Service,
    change: &Change,
    list: Option<&str>,
) -> Result<Value> {
    if change.title.as_deref().unwrap_or("").trim().is_empty() {
        return Err(Error::new(4202, "A task needs a title."));
    }
    let list = list_id(home, svc, list).await?;
    let zone = if change.dated() {
        zone(home, svc).await
    } else {
        String::new()
    };
    let made = call(
        home,
        svc,
        Method::POST,
        &path(svc.google(), &list, None),
        Some(&change.body(svc.google(), &zone)),
    )
    .await?;
    Ok(json!({"id": made["id"], "title": made["title"]}))
}

pub(crate) async fn update(
    home: &Path,
    svc: &Service,
    task: &str,
    change: &Change,
    list: Option<&str>,
) -> Result<Value> {
    let task = id(task, "id")?;
    let zone = if change.dated() {
        zone(home, svc).await
    } else {
        String::new()
    };
    let body = change.body(svc.google(), &zone);
    if body.as_object().is_none_or(|b| b.is_empty()) {
        return Err(Error::new(4202, "Name what to change."));
    }
    let list = list_id(home, svc, list).await?;
    let done = call(
        home,
        svc,
        Method::PATCH,
        &path(svc.google(), &list, Some(&task)),
        Some(&body),
    )
    .await?;
    Ok(json!({
        "id": done["id"],
        "title": done["title"],
        "done": done["status"] == "completed",
    }))
}

/// Deletes the task `id`, once `title` is what it is called: the approval
/// the user gave names a title, and a wrong id must not delete another.
pub(crate) async fn delete(
    home: &Path,
    svc: &Service,
    task: &str,
    title: &str,
    list: Option<&str>,
) -> Result<Value> {
    let task = id(task, "id")?;
    let list = list_id(home, svc, list).await?;
    let path = path(svc.google(), &list, Some(&task));
    let found = call(home, svc, Method::GET, &path, None).await?;
    let actual = found["title"].as_str().unwrap_or("");
    if !actual.trim().eq_ignore_ascii_case(title.trim()) {
        return Err(Error::new(
            4202,
            format!(
                "That id is the task \"{actual}\", not \"{}\". Pass its title to delete it.",
                title.trim()
            ),
        ));
    }
    call(home, svc, Method::DELETE, &path, None).await?;
    Ok(json!({"deleted": true, "title": actual}))
}

#[cfg(test)]
#[path = "tasks_tests.rs"]
mod tests;
