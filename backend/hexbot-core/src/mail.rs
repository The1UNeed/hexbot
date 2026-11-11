//! Gmail and Outlook behind one shape, for `hexbot_mail`. Messages come back
//! as plain text with their headers, never as MIME or base64, so a model can
//! read them. Sending is here too, but only the draft card calls it: a bot
//! cannot send on its own (`runtime_mail.rs`).
use crate::{
    Error, Result,
    accounts::{self, Service, UNCERTAIN, enc},
};
use base64::Engine;
use serde_json::{Value, json};
use std::path::Path;

const MAX_RESULTS: usize = 20;
const BODY_CAP: usize = 40_000;

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
/// Gmail's base64url, with or without padding.
fn unb64url(text: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(text.trim_end_matches('='))
        .ok()
}

async fn request(
    home: &Path,
    svc: &Service,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
    headers: &[(&str, &str)],
) -> Result<Value> {
    request_as(home, svc, None, method, path, body, headers).await
}

/// A request with the grant `grant` names (its `connected_at`), when given:
/// a draft goes from the account its card showed, or not at all.
async fn request_as(
    home: &Path,
    svc: &Service,
    grant: Option<&Value>,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
    headers: &[(&str, &str)],
) -> Result<Value> {
    accounts::api(
        home, svc, grant, method, svc.api, path, body, headers, "message",
    )
    .await
}

// --- Reading --------------------------------------------------------------

/// Messages matching the service's own search words, newest first; the
/// latest in the inbox for an empty query.
pub(crate) async fn search(
    home: &Path,
    svc: &Service,
    query: &str,
    max: usize,
) -> Result<Vec<Value>> {
    let max = max.clamp(1, MAX_RESULTS);
    if svc.google() {
        let q = if query.trim().is_empty() {
            "in:inbox"
        } else {
            query
        };
        let list = request(
            home,
            svc,
            reqwest::Method::GET,
            &format!("/gmail/v1/users/me/messages?maxResults={max}&q={}", enc(q)),
            None,
            &[],
        )
        .await?;
        let ids = list["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m["id"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        let metadata = "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";
        let paths = ids
            .iter()
            .map(|id| format!("/gmail/v1/users/me/messages/{}?{metadata}", enc(id)))
            .collect::<Vec<_>>();
        let rows = futures_util::future::join_all(
            paths
                .iter()
                .map(|path| request(home, svc, reqwest::Method::GET, path, None, &[])),
        )
        .await;
        return rows.into_iter().map(|m| m.map(|m| gmail_row(&m))).collect();
    }
    let select =
        "$select=id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead";
    let path = if query.trim().is_empty() {
        format!(
            "/v1.0/me/mailFolders/inbox/messages?$top={max}&$orderby=receivedDateTime%20desc&{select}"
        )
    } else {
        // Graph takes a quoted search phrase; a quote inside it would end it.
        let phrase = format!("\"{}\"", query.replace('"', ""));
        format!(
            "/v1.0/me/messages?$top={max}&$search={}&{select}",
            enc(&phrase)
        )
    };
    let list = request(home, svc, reqwest::Method::GET, &path, None, &[]).await?;
    Ok(list["value"]
        .as_array()
        .into_iter()
        .flatten()
        .map(graph_row)
        .collect())
}

fn header<'a>(message: &'a Value, name: &str) -> &'a str {
    message["payload"]["headers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|h| {
            h["name"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })
        .and_then(|h| h["value"].as_str())
        .unwrap_or("")
}

fn gmail_row(m: &Value) -> Value {
    let labels = m["labelIds"].as_array().cloned().unwrap_or_default();
    json!({
        "id": m["id"],
        "thread_id": m["threadId"],
        "from": header(m, "From"),
        "to": header(m, "To"),
        "subject": header(m, "Subject"),
        "date": header(m, "Date"),
        "snippet": html_entities(m["snippet"].as_str().unwrap_or("")),
        "unread": labels.iter().any(|l| l == "UNREAD"),
    })
}

