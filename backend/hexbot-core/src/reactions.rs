//! Reactions: one emoji left on a message in a bot's chat. The user reacts to
//! what the bot said; the bot reacts to the user's latest message with
//! `hexbot_react`. Each side leaves at most one reaction on a message, and a
//! new one replaces it.
//!
//! A reaction never changes the conversation Pi holds. What the user left on
//! the bot's messages reaches the bot with their next message, the way
//! heartbeat messages do (`take_context`), so the cached prefix stays intact.
//! Rooms, threads between bots and scheduled jobs have no reactions.
use crate::{Error, Result, common, db, runtime_store as store};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::path::Path;

/// The prefix of a reaction's id among the ids Pi reports back with the
/// hidden context message, which also carry heartbeat message ids.
const CONTEXT_ID: &str = "reaction:";

/// How much of a message the bot is shown next to the reaction on it.
const QUOTE_CHARS: usize = 120;

/// The reactions the bot is told about with one message.
const CONTEXT_REACTIONS: usize = 8;

/// One emoji: a short run of characters with no letters, digits, spaces or
/// controls, so a reaction is never words.
pub(crate) fn check_emoji(emoji: &str) -> Result<&str> {
    let emoji = emoji.trim();
    let count = emoji.chars().count();
    if count == 0
        || count > 12
        || emoji
            .chars()
            .any(|c| c.is_ascii() || c.is_alphanumeric() || c.is_whitespace() || c.is_control())
    {
        return Err(Error::new(4202, "A reaction is one emoji"));
    }
    Ok(emoji)
}

/// The bot of a chat the caller owns. Threads between bots, an earlier
/// Check-ins and rooms have no reactions.
fn chat_bot(home: &Path, caller: &str, section: &str) -> Result<String> {
    db::open(home)?
        .query_row(
            "SELECT bot FROM sections WHERE id=? AND owner_id=? AND peer_bot IS NULL AND purpose IS NULL",
            params![section, caller],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| Error::new(4204, format!("chat not found: {section}")))
}

fn shown(row: &Value) -> Value {
    let bot = row["by_bot"].as_str().unwrap_or("");
    let mut reaction = json!({
        "message_id": row["message_id"],
        "emoji": row["emoji"],
        "by": if bot.is_empty() { "user" } else { "bot" },
        "at": row["created_at"]
    });
    if !bot.is_empty() {
        reaction["bot"] = json!(bot);
    }
    reaction
}

/// Every reaction in a chat, oldest first.
pub fn list(home: &Path, caller: &str, section: &str) -> Result<Value> {
    chat_bot(home, caller, section)?;
    let rows = common::rows(
        &db::open(home)?,
        "SELECT message_id,by_bot,emoji,created_at FROM message_reactions WHERE section_id=? ORDER BY created_at",
        &[&section],
    )?;
    Ok(json!({"reactions": rows.iter().map(shown).collect::<Vec<_>>()}))
}

/// The reactions on one message, as the `hexbot.reactions.changed` event and
/// the replies carry them.
fn on_message(home: &Path, section: &str, message: &str) -> Result<Value> {
    let rows = common::rows(
        &db::open(home)?,
        "SELECT message_id,by_bot,emoji,created_at FROM message_reactions WHERE section_id=? AND message_id=? ORDER BY created_at",
        &[&section, &message],
    )?;
    Ok(json!({
        "section_id": section,
        "message_id": message,
        "reactions": rows.iter().map(shown).collect::<Vec<_>>()
    }))
}

fn write(
    home: &Path,
    owner: &str,
    section: &str,
    message: &str,
    by_bot: &str,
    emoji: Option<&str>,
) -> Result<()> {
    let conn = db::open(home)?;
    match emoji {
        // The same emoji again changes nothing, so the bot is not told twice.
        Some(emoji) => conn.execute(
            "INSERT INTO message_reactions(section_id,message_id,by_bot,emoji,owner_id,created_at) VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(section_id,message_id,by_bot) DO UPDATE SET emoji=excluded.emoji,created_at=excluded.created_at,offered=0,noted_at=NULL
             WHERE message_reactions.emoji<>excluded.emoji",
            params![section, message, by_bot, emoji, owner, common::now()],
        )?,
        None => conn.execute(
            "DELETE FROM message_reactions WHERE section_id=? AND message_id=? AND by_bot=?",
            params![section, message, by_bot],
        )?,
    };
    Ok(())
}

