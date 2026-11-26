//! Persistent Auto-mode approval rules: "Allow automatically" rules (saved by
//! clicking Always allow on a card or added in Settings, Approvals) and
//! "Ask first" guardrails (which always take precedence on conflict).
use crate::{Error, Result, common, db};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::path::Path;

pub const MAX_RULES_PER_KIND: usize = 40;
pub const MAX_RULE_CHARS: usize = 500;
pub const CHANGES: &[&str] = &[
    "hexbot.approvals.rules.add",
    "hexbot.approvals.rules.remove",
    "hexbot.approvals.rules.clear",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRule {
    pub text: String,
    pub computer: Option<String>,
}

impl ReviewRule {
    pub fn to_evidence(&self) -> Value {
        match self.computer.as_deref().filter(|c| !c.is_empty()) {
            Some(computer) => json!({ "rule": self.text, "computer": computer }),
            None => json!(self.text),
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReviewRules {
    pub allow: Vec<ReviewRule>,
    pub ask: Vec<ReviewRule>,
}

impl ReviewRules {
    pub fn is_empty(&self) -> bool {
        self.allow.is_empty() && self.ask.is_empty()
    }
}

fn normalize_text(raw: &str) -> Result<String> {
    if raw
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(Error::new(
            4202,
            "Rule text cannot contain control characters.",
        ));
    }
    let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err(Error::new(4202, "Rule text cannot be empty."));
    }
    if text.chars().count() > MAX_RULE_CHARS {
        return Err(Error::new(
            4202,
            format!("Rule text must be at most {MAX_RULE_CHARS} characters."),
        ));
    }
    Ok(text)
}

fn validate_kind(kind: &str) -> Result<&str> {
    match kind {
        "allow" | "ask" => Ok(kind),
        _ => Err(Error::new(4202, "Rule kind must be 'allow' or 'ask'.")),
    }
}

fn row_to_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "kind": row.get::<_, String>(1)?,
        "text": row.get::<_, String>(2)?,
        "source": row.get::<_, String>(3)?,
        "tool": row.get::<_, Option<String>>(4)?,
        "computer": row.get::<_, Option<String>>(5)?,
        "created_at": row.get::<_, f64>(6)?,
    }))
}

pub fn list(home: &Path, owner: &str) -> Result<Value> {
    common::user(home, owner)?;
    let conn = db::open(home)?;
    let mut stmt = conn.prepare(
        "SELECT id,kind,text,source,tool,computer,created_at
         FROM approval_rules
         WHERE owner_id=?
         ORDER BY created_at DESC, id DESC",
    )?;
    let rules = stmt
        .query_map([owner], row_to_value)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(json!({ "rules": rules }))
}

pub fn add(
    home: &Path,
    owner: &str,
    kind: &str,
    text: &str,
    source: &str,
    tool: Option<&str>,
    computer: Option<&str>,
) -> Result<Value> {
    common::user(home, owner)?;
    let kind = validate_kind(kind)?;
    if !matches!(source, "manual" | "card") {
        return Err(Error::new(4202, "Invalid rule source."));
    }
    let text = normalize_text(text)?;
    let mut conn = db::open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    // Deduplicate case-insensitively within the same owner and kind.
    let existing = {
        let mut stmt = tx.prepare(
            "SELECT id,kind,text,source,tool,computer,created_at
             FROM approval_rules
             WHERE owner_id=?1 AND kind=?2 AND lower(text)=lower(?3)
             LIMIT 1",
        )?;
        stmt.query_map(params![owner, kind, text], row_to_value)?
            .next()
            .transpose()?
    };
    if let Some(rule) = existing {
        return Ok(json!({ "rule": rule }));
    }

    let count: usize = tx.query_row(
        "SELECT COUNT(*) FROM approval_rules WHERE owner_id=?1 AND kind=?2",
        params![owner, kind],
        |r| r.get(0),
    )?;
    if count >= MAX_RULES_PER_KIND {
        return Err(Error::new(
            4202,
            format!(
                "You can keep up to {MAX_RULES_PER_KIND} {} rules. Remove one before adding another.",
                if kind == "allow" {
                    "Allow automatically"
                } else {
                    "Ask first"
                }
            ),
        ));
    }

    let id = common::id();
    let now = common::now();
    let tool = tool.map(str::trim).filter(|s| !s.is_empty());
    let computer = computer.map(str::trim).filter(|s| !s.is_empty());
    tx.execute(
        "INSERT INTO approval_rules(id,owner_id,kind,text,source,tool,computer,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![id, owner, kind, text, source, tool, computer, now],
    )?;
    tx.commit()?;
    Ok(json!({
        "rule": {
            "id": id,
            "kind": kind,
            "text": text,
            "source": source,
            "tool": tool,
            "computer": computer,
            "created_at": now,
        }
    }))
}

