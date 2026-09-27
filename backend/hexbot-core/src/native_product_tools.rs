//! Session plans, history recall, and bot-owned skill files.
use crate::{Error, Result, catalog, common, connectors, db, runtime_store};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

fn text<'a>(p: &'a Value, key: &str) -> &'a str {
    p[key].as_str().unwrap_or("")
}
fn descriptor(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name":name,"description":description,"readOnly":name!="skill_manage","parameters":{"type":"object","properties":properties,"required":required}})
}
pub fn descriptors(home: &Path, bot: &str) -> Result<Vec<Value>> {
    let enabled = connectors::toolsets(home, bot)?;
    let mut tools = vec![];
    if enabled.iter().any(|s| s == "todo") {
        tools.push(descriptor("todo_list","Track multi-step work. Omit todos to read. Writes replace the list unless merge is true. Complete tasks only after verifying them.",json!({"todos":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"content":{"type":"string"},"status":{"type":"string","enum":["pending","in_progress","completed","cancelled"]},"parent":{"type":"string"}},"required":["id","content","status"]}},"merge":{"type":"boolean"}}),&[]));
    }
    if enabled.iter().any(|s| s == "session_search") {
        tools.push(descriptor("session_search","Recall earlier conversations. Query searches history; session_id reads it; add around_message_id to scroll. No arguments browses recent conversations. This does not search external sources.",json!({"query":{"type":"string"},"limit":{"type":"integer","default":3,"maximum":10},"sort":{"type":"string","enum":["newest","oldest"]},"detail":{"type":"string","enum":["adaptive","full"]},"session_id":{"type":"string"},"around_message_id":{"type":"integer"},"window":{"type":"integer","default":5,"maximum":20},"role_filter":{"type":"string"},"profile":{"type":"string"}}),&[]));
    }
    if enabled.iter().any(|s| s == "skills") {
        tools.push(descriptor(
            "skills_list",
            "List available skill names and descriptions. Use skill_view to load a skill.",
            json!({"category":{"type":"string"}}),
            &[],
        ));
        tools.push(descriptor("skill_view","Read a skill or a file inside it. Omit file_path to read SKILL.md and list supporting files.",json!({"name":{"type":"string"},"file_path":{"type":"string"}}),&["name"]));
        tools.push(descriptor("skill_manage","Create, patch, or delete bot skills. Operations apply as one batch. Inherited skills are copied into this bot before editing.",json!({"operations":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"action":{"type":"string","enum":["create","patch","delete","write_file","remove_file"]},"content":{"type":"string"},"category":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"replace_all":{"type":"boolean"},"file_path":{"type":"string"},"file_content":{"type":"string"}},"required":["name","action"]}}}),&["operations"]));
    }
    Ok(tools)
}
fn ensure_session(home: &Path, owner: &str, bot: &str, session: &str) -> Result<()> {
    common::bot_session_access(home, owner, bot, session)?;
    common::identifier(session)?;
    let actual: Option<(String, String)> = runtime_store::open(home)?
        .query_row(
            "SELECT owner,bot FROM native_sessions WHERE stored_id=?",
            [session],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if actual
        .as_ref()
        .is_some_and(|(who, name)| who != owner || name != bot)
    {
        return Err(Error::new(4302, "not the session owner"));
    }
    let row: Option<(String, String)> = db::open(home)?
        .query_row(
            "SELECT owner_id,bot FROM sections WHERE id=?",
            [session],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if row
        .as_ref()
        .is_some_and(|(who, name)| who != owner || name != bot)
        || (actual.is_none() && row.is_none())
    {
        return Err(Error::new(4302, "not the session owner"));
    }
    Ok(())
}
fn todo_path(home: &Path, session: &str) -> Result<PathBuf> {
    common::identifier(session)?;
    let path = home
        .join("runtime/sessions")
        .join(session)
        .join("todo.json");
    safe_path(home, &path)?;
    Ok(path)
}
fn read_todos(home: &Path, session: &str) -> Result<Value> {
    let path = todo_path(home, session)?;
    if !path.try_exists()? {
        return Ok(json!({"todos":[],"revision":0}));
    }
    serde_json::from_slice(&common::read_regular(&path, 4 * 1024 * 1024)?)
        .map_err(|_| Error::new(5200, "invalid saved task list"))
}
fn normalize_item(p: &Value) -> Value {
    let id = text(p, "id").trim();
    let description = text(p, "content").trim();
    let status = text(p, "status").trim().to_lowercase();
    let mut content = description.chars().take(4000).collect::<String>();
    if description.chars().count() > 4000 {
        content = description.chars().take(3987).collect::<String>() + "… [truncated]";
    }
    let mut out = json!({"id":if id.is_empty(){"?"}else{id},"content":if content.is_empty(){"(no description)"}else{&content},"status":if matches!(status.as_str(),"pending"|"in_progress"|"completed"|"cancelled"){&status}else{"pending"}});
    let parent = text(p, "parent").trim();
    if !parent.is_empty() && parent != id {
        out["parent"] = json!(parent)
    }
    out
}
fn sanitize_todos(items: &mut [Value]) {
    let parents = items
        .iter()
        .map(|p| (text(p, "id").to_owned(), text(p, "parent").to_owned()))
        .collect::<HashMap<_, _>>();
    for item in items {
        let mut seen = BTreeSet::from([text(item, "id").to_owned()]);
        let mut cursor = text(item, "parent").to_owned();
        while !cursor.is_empty() {
            if !parents.contains_key(&cursor) || !seen.insert(cursor.clone()) {
                item.as_object_mut().unwrap().remove("parent");
                break;
            }
            cursor = parents.get(&cursor).cloned().unwrap_or_default();
        }
    }
}
fn todo(home: &Path, session: &str, p: &Value) -> Result<Value> {
    static LOCK: Mutex<()> = Mutex::new(());
    let _lock = LOCK
        .lock()
        .map_err(|_| Error::new(5200, "task list lock unavailable"))?;
    let mut state = read_todos(home, session)?;
    let original = state["todos"].as_array().cloned().unwrap_or_default();
    let mut items = original.clone();
    if p.get("todos").is_some_and(|v| !v.is_null()) {
        let raw = if let Some(raw) = p["todos"].as_str() {
            serde_json::from_str(raw)
                .map_err(|_| Error::new(4200, "todos must be an array of objects"))?
        } else {
            p["todos"].clone()
        };
        let raw = raw
            .as_array()
            .ok_or_else(|| Error::new(4200, "todos must be an array of objects"))?;
        let mut last = HashMap::new();
        for (index, row) in raw.iter().enumerate() {
            last.insert(text(&normalize_item(row), "id").to_owned(), index);
        }
        if p["merge"] != true {
            items.clear();
        }
        for (index, row) in raw.iter().enumerate() {
            let normalized = normalize_item(row);
            let id = text(&normalized, "id");
            if last.get(id) != Some(&index) {
                continue;
            }
            if p["merge"] == true
                && let Some(existing) = items.iter_mut().find(|v| v["id"] == id)
            {
                for key in ["content", "status"] {
                    if row.get(key).is_some()
                        && !text(row, key).is_empty()
                        && (key != "status"
                            || matches!(
                                text(row, key).trim().to_lowercase().as_str(),
                                "pending" | "in_progress" | "completed" | "cancelled"
                            ))
                    {
                        existing[key] = normalized[key].clone()
                    }
                }
                if row.get("parent").is_some() {
                    if normalized.get("parent").is_some() {
                        existing["parent"] = normalized["parent"].clone()
                    } else {
                        existing.as_object_mut().unwrap().remove("parent");
                    }
                }
            } else if p["merge"] != true || !text(row, "id").trim().is_empty() {
                items.push(normalized);
            }
        }
        if !items.iter().any(|v| v.get("parent").is_some())
            && let Some(active) = items.iter().position(|v| v["status"] == "in_progress")
            && let Some(pending) = items[..active]
                .iter()
                .position(|v| v["status"] == "pending")
        {
            let item = items.remove(active);
            items.insert(pending, item);
        }
        items.truncate(256);
        sanitize_todos(&mut items);
        if items != original {
            state["revision"] = json!(state["revision"].as_u64().unwrap_or(0) + 1);
            state["todos"] = json!(items);
            common::atomic_write(&todo_path(home, session)?, state.to_string().as_bytes())?;
        }
    }
    let mut summary = json!({"total":items.len()});
    for status in ["pending", "in_progress", "completed", "cancelled"] {
        summary[status] = json!(items.iter().filter(|v| v["status"] == status).count());
    }
    state["summary"] = summary;
    Ok(state)
}
pub fn todo_context(home: &Path, session: &str) -> Result<Option<String>> {
    let state = read_todos(home, session)?;
    let items = state["todos"].as_array().cloned().unwrap_or_default();
    let by_id = items
        .iter()
        .map(|v| (text(v, "id"), v))
        .collect::<HashMap<_, _>>();
    let mut keep = BTreeSet::new();
    for item in &items {
        if matches!(text(item, "status"), "pending" | "in_progress") {
            let mut id = text(item, "id");
            while !id.is_empty() && keep.insert(id) {
                id = by_id.get(id).map(|v| text(v, "parent")).unwrap_or("");
            }
        }
    }
    if keep.is_empty() {
        return Ok(None);
    }
    let mut output =
        String::from("[Your active task list was preserved across context compression]\n");
    for item in &items {
        if keep.contains(text(item, "id")) {
            output.push_str(&format!(
                "- {}. {} ({})\n",
                text(item, "id"),
                text(item, "content"),
                text(item, "status")
            ));
        }
    }
    Ok(Some(output))
}

fn relative(value: &str) -> Result<PathBuf> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || value.contains('\\')
    {
        return Err(Error::new(
            4202,
            "path must stay inside the skill directory",
        ));
    }
    Ok(path.to_path_buf())
}
fn safe_path(root: &Path, path: &Path) -> Result<()> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| Error::new(4202, "path is outside the bot directory"))?;
    let mut cursor = root.to_path_buf();
    for part in relative.components() {
        if !matches!(part, Component::Normal(_)) {
            return Err(Error::new(4202, "invalid skill path"));
        }
        cursor.push(part);
        if fs::symlink_metadata(&cursor).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(Error::new(4202, "skill paths must not contain symlinks"));
        }
    }
    Ok(())
}
fn frontmatter(content: &str) -> (Value, String) {
    let source = content.trim_start_matches('\u{feff}');
    if let Some(rest) = source.strip_prefix("---\n")
        && let Some((yaml, body)) = rest.split_once("\n---")
    {
        return (
            serde_yaml::from_str(yaml).unwrap_or_else(|_| json!({})),
            body.trim_start().to_owned(),
        );
    }
    (json!({}), source.to_owned())
}
fn skill_rows(home: &Path, bot: &str) -> Result<Vec<Value>> {
    let mut rows = vec![];
    for row in catalog::enabled_skills(home, bot)? {
        let (meta, body) = frontmatter(text(&row, "content"));
        let name = meta["name"].as_str().unwrap_or(text(&row, "name"));
        let description = meta["description"]
            .as_str()
            .or_else(|| {
                body.lines()
                    .find(|s| !s.trim().is_empty() && !s.trim_start().starts_with('#'))
            })
            .unwrap_or("");
        let path = PathBuf::from(text(&row, "path"));
        let category = path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|s| s.to_str())
            .filter(|s| *s != "skills");
        rows.push(json!({"name":name,"description":description.chars().take(1000).collect::<String>(),"category":category,"path":path,"content":row["content"],"frontmatter":meta}));
    }
    Ok(rows)
}
fn find_skill(home: &Path, bot: &str, name: &str) -> Result<Value> {
    skill_rows(home, bot)?
        .into_iter()
        .find(|s| s["name"] == name)
        .ok_or_else(|| Error::new(4205, format!("skill not found: {name}")))
}
fn list_skills(home: &Path, bot: &str, p: &Value) -> Result<Value> {
    let category = text(p, "category");
    let mut skills = skill_rows(home, bot)?
        .into_iter()
        .filter(|s| category.is_empty() || s["category"] == category)
        .map(|mut s| {
            let object = s.as_object_mut().unwrap();
            object.remove("content");
            object.remove("frontmatter");
            object.remove("path");
            s
        })
        .collect::<Vec<_>>();
    skills.sort_by_key(|s| (text(s, "category").to_owned(), text(s, "name").to_owned()));
    let categories = skills
        .iter()
        .filter_map(|s| s["category"].as_str())
        .collect::<BTreeSet<_>>();
    Ok(
        json!({"success":true,"skills":skills,"categories":categories,"count":skills.len(),"hint":"Use skill_view(name) to see full content and linked files."}),
    )
}
fn walk_files(root: &Path, path: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    safe_path(root, path)?;
    if !path.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(Error::new(4202, "skill paths must not contain symlinks"));
        }
        if kind.is_dir() {
            walk_files(root, &entry.path(), out)?
        } else if kind.is_file() {
            out.push(entry.path());
            if out.len() > 2000 {
                return Err(Error::new(4202, "skill contains too many files"));
            }
        }
    }
    Ok(())
}
fn view_skill(home: &Path, bot: &str, p: &Value) -> Result<Value> {
    let row = find_skill(home, bot, common::required(p, "name")?)?;
    let main = PathBuf::from(text(&row, "path"));
    let dir = main
        .parent()
        .ok_or_else(|| Error::new(4202, "invalid skill directory"))?;
    let requested = text(p, "file_path");
    let path = if requested.is_empty() {
        main.clone()
    } else {
        dir.join(relative(requested)?)
    };
    safe_path(home, &path)?;
    let metadata = fs::metadata(&path)?;
    if !metadata.is_file() {
        return Err(Error::new(4202, "skill path is not a regular file"));
    }
    if metadata.len() > 2 * 1024 * 1024 {
        return Err(Error::new(4202, "skill file exceeds 2 MiB"));
    }
    let content = common::read_regular_text(&path, 1024 * 1024)?;
    if !requested.is_empty() {
        return Ok(
            json!({"success":true,"name":row["name"],"file_path":requested,"content":content,"path":path}),
        );
    }
    let mut files = vec![];
    walk_files(home, dir, &mut files)?;
    let mut linked = json!({});
    for file in files {
        let rel = file
            .strip_prefix(dir)
            .unwrap()
            .to_string_lossy()
            .to_string();
        if rel == "SKILL.md" {
            continue;
        }
        let category = rel.split('/').next().unwrap_or("files");
        if !linked[category].is_array() {
            linked[category] = json!([])
        }
        linked[category].as_array_mut().unwrap().push(json!(rel));
    }
    let meta = &row["frontmatter"];
    let mut required = BTreeSet::new();
    for list in [
        &meta["required_environment_variables"],
        &meta["metadata"]["hermes"]["requires"]["env"],
    ] {
        if let Some(values) = list.as_array() {
            for v in values {
                if let Some(name) = v.as_str().or_else(|| v["name"].as_str()) {
                    required.insert(name.to_owned());
                }
            }
        }
    }
    let env = connectors::credentials(home, bot)?;
    let missing = required
        .iter()
        .filter(|key| {
            !env.get(*key).is_some_and(|v| !v.is_empty())
                && std::env::var(key).unwrap_or_default().is_empty()
        })
        .cloned()
        .collect::<Vec<_>>();
    Ok(
        json!({"success":true,"name":row["name"],"description":row["description"],"content":content,"path":main,"skill_dir":dir,"tags":meta["tags"],"related_skills":meta["related_skills"],"linked_files":linked,"required_environment_variables":required,"missing_required_environment_variables":missing,"required_commands":[],"missing_required_commands":[],"setup_needed":!missing.is_empty(),"setup_skipped":false,"readiness_status":if missing.is_empty(){"available"}else{"setup_needed"}}),
    )
}
fn copy_tree(home: &Path, source: &Path, dest: &Path) -> Result<()> {
    let mut files = vec![];
    walk_files(home, source, &mut files)?;
    fs::create_dir_all(dest)?;
    for path in files {
        if fs::metadata(&path)?.len() > 8 * 1024 * 1024 {
            return Err(Error::new(4202, "skill file exceeds 8 MiB"));
        }
        let target = dest.join(path.strip_prefix(source).unwrap());
        fs::create_dir_all(target.parent().unwrap())?;
        fs::copy(path, target)?;
    }
    Ok(())
}
fn valid_skill_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(Error::new(
            4202,
            "skill name must use lowercase letters, digits, hyphens or underscores, up to 64 characters",
        ));
    }
    Ok(())
}
fn valid_skill_content(content: &str) -> Result<()> {
    if content.len() > 2 * 1024 * 1024 {
        return Err(Error::new(4202, "skill content exceeds 2 MiB"));
    }
    let normalized = content.replace("\r\n", "\n");
    let (meta, body) = frontmatter(&normalized);
    if text(&meta, "description").trim().is_empty() || body.trim().is_empty() {
        return Err(Error::new(
            4200,
            "SKILL.md needs YAML frontmatter with a description and a Markdown body",
        ));
    }
    Ok(())
}
fn manage_skills(home: &Path, bot: &str, p: &Value) -> Result<Value> {
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK
        .lock()
        .map_err(|_| Error::new(5200, "skills lock unavailable"))?;
    let ops = if let Some(ops) = p["operations"].as_array() {
        ops.clone()
    } else if p.get("action").is_some() {
        vec![p.clone()]
    } else {
        return Err(Error::new(4200, "operations is required"));
    };
    if ops.is_empty() || ops.len() > 100 {
        return Err(Error::new(4200, "operations must contain 1 to 100 edits"));
    }
    if ops.len() > 1 && ops.iter().any(|op| op["action"] == "delete") {
        return Err(Error::new(4200, "delete must be the only operation"));
    }
    let profile = catalog::profile(home, bot)?;
    fs::create_dir_all(&profile)?;
    let stage = tempfile::tempdir_in(&profile)?;
    let mut touched: BTreeMap<String, (PathBuf, PathBuf, bool)> = BTreeMap::new();
    let mut results = vec![];
    let mut cfg = common::read_config(&profile)?;
    let old_cfg = cfg.clone();
    for (index, op) in ops.iter().enumerate() {
        let name = common::required(op, "name")?;
        valid_skill_name(name)?;
        let action = common::required(op, "action")?;
        if !touched.contains_key(name) {
            let existing = find_skill(home, bot, name).ok();
            let destination = if let Some(row) = &existing {
                let path = PathBuf::from(text(row, "path"));
                if path.starts_with(profile.join("skills")) {
                    path.parent().unwrap().to_path_buf()
                } else {
                    profile.join("skills").join(name)
                }
            } else {
                let category = text(op, "category");
                let root = if category.is_empty() {
                    profile.join("skills")
                } else {
                    profile.join("skills").join(relative(category)?)
                };
                root.join(name)
            };
            safe_path(home, &destination)?;
            if action == "create" && existing.is_some() {
                return Err(Error::new(
                    4200,
                    format!("operations[{index}]: skill already exists: {name}"),
                ));
            }
            if action != "create" && existing.is_none() {
                return Err(Error::new(
                    4205,
                    format!("operations[{index}]: skill not found: {name}"),
                ));
            }
            let work = stage.path().join(format!("work-{name}"));
            if let Some(row) = existing {
                copy_tree(home, Path::new(text(&row, "path")).parent().unwrap(), &work)?
            } else {
                fs::create_dir_all(&work)?;
            }
            touched.insert(name.to_owned(), (destination, work, false));
        }
        let (_, work, deleted) = touched.get_mut(name).unwrap();
        if *deleted {
            return Err(Error::new(4200, "cannot edit a deleted skill"));
        }
        let result = (|| -> Result<()> {
            match action {
                "create" => {
                    let content = common::required(op, "content")?;
                    valid_skill_content(content)?;
                    if work.join("SKILL.md").exists() {
                        return Err(Error::new(4200, "skill already exists"));
                    }
                    fs::write(work.join("SKILL.md"), content)?;
                }
                "patch" => {
                    let file = if text(op, "file_path").is_empty() {
                        PathBuf::from("SKILL.md")
                    } else {
                        relative(text(op, "file_path"))?
                    };
                    let path = work.join(file);
                    let current = common::read_regular_text(&path, 1024 * 1024)?;
                    let content = if let Some(full) = op["content"].as_str() {
                        full.to_owned()
                    } else {
                        let old = common::required(op, "old_string")?;
                        let new = op["new_string"]
                            .as_str()
                            .ok_or_else(|| Error::new(4200, "new_string is required"))?;
                        let matches = current.matches(old).count();
                        if matches == 0 || (matches > 1 && op["replace_all"] != true) {
                            return Err(Error::new(
                                4200,
                                if matches == 0 {
                                    "old_string was not found"
                                } else {
                                    "old_string matches more than once; set replace_all"
                                },
                            ));
                        }
                        if op["replace_all"] == true {
                            current.replace(old, new)
                        } else {
                            current.replacen(old, new, 1)
                        }
                    };
                    if path.file_name().is_some_and(|s| s == "SKILL.md") {
                        valid_skill_content(&content)?;
                    }
                    fs::write(path, content)?;
                }
                "write_file" | "remove_file" => {
                    let relative = relative(common::required(op, "file_path")?)?;
                    let first = relative
                        .components()
                        .next()
                        .unwrap()
                        .as_os_str()
                        .to_string_lossy();
                    if !matches!(
                        first.as_ref(),
                        "references" | "templates" | "scripts" | "assets"
                    ) {
                        return Err(Error::new(
                            4202,
                            "supporting files must be under references, templates, scripts, or assets",
                        ));
                    }
                    let path = work.join(relative);
                    if action == "write_file" {
                        let content = op["file_content"]
                            .as_str()
                            .ok_or_else(|| Error::new(4200, "file_content is required"))?;
                        if content.len() > 8 * 1024 * 1024 {
                            return Err(Error::new(4202, "skill file exceeds 8 MiB"));
                        }
                        fs::create_dir_all(path.parent().unwrap())?;
                        fs::write(path, content)?;
                    } else {
                        fs::remove_file(path)?;
                    }
                }
                "delete" => {
                    *deleted = true;
                    if !cfg["skills"].is_object() {
                        cfg["skills"] = json!({})
                    }
                    if !cfg["skills"]["disabled"].is_array() {
                        cfg["skills"]["disabled"] = json!([])
                    }
                    if !cfg["skills"]["disabled"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|v| v == name)
                    {
                        cfg["skills"]["disabled"]
                            .as_array_mut()
                            .unwrap()
                            .push(json!(name));
                    }
                }
                _ => return Err(Error::new(4200, "unknown skill operation")),
            }
            Ok(())
        })();
        if let Err(error) = result {
            return Ok(
                json!({"success":false,"failed_index":index,"completed_before_failure":index,"error":error.message}),
            );
        }
        results
            .push(json!({"name":name,"action":action,"file_path":op["file_path"],"success":true}));
    }
    let mut committed: Vec<(PathBuf, Option<PathBuf>)> = vec![];
    let result = (|| -> Result<()> {
        for (name, (destination, work, deleted)) in &touched {
            safe_path(home, destination)?;
            fs::create_dir_all(destination.parent().unwrap())?;
            let backup = if destination.exists() {
                let backup = stage.path().join(format!("backup-{name}"));
                fs::rename(destination, &backup)?;
                Some(backup)
            } else {
                None
            };
            committed.push((destination.clone(), backup));
            if !deleted {
                fs::rename(work, destination)?;
            }
        }
        if cfg != old_cfg {
            common::write_config(&profile, &cfg)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut failures = vec![];
        for (destination, backup) in committed.into_iter().rev() {
            if destination.exists()
                && let Err(e) = fs::remove_dir_all(&destination)
            {
                failures.push(e.to_string());
            }
            if let Some(backup) = backup
                && let Err(e) = fs::rename(backup, destination)
            {
                failures.push(e.to_string());
            }
        }
        if !failures.is_empty() {
            let backup = stage.keep();
            return Err(Error::new(
                5200,
                format!(
                    "{}; rollback failed. Recovery files: {}",
                    error.message,
                    backup.display()
                ),
            ));
        }
        return Err(error);
    }
    Ok(json!({"success":true,"operations_applied":results.len(),"results":results}))
}

struct RecallSession {
    id: String,
    title: String,
    started: f64,
    updated: f64,
    messages: Vec<Value>,
}
fn recall_sessions(
    home: &Path,
    owner: &str,
    bot: &str,
    current: &str,
) -> Result<Vec<RecallSession>> {
    let sections = common::rows(
        &db::open(home)?,
        "SELECT * FROM sections WHERE owner_id=? AND bot=? ORDER BY updated_at DESC",
        &[&owner, &bot],
    )?;
    let legacy_path = catalog::profile(home, bot)?.join("state.db");
    safe_path(home, &legacy_path)?;
    let legacy = if legacy_path.exists() {
        Some(Connection::open_with_flags(
            legacy_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?)
    } else {
        None
    };
    let conn = runtime_store::open(home)?;
    let mut sessions = vec![];
    for section in sections {
        let id = text(&section, "id");
        if id == current {
            continue;
        }
        let native = common::rows(
            &conn,
            "SELECT m.seq,m.message_json FROM native_messages m LEFT JOIN native_pi_journal p ON p.session_id=m.session_id AND p.projection_seq=m.seq WHERE m.session_id=? AND (p.active IS NULL OR p.active=1) ORDER BY m.seq",
            &[&id],
        )?;
        let mut messages = vec![];
        for row in native {
            let m: Value = serde_json::from_str(text(&row, "message_json"))
                .map_err(|_| Error::new(5200, "invalid stored message"))?;
            let body = m["text"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| runtime_store::text(&m["content"]));
            messages.push(json!({"id":row["seq"],"role":m["role"],"content":body,"timestamp":m["timestamp"],"tool_name":m["tool_name"],"tool_calls":m["tool_calls"],"tool_call_id":m["tool_call_id"]}));
        }
        let has_native: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM native_messages WHERE session_id=?)",
            [id],
            |r| r.get(0),
        )?;
        if messages.is_empty()
            && !has_native
            && let Some(legacy) = &legacy
        {
            let legacy_id:Option<String>=legacy.query_row("SELECT id FROM sessions WHERE session_key=?1 OR id=?1 ORDER BY CASE WHEN session_key=?1 THEN 0 ELSE 1 END LIMIT 1",[id],|r|r.get(0)).optional()?;
            if let Some(legacy_id) = legacy_id {
                for row in common::rows(
                    legacy,
                    "SELECT * FROM messages WHERE session_id=? ORDER BY id",
                    &[&legacy_id],
                )? {
                    let content = row["content"].as_str().unwrap_or("");
                    let content = serde_json::from_str::<Value>(content)
                        .ok()
                        .filter(Value::is_array)
                        .map(|v| runtime_store::text(&v))
                        .unwrap_or_else(|| content.to_owned());
                    messages.push(json!({"id":row["id"],"role":row["role"],"content":content,"timestamp":row["timestamp"],"tool_name":row["tool_name"],"tool_calls":row["tool_calls"],"tool_call_id":row["tool_call_id"]}));
                }
            }
        }
        sessions.push(RecallSession {
            id: id.to_owned(),
            title: text(&section, "title").to_owned(),
            started: section["created_at"].as_f64().unwrap_or(0.0),
            updated: section["updated_at"].as_f64().unwrap_or(0.0),
            messages,
        });
    }
    Ok(sessions)
}
fn shaped(message: &Value, anchor: Option<&Value>) -> Value {
    let mut message = message.clone();
    let content = text(&message, "content");
    if content.chars().count() > 8000 {
        let len = content.chars().count();
        message["content"] = json!(content.chars().take(8000).collect::<String>());
        message["content_truncated"] = json!(true);
        message["original_content_chars"] = json!(len);
    }
    if anchor.is_some_and(|id| message["id"] == *id) {
        message["anchor"] = json!(true)
    }
    message
        .as_object_mut()
        .unwrap()
        .retain(|key, value| key == "content" || !value.is_null());
    message
}
fn search_sessions(home: &Path, owner: &str, bot: &str, current: &str, p: &Value) -> Result<Value> {
    let target = p["profile"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(bot);
    if target != bot {
        common::bot_owner(home, owner, target)?;
    }
    let sessions = recall_sessions(
        home,
        owner,
        target,
        if target == bot { current } else { "" },
    )?;
    let limit = p["limit"].as_u64().unwrap_or(3).clamp(1, 10) as usize;
    let window = p["window"].as_u64().unwrap_or(5).clamp(1, 20) as usize;
    let requested = text(p, "session_id");
    if !requested.is_empty() {
        let session = sessions.iter().find(|s| s.id == requested).ok_or_else(|| {
            Error::new(4205, "session not found or already in the active context")
        })?;
        let meta = json!({"when":session.started,"source":"hexbot","title":session.title});
        if let Some(anchor) = p.get("around_message_id") {
            let index = session
                .messages
                .iter()
                .position(|m| m["id"] == *anchor)
                .ok_or_else(|| Error::new(4205, "anchor message was not found in this session"))?;
            let start = index.saturating_sub(window);
            let end = (index + window + 1).min(session.messages.len());
            return Ok(
                json!({"success":true,"mode":"scroll","session_id":session.id,"around_message_id":anchor,"session_meta":meta,"window":window,"messages":session.messages[start..end].iter().map(|m|shaped(m,Some(anchor))).collect::<Vec<_>>(),"messages_before":start,"messages_after":session.messages.len()-end}),
            );
        }
        let truncated = session.messages.len() > 60;
        let messages = if truncated {
            session.messages[..30]
                .iter()
                .chain(session.messages[session.messages.len() - 30..].iter())
                .collect::<Vec<_>>()
        } else {
            session.messages.iter().collect()
        };
        return Ok(
            json!({"success":true,"mode":"read","session_id":session.id,"link":format!("@session:{target}/{}",session.id),"session_meta":meta,"message_count":session.messages.len(),"truncated":truncated,"messages":messages.into_iter().map(|m|shaped(m,None)).collect::<Vec<_>>()}),
        );
    }
    let query = text(p, "query").trim();
    if query.is_empty() {
        let results=sessions.iter().take(limit).map(|s|json!({"session_id":s.id,"link":format!("@session:{target}/{}",s.id),"title":s.title,"source":"hexbot","started_at":s.started,"last_active":s.updated,"message_count":s.messages.len(),"preview":s.messages.iter().rev().find(|m|m["role"]=="user").map(|m|text(m,"content").chars().take(180).collect::<String>()).unwrap_or_default()})).collect::<Vec<_>>();
        return Ok(json!({"success":true,"mode":"browse","count":results.len(),"results":results}));
    }
    let mut index = Connection::open_in_memory()?;
    index.execute_batch("CREATE VIRTUAL TABLE recall USING fts5(content,session_index UNINDEXED,message_index UNINDEXED,time UNINDEXED)")?;
    let roles = p["role_filter"]
        .as_str()
        .unwrap_or("user,assistant")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<BTreeSet<_>>();
    {
        let tx = index.transaction()?;
        let mut insert = tx.prepare(
            "INSERT INTO recall(content,session_index,message_index,time) VALUES(?,?,?,?)",
        )?;
        for (sidx, session) in sessions.iter().enumerate() {
            insert.execute(params![session.title, sidx as i64, -1i64, session.updated])?;
            for (midx, message) in session.messages.iter().enumerate() {
                let role = if message["role"] == "toolResult" {
                    "tool"
                } else {
                    text(message, "role")
                };
                if roles.contains(role) {
                    insert.execute(params![
                        text(message, "content"),
                        sidx as i64,
                        midx as i64,
                        session.updated
                    ])?;
                }
            }
        }
        drop(insert);
        tx.commit()?;
    }
    let order = match text(p, "sort") {
        "newest" => "CAST(time AS REAL) DESC,bm25(recall)",
        "oldest" => "CAST(time AS REAL) ASC,bm25(recall)",
        _ => "bm25(recall)",
    };
    let mut stmt = index.prepare(&format!(
        "SELECT session_index,message_index FROM recall WHERE recall MATCH ? ORDER BY {order}"
    ))?;
    let rows = stmt
        .query_map([query], |r| {
            Ok((r.get::<_, i64>(0)? as usize, r.get::<_, i64>(1)?))
        })
        .map_err(|_| Error::new(4200, "invalid history search expression"))?;
    let mut results = vec![];
    let mut seen = BTreeSet::new();
    for row in rows {
        let (sidx, midx) =
            row.map_err(|_| Error::new(4200, "invalid history search expression"))?;
        if !seen.insert(sidx) {
            continue;
        }
        let session = &sessions[sidx];
        let anchor = midx.max(0) as usize;
        let full = results.is_empty() || p["detail"] == "full";
        let start = if full {
            anchor.saturating_sub(window)
        } else {
            anchor
        };
        let end = if full {
            (anchor + window + 1).min(session.messages.len())
        } else {
            (anchor + 1).min(session.messages.len())
        };
        let anchor_id = session.messages.get(anchor).map(|m| &m["id"]);
        results.push(json!({"session_id":session.id,"link":format!("@session:{target}/{}",session.id),"title":session.title,"source":"hexbot","when":session.started,"match_message_id":anchor_id,"matched_role":if midx<0{"session_title"}else{session.messages.get(anchor).map(|m|text(m,"role")).unwrap_or("")},"snippet":if midx<0{session.title.clone()}else{session.messages.get(anchor).map(|m|text(m,"content").chars().take(300).collect::<String>()).unwrap_or_default()},"messages":session.messages[start.min(end)..end].iter().map(|m|shaped(m,anchor_id)).collect::<Vec<_>>(),"bookend_start":if full{session.messages.iter().take(3).map(|m|shaped(m,None)).collect::<Vec<_>>()}else{vec![]},"bookend_end":if full{session.messages.iter().skip(session.messages.len().saturating_sub(3)).map(|m|shaped(m,None)).collect::<Vec<_>>()}else{vec![]},"messages_before":start,"messages_after":session.messages.len()-end,"detail":if full{"full"}else{"anchor"}}));
        if results.len() >= limit {
            break;
        }
    }
    Ok(
        json!({"success":true,"mode":"discover","query":query,"detail":p["detail"].as_str().unwrap_or("adaptive"),"count":results.len(),"results":results}),
    )
}
pub async fn call(
    home: &Path,
    owner: &str,
    bot: &str,
    session: &str,
    name: &str,
    args: &Value,
) -> Option<Result<Value>> {
    let family = match name {
        "todo" | "todo_list" => "todo",
        "session_search" => "session_search",
        "skills_list" | "skill_view" | "skill_manage" => "skills",
        _ => return None,
    };
    let home = home.to_path_buf();
    let owner = owner.to_owned();
    let bot = bot.to_owned();
    let session = session.to_owned();
    let name = name.to_owned();
    let args = args.clone();
    Some(
        tokio::task::spawn_blocking(move || {
            let (home, owner, bot, session, name, args) = (
                home.as_path(),
                owner.as_str(),
                bot.as_str(),
                session.as_str(),
                name.as_str(),
                &args,
            );
            ensure_session(home, owner, bot, session)?;
            if !connectors::toolsets(home, bot)?.iter().any(|s| s == family) {
                return Err(Error::new(4302, format!("tool is disabled: {name}")));
            }
            match name {
                "todo" | "todo_list" => todo(home, session, args),
                "session_search" => search_sessions(home, owner, bot, session, args),
                "skills_list" => list_skills(home, bot, args),
                "skill_view" => view_skill(home, bot, args),
                "skill_manage" => manage_skills(home, bot, args),
                _ => unreachable!(),
            }
        })
        .await
        .unwrap_or_else(|error| {
            Err(Error::new(
                5200,
                format!("product tool task failed: {error}"),
            ))
        }),
    )
}