/// The user reacts to one of the bot's messages, or takes the reaction back
/// with no `emoji`. Returns the message's reactions, which the caller emits.
pub fn set(home: &Path, caller: &str, p: &Value) -> Result<Value> {
    let section = common::required(p, "section_id")?;
    let message = common::required(p, "message_id")?;
    chat_bot(home, caller, section)?;
    let emoji = match p["emoji"].as_str().filter(|emoji| !emoji.trim().is_empty()) {
        Some(emoji) => Some(check_emoji(emoji)?),
        None => None,
    };
    if emoji.is_some() {
        let row = store::shown_row(home, section, message)?
            .ok_or_else(|| Error::new(4204, "message not found"))?;
        if row["role"] != "assistant" {
            return Err(Error::new(4202, "You react to what the bot said"));
        }
    }
    write(home, caller, section, message, "", emoji)?;
    on_message(home, section, message)
}

/// The bot reacts to the user's latest message in its chat, or takes its
/// reaction back with no `emoji`. Returns the message's reactions with the
/// input the message was sent as, so an app that still shows its own copy of
/// the message finds it.
pub fn react(
    home: &Path,
    owner: &str,
    bot: &str,
    section: &str,
    emoji: Option<&str>,
) -> Result<Value> {
    if chat_bot(home, owner, section).ok().as_deref() != Some(bot) {
        return Err(Error::new(
            4202,
            "Reactions show only in your chat with the user. Say it in words here.",
        ));
    }
    let emoji = emoji.map(check_emoji).transpose()?;
    let row = store::latest_user_row(home, section)?
        .ok_or_else(|| Error::new(4204, "The user has not sent a message to react to."))?;
    let message = common::required(&row, "row_id")?;
    write(home, owner, section, message, bot, emoji)?;
    let mut changed = on_message(home, section, message)?;
    if let Some(input) = row["input_id"].as_str() {
        changed["input_id"] = json!(input);
    }
    Ok(changed)
}

/// Whether the user left a reaction this chat's bot has not been told about.
pub(crate) fn pending_context(home: &Path, section: &str) -> Result<bool> {
    Ok(db::open(home)?.query_row(
        "SELECT EXISTS(SELECT 1 FROM message_reactions WHERE section_id=? AND by_bot='' AND noted_at IS NULL AND offered<2)",
        [section],
        |r| r.get(0),
    )?)
}

/// The user's reactions the bot has not been told about, as a note Pi adds
/// after the user's next message, with their ids. `acknowledge` marks them
/// taken when Pi reports that message; a second offer is the last, so a lost
/// reply cannot repeat them for ever. A reaction on a message the chat no
/// longer shows is dropped.
pub(crate) fn take_context(home: &Path, section: &str) -> Result<Option<Value>> {
    let conn = db::open(home)?;
    let rows = common::rows(
        &conn,
        "SELECT message_id,emoji FROM message_reactions WHERE section_id=? AND by_bot='' AND noted_at IS NULL AND offered<2 ORDER BY created_at DESC LIMIT ?",
        &[&section, &(CONTEXT_REACTIONS as i64)],
    )?;
    let mut lines = vec![];
    let mut ids = vec![];
    // Oldest first, as they were left.
    for row in rows.iter().rev() {
        let message = row["message_id"].as_str().unwrap_or("");
        let Some(said) = store::shown_row(home, section, message)? else {
            conn.execute(
                "DELETE FROM message_reactions WHERE section_id=? AND message_id=?",
                params![section, message],
            )?;
            continue;
        };
        conn.execute(
            "UPDATE message_reactions SET offered=offered+1 WHERE section_id=? AND message_id=? AND by_bot=''",
            params![section, message],
        )?;
        let text = said["text"].as_str().unwrap_or("");
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let quote = match text.char_indices().nth(QUOTE_CHARS) {
            Some((end, _)) => format!("{}\u{2026}", &text[..end]),
            None => text,
        };
        let emoji = row["emoji"].as_str().unwrap_or("");
        lines.push(format!(
            "- {emoji} on your message \"{}\"",
            quote.replace('"', "'")
        ));
        // The emoji is part of the id: one changed before Pi answers is still to be told.
        ids.push(json!(format!("{CONTEXT_ID}{message}:{emoji}")));
    }
    if lines.is_empty() {
        return Ok(None);
    }
    Ok(Some(json!({
        "text": format!(
            "Before the message above, the user reacted to what you said. A reaction is a quick answer or a feeling about that message, not an instruction; don't reply to it on its own.\n{}",
            lines.join("\n")
        ),
        "ids": ids
    })))
}