pub fn remove(home: &Path, owner: &str, id: &str) -> Result<Value> {
    common::user(home, owner)?;
    let conn = db::open(home)?;
    let removed = conn.execute(
        "DELETE FROM approval_rules WHERE id=?1 AND owner_id=?2",
        params![id, owner],
    )?;
    Ok(json!({ "removed": removed > 0 }))
}

pub fn clear(home: &Path, owner: &str, kind: Option<&str>) -> Result<Value> {
    common::user(home, owner)?;
    let conn = db::open(home)?;
    let removed = if let Some(kind) = kind {
        let kind = validate_kind(kind)?;
        conn.execute(
            "DELETE FROM approval_rules WHERE owner_id=?1 AND kind=?2",
            params![owner, kind],
        )?
    } else {
        conn.execute("DELETE FROM approval_rules WHERE owner_id=?1", [owner])?
    };
    Ok(json!({ "removed": removed }))
}

/// Reads the owner's standing rules on an open database connection so the
/// reviewer sees the exact snapshot committed with the evidence check.
pub fn for_review_conn(conn: &Connection, owner: &str) -> Result<ReviewRules> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='approval_rules')",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(ReviewRules::default());
    }
    let mut stmt = conn.prepare(
        "SELECT kind,text,computer FROM approval_rules
         WHERE owner_id=?1
         ORDER BY created_at ASC, id ASC",
    )?;
    let mut rules = ReviewRules::default();
    let rows = stmt.query_map([owner], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })?;
    for row in rows {
        let (kind, text, computer) = row?;
        let entry = ReviewRule { text, computer };
        match kind.as_str() {
            "allow" => rules.allow.push(entry),
            "ask" => rules.ask.push(entry),
            _ => {}
        }
    }
    Ok(rules)
}

fn clip(text: &str, limit: usize) -> String {
    let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match cleaned.char_indices().nth(limit) {
        Some((end, _)) => format!("{}…", &cleaned[..end]),
        None => cleaned,
    }
}

fn humanize_identifier(raw: &str) -> String {
    let cleaned = raw.replace(['_', '-'], " ").trim().to_owned();
    let mut chars = cleaned.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => raw.to_owned(),
    }
}

fn computer_suffix(computer: Option<&str>) -> String {
    match computer.map(str::trim).filter(|c| !c.is_empty()) {
        None => String::new(),
        Some("host") => " on this computer".into(),
        Some("vm") => " on the bots' computer".into(),
        Some(other) if other.starts_with("device:") => " on your computer".into(),
        Some(other) => format!(" on {other}"),
    }
}

/// Resolves a computer id to its user-facing label so internal `device:<id>`
/// identifiers never leak into rule text shown on cards or in Settings.
pub fn computer_label(home: &Path, owner: &str, computer: Option<&str>) -> Option<String> {
    let raw = computer.map(str::trim).filter(|c| !c.is_empty())?;
    let Some(device_id) = raw.strip_prefix("device:") else {
        return Some(raw.to_owned());
    };
    let name = db::open(home).ok().and_then(|conn| {
        conn.query_row(
            "SELECT name FROM devices WHERE id=?1 AND owner_id=?2",
            params![device_id, owner],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    });
    Some(
        name.map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "your computer".into()),
    )
}

/// Ensures a card-derived rule states which computer it covers, so both the
/// user and the reviewer see its exact scope.
pub fn scope_rule_to_computer(text: &str, computer: Option<&str>) -> String {
    let base = clip(text, 200);
    let suffix = computer_suffix(computer);
    if suffix.is_empty() {
        return base;
    }
    let lower = base.to_lowercase();
    let already_scoped = match computer.map(str::trim) {
        Some("host") => lower.contains("this computer"),
        Some("vm") => lower.contains("bots' computer") || lower.contains("bots computer"),
        Some(other) if other.starts_with("device:") => lower.contains("your computer"),
        Some(other) => lower.contains(&other.to_lowercase()),
        None => true,
    };
    if already_scoped {
        base
    } else {
        clip(&format!("{base}{suffix}"), 200)
    }
}