fn person(v: &Value) -> String {
    let address = v["emailAddress"]["address"].as_str().unwrap_or("");
    match v["emailAddress"]["name"]
        .as_str()
        .filter(|n| !n.is_empty() && *n != address)
    {
        // Quoted when it holds a comma, so `Lima, Ana` stays one person.
        Some(name) if name.contains([',', ';']) => {
            format!("\"{}\" <{address}>", name.replace('"', ""))
        }
        Some(name) => format!("{name} <{address}>"),
        None => address.to_owned(),
    }
}
fn people(v: &Value) -> String {
    v.as_array()
        .into_iter()
        .flatten()
        .map(person)
        .collect::<Vec<_>>()
        .join(", ")
}

fn graph_row(m: &Value) -> Value {
    json!({
        "id": m["id"],
        "thread_id": m["conversationId"],
        "from": person(&m["from"]),
        "to": people(&m["toRecipients"]),
        "subject": m["subject"],
        "date": m["receivedDateTime"],
        "snippet": m["bodyPreview"],
        "unread": m["isRead"] == false,
    })
}

/// The subject of message `id`, read lightly: proof a reply has something
/// to answer, and the subject it keeps.
pub(crate) async fn subject_of(home: &Path, svc: &Service, id: &str) -> Result<String> {
    if id.is_empty() || id.len() > 512 {
        return Err(Error::new(4202, "id must be a message id from search"));
    }
    let path = if svc.google() {
        format!(
            "/gmail/v1/users/me/messages/{}?format=metadata&metadataHeaders=Subject",
            enc(id)
        )
    } else {
        format!("/v1.0/me/messages/{}?$select=subject", enc(id))
    };
    let m = request(home, svc, reqwest::Method::GET, &path, None, &[]).await?;
    Ok(if svc.google() {
        header(&m, "Subject").to_owned()
    } else {
        m["subject"].as_str().unwrap_or("").to_owned()
    })
}

/// One message with its text, at most `BODY_CAP` characters of it.
pub(crate) async fn read(home: &Path, svc: &Service, id: &str) -> Result<Value> {
    if id.is_empty() || id.len() > 512 {
        return Err(Error::new(4202, "id must be a message id from search"));
    }
    if svc.google() {
        let m = request(
            home,
            svc,
            reqwest::Method::GET,
            &format!("/gmail/v1/users/me/messages/{}?format=full", enc(id)),
            None,
            &[],
        )
        .await?;
        let mut row = gmail_row(&m);
        row["cc"] = json!(header(&m, "Cc"));
        row["reply_to"] = json!(header(&m, "Reply-To"));
        let mut attachments = vec![];
        let body = gmail_text(&m["payload"], &mut attachments);
        row["body"] = json!(capped(&body));
        row["attachments"] = json!(attachments);
        return Ok(row);
    }
    let m = request(
        home,
        svc,
        reqwest::Method::GET,
        &format!(
            "/v1.0/me/messages/{}?$select=id,conversationId,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,body,isRead,hasAttachments",
            enc(id)
        ),
        None,
        &[("Prefer", "outlook.body-content-type=\"text\"")],
    )
    .await?;
    let mut row = graph_row(&m);
    row["cc"] = json!(people(&m["ccRecipients"]));
    row["reply_to"] = json!(people(&m["replyTo"]));
    let text = m["body"]["content"].as_str().unwrap_or("");
    let text = if m["body"]["contentType"] == "html" {
        html_text(text)
    } else {
        text.to_owned()
    };
    row["body"] = json!(capped(&text));
    row["has_attachments"] = m["hasAttachments"].clone();
    Ok(row)
}