/// Pi took these reactions into the chat's context. Other ids in the list
/// are heartbeat messages and are left to `heartbeat::acknowledge`.
pub(crate) fn acknowledge(home: &Path, section: &str, ids: &Value) -> Result<()> {
    let conn = db::open(home)?;
    for (message, emoji) in ids
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|id| id.strip_prefix(CONTEXT_ID))
        .filter_map(|id| id.split_once(':'))
    {
        conn.execute(
            "UPDATE message_reactions SET noted_at=? WHERE section_id=? AND message_id=? AND emoji=? AND by_bot='' AND noted_at IS NULL",
            params![common::now(), section, message, emoji],
        )?;
    }
    Ok(())
}

/// `hexbot.reactions.*`. A successful `set` is announced by the server.
pub fn call(home: &Path, caller: &str, method: &str, p: &Value) -> Option<Result<Value>> {
    Some(match method {
        "hexbot.reactions.list" => {
            common::required(p, "section_id").and_then(|section| list(home, caller, section))
        }
        "hexbot.reactions.set" => set(home, caller, p),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bot's chat with one message from each side, and a thread.
    fn home() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        let conn = db::open(home.path()).unwrap();
        conn.execute_batch(
            "INSERT INTO sections(id,bot,owner_id) VALUES ('chat','owl','local');
             INSERT INTO sections(id,bot,owner_id,peer_bot) VALUES ('thread','owl','local','fox');",
        )
        .unwrap();
        for (section, row) in [
            (
                "chat",
                json!({"role":"user","text":"Book the 9am.","row_id":"u1","input_id":"in-1","display_kind":"normal"}),
            ),
            (
                "chat",
                json!({"role":"assistant","text":"Booked the \"9am\" flight.","row_id":"a1"}),
            ),
            (
                "thread",
                json!({"role":"assistant","text":"Done.","row_id":"t1"}),
            ),
        ] {
            store::append(home.path(), section, row).unwrap();
        }
        home
    }

    #[test]
    fn a_reaction_is_one_emoji_never_words() {
        for emoji in ["👍", "❤️", "👨‍👩‍👧", " 🎉 "] {
            assert!(check_emoji(emoji).is_ok(), "{emoji}");
        }
        for words in ["", "ok", "👍 ok", "1", "好", "👍\n👍", &"👍".repeat(13)] {
            assert!(check_emoji(words).is_err(), "{words}");
        }
    }

    #[test]
    fn the_user_reacts_to_what_the_bot_said_and_takes_it_back() {
        let home = home();
        let set = |message: &str, emoji: Value| {
            set(
                home.path(),
                "local",
                &json!({"section_id":"chat","message_id":message,"emoji":emoji}),
            )
        };
        let changed = set("a1", json!("👍")).unwrap();
        assert_eq!(changed["reactions"][0]["emoji"], "👍");
        assert_eq!(changed["reactions"][0]["by"], "user");
        // A new one replaces it: one reaction a side.
        set("a1", json!("❤️")).unwrap();
        let all = list(home.path(), "local", "chat").unwrap();
        assert_eq!(all["reactions"].as_array().unwrap().len(), 1);
        assert_eq!(all["reactions"][0]["emoji"], "❤️");
        assert_eq!(all["reactions"][0]["message_id"], "a1");
        // Their own message, a message that is not there, and words are refused.
        assert_eq!(set("u1", json!("👍")).unwrap_err().code, 4202);
        assert_eq!(set("gone", json!("👍")).unwrap_err().code, 4204);
        assert_eq!(set("a1", json!("nice")).unwrap_err().code, 4202);
        // No emoji takes it back.
        assert_eq!(set("a1", Value::Null).unwrap()["reactions"], json!([]));
        assert_eq!(
            list(home.path(), "local", "chat").unwrap()["reactions"],
            json!([])
        );
    }

    #[test]
    fn only_the_owner_reacts_and_only_in_a_chat() {
        let home = home();
        let p = |section: &str, message: &str| json!({"section_id":section,"message_id":message,"emoji":"👍"});
        assert_eq!(
            set(home.path(), "mallory", &p("chat", "a1"))
                .unwrap_err()
                .code,
            4204
        );
        assert_eq!(
            set(home.path(), "local", &p("thread", "t1"))
                .unwrap_err()
                .code,
            4204
        );
        assert_eq!(list(home.path(), "mallory", "chat").unwrap_err().code, 4204);
        assert!(call(home.path(), "local", "hexbot.reactions.none", &json!({})).is_none());
    }

    #[test]
    fn the_bot_reacts_to_the_users_latest_message() {
        let home = home();
        let changed = react(home.path(), "local", "owl", "chat", Some("👍")).unwrap();
        assert_eq!(changed["message_id"], "u1");
        assert_eq!(changed["input_id"], "in-1");
        assert_eq!(changed["reactions"][0]["by"], "bot");
        assert_eq!(changed["reactions"][0]["bot"], "owl");
        // The user's own reaction sits beside it on another message.
        set(
            home.path(),
            "local",
            &json!({"section_id":"chat","message_id":"a1","emoji":"🎉"}),
        )
        .unwrap();
        assert_eq!(
            list(home.path(), "local", "chat").unwrap()["reactions"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        // Taking it back, and the places with no reactions.
        assert_eq!(
            react(home.path(), "local", "owl", "chat", None).unwrap()["reactions"],
            json!([])
        );
        assert_eq!(
            react(home.path(), "local", "owl", "thread", Some("👍"))
                .unwrap_err()
                .code,
            4202
        );
        assert_eq!(
            react(home.path(), "local", "fox", "chat", Some("👍"))
                .unwrap_err()
                .code,
            4202
        );
        // A bot's own reaction is never told back to it.
        react(home.path(), "local", "owl", "chat", Some("👍")).unwrap();
        assert!(pending_context(home.path(), "chat").unwrap());
        let offer = take_context(home.path(), "chat").unwrap().unwrap();
        assert_eq!(offer["ids"], json!(["reaction:a1:🎉"]));
    }

    #[test]
    fn the_bot_is_told_once_with_the_next_message_and_offered_at_most_twice() {
        let home = home();
        let thumbs = json!({"section_id":"chat","message_id":"a1","emoji":"👍"});
        assert!(!pending_context(home.path(), "chat").unwrap());
        assert!(take_context(home.path(), "chat").unwrap().is_none());
        set(home.path(), "local", &thumbs).unwrap();
        assert!(pending_context(home.path(), "chat").unwrap());
        let offer = take_context(home.path(), "chat").unwrap().unwrap();
        assert_eq!(offer["ids"], json!(["reaction:a1:👍"]));
        let text = offer["text"].as_str().unwrap();
        assert!(
            text.contains("- 👍 on your message \"Booked the '9am' flight.\""),
            "{text}"
        );
        assert!(text.contains("not an instruction"));
        // Heartbeat ids in the same list are not ours; ours marks it taken.
        acknowledge(
            home.path(),
            "chat",
            &json!(["some-heartbeat", "reaction:a1:👍"]),
        )
        .unwrap();
        assert!(!pending_context(home.path(), "chat").unwrap());
        // The same emoji again tells nothing new; another one does.
        set(home.path(), "local", &thumbs).unwrap();
        assert!(!pending_context(home.path(), "chat").unwrap());
        set(
            home.path(),
            "local",
            &json!({"section_id":"chat","message_id":"a1","emoji":"❤️"}),
        )
        .unwrap();
        // Pi answering for the emoji it was shown does not take the new one.
        acknowledge(home.path(), "chat", &json!(["reaction:a1:👍"])).unwrap();
        assert!(pending_context(home.path(), "chat").unwrap());
        // A lost reply: offered twice, then no more.
        assert!(take_context(home.path(), "chat").unwrap().is_some());
        assert!(take_context(home.path(), "chat").unwrap().is_some());
        assert!(!pending_context(home.path(), "chat").unwrap());
        assert!(take_context(home.path(), "chat").unwrap().is_none());
    }

    #[test]
    fn a_reaction_goes_with_its_chat() {
        let home = home();
        set(
            home.path(),
            "local",
            &json!({"section_id":"chat","message_id":"a1","emoji":"👍"}),
        )
        .unwrap();
        let conn = db::open(home.path()).unwrap();
        let count = || -> i64 {
            conn.query_row("SELECT COUNT(*) FROM message_reactions", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(count(), 1);
        // A message the chat no longer shows takes its reaction with it.
        store::open(home.path())
            .unwrap()
            .execute("DELETE FROM native_messages WHERE session_id='chat'", [])
            .unwrap();
        assert!(take_context(home.path(), "chat").unwrap().is_none());
        assert_eq!(count(), 0);
    }
}