/// Clean fallback rule derived purely from tool, command, and computer when the
/// reviewer did not supply a custom rule string.
pub fn default_rule_for_step(tool: &str, command: &str, computer: Option<&str>) -> String {
    let suffix = computer_suffix(computer);
    match tool {
        "write" | "edit" => {
            let parent = Path::new(command)
                .parent()
                .and_then(|p| p.to_str())
                .filter(|p| !p.is_empty() && *p != "/");
            match parent {
                Some(dir) => clip(&format!("Allow editing files in {dir}"), 200),
                None => clip(&format!("Allow editing {command}"), 200),
            }
        }
        "bash" => {
            let trimmed = command.trim();
            let first = trimmed.split_whitespace().next().unwrap_or("");
            let second = trimmed.split_whitespace().nth(1).unwrap_or("");
            let action = match (first, second) {
                ("git", "push") => "pushing branches with git".into(),
                ("git", sub) if !sub.is_empty() => format!("running git {sub}"),
                ("npm" | "pnpm" | "yarn" | "bun", "install" | "i" | "add") => {
                    format!("installing packages with {first}")
                }
                ("pip" | "pip3" | "uv" | "brew" | "cargo", "install" | "add") => {
                    format!("installing packages with {first}")
                }
                ("curl" | "wget", _) => format!("making web requests with {first}"),
                _ => format!("running `{}`", clip(trimmed, 90)),
            };
            clip(&format!("Allow {action}{suffix}"), 200)
        }
        "browser_console" => "Allow running scripts in browser pages".into(),
        "hexbot_connector_write" => {
            let connector = command
                .split_whitespace()
                .next()
                .unwrap_or("connected service");
            clip(
                &format!("Allow updating {}", humanize_identifier(connector)),
                200,
            )
        }
        "hexbot_calendar" => "Allow creating and updating calendar events".into(),
        "hexbot_tasks" => "Allow adding and updating tasks".into(),
        "hexbot_drive" => "Allow uploading and updating cloud files".into(),
        "hexbot_documents" => "Allow creating and editing documents".into(),
        "hexbot_spreadsheets" => "Allow creating and editing spreadsheets".into(),
        "hexbot_presentations" => "Allow creating and editing presentations".into(),
        other if other.starts_with("mcp__") => {
            let parts: Vec<&str> = other.split("__").collect();
            let server = parts.get(1).copied().unwrap_or(other);
            let name = parts.get(2).copied().unwrap_or("");
            if name.is_empty() {
                clip(&format!("Allow using {}", humanize_identifier(server)), 200)
            } else {
                clip(
                    &format!(
                        "Allow {} in {}",
                        humanize_identifier(name).to_lowercase(),
                        humanize_identifier(server)
                    ),
                    200,
                )
            }
        }
        _ => clip(
            &format!(
                "Allow {} ({}){suffix}",
                humanize_identifier(tool).to_lowercase(),
                clip(command, 80)
            ),
            200,
        ),
    }
}