fn capped(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= BODY_CAP {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(BODY_CAP).collect();
    cut.push_str("\n\n[The rest of this message was cut.]");
    cut
}

/// A Gmail payload's text: the plain part where there is one, else its HTML
/// as text. Attachment names are collected on the way.
fn gmail_text(part: &Value, attachments: &mut Vec<String>) -> String {
    let mime = part["mimeType"].as_str().unwrap_or("");
    if let Some(name) = part["filename"].as_str().filter(|n| !n.is_empty()) {
        attachments.push(name.to_owned());
        return String::new();
    }
    let data = || {
        part["body"]["data"]
            .as_str()
            .and_then(unb64url)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default()
    };
    match mime {
        "text/plain" => data(),
        "text/html" => html_text(&data()),
        _ => {
            let parts = part["parts"].as_array().cloned().unwrap_or_default();
            if mime == "multipart/alternative" {
                // The plain part, when the sender wrote one.
                if let Some(plain) = parts.iter().find(|p| p["mimeType"] == "text/plain") {
                    return gmail_text(plain, attachments);
                }
            }
            parts
                .iter()
                .map(|p| gmail_text(p, attachments))
                .filter(|t| !t.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n\n")
        }
    }
}

fn html_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// HTML as readable text: blocks become lines, tags go, entities decode.
pub(crate) fn html_text(html: &str) -> String {
    let hidden =
        regex::Regex::new(r"(?is)<(script|style|head)\b.*?</(script|style|head)\s*>").unwrap();
    let breaks = regex::Regex::new(r"(?i)<br\s*/?>|</(p|div|li|tr|h[1-6]|blockquote)\s*>").unwrap();
    let tags = regex::Regex::new(r"(?s)<[^>]*>").unwrap();
    let blank = regex::Regex::new(r"\n[ \t]*\n(\s*\n)+").unwrap();
    let text = hidden.replace_all(html, "");
    let text = breaks.replace_all(&text, "\n");
    let text = tags.replace_all(&text, "");
    let text = html_entities(&text);
    let text = text
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    blank.replace_all(&text, "\n\n").trim().to_owned()
}

// --- Drafts ---------------------------------------------------------------

/// What the user left on the draft card.
#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
    /// The message this answers, in its thread.
    pub reply_to: Option<String>,
}

impl Draft {
    pub fn to_json(&self) -> Value {
        json!({
            "to": self.to,
            "cc": self.cc,
            "bcc": self.bcc,
            "subject": self.subject,
            "body": self.body,
            "reply_to": self.reply_to,
        })
    }
}

/// Addresses from a list or a comma-separated line, each checked to be one
/// address with no line break that could start another header.
pub fn addresses(value: &Value, field: &str) -> Result<Vec<String>> {
    let raw: Vec<String> = match value {
        Value::Null => vec![],
        Value::String(s) => split(s),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| Error::new(4202, format!("{field} must list addresses")))
            })
            .collect::<Result<_>>()?,
        _ => return Err(Error::new(4202, format!("{field} must list addresses"))),
    };
    let list = raw
        .iter()
        .map(|a| a.trim())
        .filter(|a| !a.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if list.len() > 100 {
        return Err(Error::new(
            4202,
            format!("{field} holds too many addresses"),
        ));
    }
    for a in &list {
        let address = bare(a);
        let ok = a.len() <= 320
            && !a.contains(['\r', '\n'])
            && address.split_once('@').is_some_and(|(user, host)| {
                !user.is_empty()
                    && host.contains('.')
                    && !host.starts_with('.')
                    && !host.ends_with('.')
            })
            && !address.contains([' ', '<', '>', ',']);
        if !ok {
            return Err(Error::new(4202, format!("{a} isn't an email address.")));
        }
    }
    Ok(list)
}

/// `a@b.c, "Lima, Ana" <ana@d.e>; Lima, Ana <ana@d.e>` as one address each.
/// A comma inside quotes, or before any address, belongs to a name.
pub fn split(text: &str) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut quoted = false;
    for c in text.chars() {
        match c {
            '"' => quoted = !quoted,
            ',' | ';' if !quoted => {
                parts.push(String::new());
                continue;
            }
            _ => {}
        }
        parts.last_mut().unwrap().push(c);
    }
    let mut out: Vec<String> = vec![];
    let mut name = String::new();
    for part in parts {
        if part.contains('@') {
            out.push(format!("{name}{part}").trim().to_owned());
            name.clear();
        } else if !part.trim().is_empty() {
            name.push_str(&part);
            name.push(',');
        }
    }
    if !name.trim().is_empty() {
        out.push(name.trim_end_matches(',').trim().to_owned());
    }
    out
}