pub fn call(home: &Path, caller: &str, method: &str, p: &Value) -> Option<Result<Value>> {
    Some(match method {
        "hexbot.approvals.rules.list" => list(home, caller),
        "hexbot.approvals.rules.add" => {
            let kind = match common::required(p, "kind") {
                Ok(kind) => kind,
                Err(error) => return Some(Err(error)),
            };
            let text = match common::required(p, "text") {
                Ok(text) => text,
                Err(error) => return Some(Err(error)),
            };
            add(
                home,
                caller,
                kind,
                text,
                "manual",
                p["tool"].as_str(),
                p["computer"].as_str(),
            )
        }
        "hexbot.approvals.rules.remove" => {
            let id = match common::required(p, "id") {
                Ok(id) => id,
                Err(error) => return Some(Err(error)),
            };
            remove(home, caller, id)
        }
        "hexbot.approvals.rules.clear" => clear(home, caller, p["kind"].as_str()),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        db::open(home.path())
            .unwrap()
            .execute_batch(
                "INSERT INTO users(id,display_name,role,created_at) VALUES
                 ('alice','Alice','admin',0),('bob','Bob','admin',0);",
            )
            .unwrap();
        home
    }

    #[test]
    fn crud_deduplicates_isolates_owners_and_feeds_reviewer() {
        let home = setup();
        let added = add(
            home.path(),
            "alice",
            "allow",
            "  Allow   pushing feature branches  ",
            "card",
            Some("bash"),
            Some("host"),
        )
        .unwrap();
        let id = added["rule"]["id"].as_str().unwrap().to_owned();
        assert_eq!(added["rule"]["text"], "Allow pushing feature branches");
        assert_eq!(added["rule"]["source"], "card");

        // Case-insensitive duplicate returns existing row.
        let dup = add(
            home.path(),
            "alice",
            "allow",
            "allow pushing FEATURE branches",
            "manual",
            None,
            None,
        )
        .unwrap();
        assert_eq!(dup["rule"]["id"], id);

        // Same text under the opposite kind is allowed (Ask first wins).
        let ask = add(
            home.path(),
            "alice",
            "ask",
            "Ask before pushing to main",
            "manual",
            None,
            None,
        )
        .unwrap();
        let ask_id = ask["rule"]["id"].as_str().unwrap().to_owned();

        // Another owner sees none of Alice's rules.
        assert_eq!(
            list(home.path(), "bob").unwrap()["rules"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            remove(home.path(), "bob", &id).unwrap()["removed"],
            json!(false)
        );

        let conn = db::open(home.path()).unwrap();
        let review = for_review_conn(&conn, "alice").unwrap();
        assert_eq!(
            review.allow,
            vec![ReviewRule {
                text: "Allow pushing feature branches".into(),
                computer: Some("host".into()),
            }]
        );
        assert_eq!(
            review.ask,
            vec![ReviewRule {
                text: "Ask before pushing to main".into(),
                computer: None,
            }]
        );

        assert_eq!(
            remove(home.path(), "alice", &ask_id).unwrap()["removed"],
            json!(true)
        );
        assert_eq!(
            clear(home.path(), "alice", Some("allow")).unwrap()["removed"],
            json!(1)
        );
        assert!(for_review_conn(&conn, "alice").unwrap().is_empty());
    }

    #[test]
    fn enforces_limits_and_builds_clean_fallback_rules() {
        let home = setup();
        assert!(add(home.path(), "alice", "bad", "x", "manual", None, None).is_err());
        assert!(add(home.path(), "alice", "allow", "   ", "manual", None, None).is_err());
        assert!(
            add(
                home.path(),
                "alice",
                "allow",
                &"x".repeat(MAX_RULE_CHARS + 1),
                "manual",
                None,
                None
            )
            .is_err()
        );
        for i in 0..MAX_RULES_PER_KIND {
            add(
                home.path(),
                "alice",
                "allow",
                &format!("Rule {i}"),
                "manual",
                None,
                None,
            )
            .unwrap();
        }
        assert!(
            add(
                home.path(),
                "alice",
                "allow",
                "One too many",
                "manual",
                None,
                None
            )
            .is_err()
        );
        // Ask rules have their own quota.
        assert!(
            add(
                home.path(),
                "alice",
                "ask",
                "Ask first",
                "manual",
                None,
                None
            )
            .is_ok()
        );

        assert_eq!(
            default_rule_for_step("write", "/Users/alex/Documents/plan.md", None),
            "Allow editing files in /Users/alex/Documents"
        );
        assert_eq!(
            default_rule_for_step("bash", "git push origin feat", Some("host")),
            "Allow pushing branches with git on this computer"
        );
        assert_eq!(
            default_rule_for_step("bash", "git push origin feat", Some("vm")),
            "Allow pushing branches with git on the bots' computer"
        );
        assert_eq!(
            scope_rule_to_computer("Allow pushing branches", Some("vm")),
            "Allow pushing branches on the bots' computer"
        );
        assert_eq!(
            scope_rule_to_computer("Allow pushing branches on the bots' computer", Some("vm")),
            "Allow pushing branches on the bots' computer"
        );
        // Raw device:<id> never leaks into UI copy; registered device names are used instead.
        assert_eq!(
            scope_rule_to_computer("Allow running brew", Some("device:7f3a")),
            "Allow running brew on your computer"
        );
        db::open(home.path())
            .unwrap()
            .execute(
                "INSERT INTO devices(id,name,owner_id) VALUES('mac-1','Alex MacBook','alice')",
                [],
            )
            .unwrap();
        assert_eq!(
            computer_label(home.path(), "alice", Some("device:mac-1")).as_deref(),
            Some("Alex MacBook")
        );
        assert_eq!(
            computer_label(home.path(), "alice", Some("device:unknown")).as_deref(),
            Some("your computer")
        );
        assert_eq!(
            default_rule_for_step("mcp__notion__update_page", "notion/update_page", None),
            "Allow update page in Notion"
        );
    }
}