/// The address in `Name <a@b.c>`, or the whole of `a@b.c`.
pub(crate) fn bare(address: &str) -> &str {
    match (address.rfind('<'), address.rfind('>')) {
        (Some(open), Some(close)) if open < close => address[open + 1..close].trim(),
        _ => address.trim(),
    }
}
fn name_of(address: &str) -> Option<&str> {
    address
        .rfind('<')
        .map(|open| address[..open].trim().trim_matches('"').trim())
        .filter(|n| !n.is_empty())
}

pub fn draft(p: &Value) -> Result<Draft> {
    let text = |key: &str, cap: usize| -> Result<String> {
        let v = p[key].as_str().unwrap_or("");
        if v.chars().count() > cap {
            return Err(Error::new(4202, format!("{key} is too long")));
        }
        Ok(v.to_owned())
    };
    let subject = text("subject", 998)?.trim().to_owned();
    if subject.contains(['\r', '\n']) {
        return Err(Error::new(4202, "The subject must be one line."));
    }
    Ok(Draft {
        to: addresses(&p["to"], "to")?,
        cc: addresses(&p["cc"], "cc")?,
        bcc: addresses(&p["bcc"], "bcc")?,
        subject,
        body: text("body", 200_000)?,
        reply_to: match p["reply_to"].as_str().map(str::trim) {
            Some(id) if id.len() > 512 => {
                return Err(Error::new(
                    4202,
                    "reply_to must be a message id from search",
                ));
            }
            Some(id) if !id.is_empty() => Some(id.to_owned()),
            _ => None,
        },
    })
}

/// RFC 2047 for a header word that isn't plain ASCII.
fn word(text: &str) -> String {
    if text.is_ascii() {
        text.to_owned()
    } else {
        format!(
            "=?UTF-8?B?{}?=",
            base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
        )
    }
}
fn address_header(list: &[String]) -> String {
    list.iter()
        .map(|a| match name_of(a) {
            Some(name) if name.is_ascii() => format!("\"{}\" <{}>", name.replace('"', ""), bare(a)),
            Some(name) => format!("{} <{}>", word(name), bare(a)),
            None => bare(a).to_owned(),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The message as RFC 5322 text: plain UTF-8, base64 in 76-column lines.
pub fn mime(draft: &Draft, thread: &[(&str, String)]) -> String {
    let mut out = String::new();
    for (name, list) in [("To", &draft.to), ("Cc", &draft.cc), ("Bcc", &draft.bcc)] {
        if !list.is_empty() {
            out.push_str(&format!("{name}: {}\r\n", address_header(list)));
        }
    }
    out.push_str(&format!("Subject: {}\r\n", word(&draft.subject)));
    for (name, value) in thread {
        if !value.is_empty() && !value.contains(['\r', '\n']) {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    out.push_str("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n");
    let body = base64::engine::general_purpose::STANDARD
        .encode(draft.body.replace("\r\n", "\n").replace('\n', "\r\n"));
    for chunk in body.as_bytes().chunks(76) {
        out.push_str(std::str::from_utf8(chunk).unwrap());
        out.push_str("\r\n");
    }
    out
}

fn recipients(list: &[String]) -> Value {
    json!(
        list.iter()
            .map(|a| match name_of(a) {
                Some(name) => json!({"emailAddress":{"address":bare(a),"name":name}}),
                None => json!({"emailAddress":{"address":bare(a)}}),
            })
            .collect::<Vec<_>>()
    )
}

/// Sends `draft`, or with `send` false saves it to Drafts, from the grant
/// `grant` names when given. Only the draft card calls this, with what the
/// user left on it. A send that got no whole answer may have gone out, and
/// says so.
pub(crate) async fn deliver(
    home: &Path,
    svc: &Service,
    draft: &Draft,
    send: bool,
    grant: Option<&Value>,
) -> Result<Value> {
    let request = |method, path: String, body: Option<Value>| async move {
        request_as(home, svc, grant, method, &path, body.as_ref(), &[]).await
    };
    let uncertain = |e: Error| {
        if e.code != UNCERTAIN {
            e
        } else if send {
            Error::new(
                e.code,
                format!(
                    "{} It may have gone out: look in Sent in {} before you send it again.",
                    e.message, svc.name
                ),
            )
        } else {
            Error::new(
                e.code,
                format!(
                    "{} It may be saved: look in Drafts in {} before you save it again.",
                    e.message, svc.name
                ),
            )
        }
    };
    // A step that can't have sent or saved the email: no answer is a failure.
    let certain = |e: Error| {
        if e.code == UNCERTAIN {
            Error::new(5240, e.message)
        } else {
            e
        }
    };
    // The message a reply answers was deleted since the card showed.
    let gone = |e: Error| {
        if e.code == 4215 {
            Error::new(
                e.code,
                format!(
                    "The email this answers is no longer in {}. Discard this and ask for a new draft.",
                    svc.name
                ),
            )
        } else {
            e
        }
    };
    // Outlook makes the draft before sending it, so for a save each step
    // may have left it in Drafts, and for a send only the last one counts.
    let step = |e: Error| if send { certain(e) } else { uncertain(e) };
    if send && draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
        return Err(Error::new(4202, "Add someone to send it to."));
    }
    if svc.google() {
        let mut thread_id = None;
        let mut thread = vec![];
        if let Some(id) = &draft.reply_to {
            let original = request(
                reqwest::Method::GET,
                format!(
                    "/gmail/v1/users/me/messages/{}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References",
                    enc(id)
                ),
                None,
            )
            .await
            .map_err(|e| gone(certain(e)))?;
            let message_id = header(&original, "Message-ID").to_owned();
            let references = format!("{} {message_id}", header(&original, "References"))
                .trim()
                .to_owned();
            thread.push(("In-Reply-To", message_id));
            thread.push(("References", references));
            thread_id = original["threadId"].as_str().map(str::to_owned);
        }
        let mut message = json!({"raw": b64url(mime(draft, &thread).as_bytes())});
        if let Some(t) = thread_id {
            message["threadId"] = json!(t);
        }
        let (path, body) = if send {
            ("/gmail/v1/users/me/messages/send", message)
        } else {
            ("/gmail/v1/users/me/drafts", json!({"message": message}))
        };
        let done = request(reqwest::Method::POST, path.to_owned(), Some(body))
            .await
            .map_err(uncertain)?;
        return Ok(json!({"id": done["id"]}));
    }
    let fields = json!({
        "subject": draft.subject,
        "body": {"contentType": "Text", "content": draft.body},
        "toRecipients": recipients(&draft.to),
        "ccRecipients": recipients(&draft.cc),
        "bccRecipients": recipients(&draft.bcc),
    });
    // A reply starts as Outlook's own reply draft, so it stays in its thread.
    let created = match &draft.reply_to {
        Some(id) => {
            let reply = request(
                reqwest::Method::POST,
                format!("/v1.0/me/messages/{}/createReply", enc(id)),
                Some(json!({})),
            )
            .await
            .map_err(|e| gone(step(e)))?;
            let draft_id = reply["id"].as_str().unwrap_or("").to_owned();
            request(
                reqwest::Method::PATCH,
                format!("/v1.0/me/messages/{}", enc(&draft_id)),
                Some(fields),
            )
            .await
            .map_err(step)?;
            draft_id
        }
        None => request(
            reqwest::Method::POST,
            "/v1.0/me/messages".to_owned(),
            Some(fields),
        )
        .await
        .map_err(step)?["id"]
            .as_str()
            .unwrap_or("")
            .to_owned(),
    };
    if created.is_empty() {
        return Err(Error::new(5240, "Outlook did not make the draft."));
    }
    if send {
        request(
            reqwest::Method::POST,
            format!("/v1.0/me/messages/{}/send", enc(&created)),
            Some(json!({})),
        )
        .await
        .map_err(uncertain)?;
    }
    Ok(json!({"id": created}))
}

#[cfg(test)]
#[path = "mail_tests.rs"]
mod tests;
