use super::*;
use base64::Engine;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

/// A home whose IMAP mail fields are `fields`.
fn home_with(fields: &[(&str, &str)]) -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    let text = fields
        .iter()
        .map(|(k, v)| format!("{k}={}\n", serde_json::to_string(v).unwrap()))
        .collect::<String>();
    std::fs::write(home.path().join(".env"), text).unwrap();
    home
}

#[test]
fn servers_come_from_the_fields_or_the_address() {
    let known = home_with(&[(ADDRESS, "ana@icloud.com"), (PASSWORD, "pw")]);
    let cfg = config(known.path(), None).unwrap();
    assert_eq!(cfg.name, "iCloud Mail");
    assert_eq!(cfg.username, "ana@icloud.com");
    assert_eq!(
        cfg.imap,
        Server {
            host: "imap.mail.me.com".into(),
            port: 993,
            implicit_tls: true
        }
    );
    assert_eq!(cfg.smtp.port, 587);
    assert!(!cfg.smtp.implicit_tls);

    // Any other domain: imap. and smtp. on it, over TLS.
    let other = home_with(&[(ADDRESS, "Ana <ana@example.org>"), (PASSWORD, "pw")]);
    let cfg = config(other.path(), None).unwrap();
    assert_eq!(cfg.address, "ana@example.org");
    assert_eq!(
        cfg.from, "\"Ana\" <ana@example.org>",
        "the From header keeps the name"
    );
    assert_eq!(cfg.name, NAME);
    assert_eq!(
        (cfg.imap.host.as_str(), cfg.imap.port),
        ("imap.example.org", 993)
    );
    assert_eq!(
        (cfg.smtp.host.as_str(), cfg.smtp.port),
        ("smtp.example.org", 465)
    );

    // Servers the user named win, ports included.
    let named = home_with(&[
        (ADDRESS, "ana@icloud.com"),
        (PASSWORD, "pw"),
        (IMAP_HOST, "Mail.Example.org:143"),
        (SMTP_HOST, "[::1]:1025"),
        (USERNAME, "ana"),
    ]);
    let cfg = config(named.path(), None).unwrap();
    assert_eq!(cfg.name, NAME, "not iCloud's servers, so not iCloud");
    assert_eq!(cfg.username, "ana");
    assert_eq!(
        (cfg.imap.host.as_str(), cfg.imap.port, cfg.imap.implicit_tls),
        ("mail.example.org", 143, false)
    );
    assert_eq!((cfg.smtp.host.as_str(), cfg.smtp.port), ("::1", 1025));
    assert!(cfg.smtp.local());
    // STARTTLS on its own ports and on this computer; TLS from the start on
    // any other, as a server behind a mapped port has it.
    for (text, implicit) in [
        ("mail.example.org:1993", true),
        ("mail.example.org:587", false),
        ("mail.example.org:2525", false),
        ("127.0.0.1:1143", false),
        ("127.0.0.1:993", true),
    ] {
        assert_eq!(
            server(text, 993, "x").unwrap().implicit_tls,
            implicit,
            "{text}"
        );
    }

    // The grant names the mailbox, never its password.
    let again = home_with(&[
        (ADDRESS, "ana@icloud.com"),
        (PASSWORD, "another"),
        (IMAP_HOST, "mail.example.org:143"),
        (SMTP_HOST, "[::1]:1025"),
        (USERNAME, "ana"),
    ]);
    assert_eq!(config(again.path(), None).unwrap().grant(), cfg.grant());
    assert_ne!(config(other.path(), None).unwrap().grant(), cfg.grant());
    assert!(!format!("{cfg:?}").contains("pw"));
}

#[test]
fn a_mailbox_that_cant_work_says_why() {
    let empty = home_with(&[]);
    assert_eq!(config(empty.path(), None).unwrap_err().code, 4210);
    let outlook = home_with(&[(ADDRESS, "ana@outlook.com"), (PASSWORD, "pw")]);
    assert!(
        config(outlook.path(), None)
            .unwrap_err()
            .message
            .contains("Outlook connector")
    );
    for bad in [
        "mail example.org",
        "mail.example.org:99999",
        "-mail.example.org",
        "[::1",
    ] {
        let home = home_with(&[
            (ADDRESS, "ana@example.org"),
            (PASSWORD, "pw"),
            (IMAP_HOST, bad),
        ]);
        assert_eq!(config(home.path(), None).unwrap_err().code, 4202, "{bad}");
    }
    let two = home_with(&[(ADDRESS, "a@example.org, b@example.org"), (PASSWORD, "pw")]);
    assert_eq!(config(two.path(), None).unwrap_err().code, 4202);
}

#[test]
fn search_words_become_an_imap_search() {
    assert_eq!(
        query("", false).unwrap(),
        Query {
            folder: Folder::Inbox,
            criteria: "ALL".into()
        }
    );
    let q = query(
        r#"from:"Ana Lima" is:unread -subject:newsletter after:2026-03-01 invoice in:sent"#,
        false,
    )
    .unwrap();
    assert_eq!(q.folder, Folder::Special(Special::Sent));
    assert_eq!(
        q.criteria,
        r#"FROM "Ana Lima" UNSEEN NOT SUBJECT "newsletter" SINCE 1-Mar-2026 TEXT "invoice""#
    );
    assert_eq!(
        query("in:Receipts/2026", false).unwrap().folder,
        Folder::Named("Receipts/2026".into())
    );
    // Nothing a word holds can end the command or start another.
    let q = query("x\"\r\nA1 DELETE INBOX", true).unwrap();
    assert!(!q.criteria.contains(['\r', '\n']));
    assert!(q.criteria.starts_with(r#"TEXT "x"#));
    assert!(
        query("café", false)
            .unwrap()
            .criteria
            .starts_with("CHARSET UTF-8 ")
    );
    // Text that isn't ASCII goes as a literal where the server takes one.
    assert_eq!(
        query("subject:café", true).unwrap().criteria,
        "CHARSET UTF-8 SUBJECT {5+}\r\ncafé"
    );
    assert_eq!(
        query("subject:café", false).unwrap().criteria,
        "CHARSET UTF-8 SUBJECT \"café\""
    );
    assert_eq!(query("has:attachment", false).unwrap_err().code, 4202);
    assert_eq!(query("is:muted", false).unwrap_err().code, 4202);
    assert_eq!(query("before:soon", false).unwrap_err().code, 4202);
}

#[test]
fn message_ids_name_their_folder_and_its_numbering() {
    let id = message_id("Archive.2026", 7, 42);
    assert_eq!(parse_id(&id).unwrap(), ("Archive.2026".to_owned(), 7, 42));
    for bad in ["", "7", "7.42", "x.42.SU5CT1g", "7.42.%%%"] {
        assert_eq!(parse_id(bad).unwrap_err().code, 4202, "{bad}");
    }
}

// --- A mail server on this computer ----------------------------------------

const PLAIN: &str = "From: Ana Lima <ana@example.org>\r\nTo: me@example.org\r\nSubject: Friday\r\nDate: Thu, 5 Mar 2026 10:00:00 +0000\r\nMessage-ID: <m1@example.org>\r\n\r\nLunch on Friday?\r\n";
const HTML: &str = "From: Bo <bo@example.net>\r\nTo: me@example.org\r\nSubject: =?UTF-8?B?Q2Fmw6k=?=\r\nDate: Fri, 6 Mar 2026 09:00:00 +0000\r\nMessage-ID: <m2@example.net>\r\nReferences: <m0@example.net>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>See <b>the menu</b></p><p>Bo</p>\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=menu.pdf\r\n\r\nJVBERi0=\r\n--b--\r\n";

/// The id of HTML, the message a test reply answers.
pub(crate) fn reply_target() -> String {
    message_id("INBOX", 7, 2)
}

/// What the fake servers saw.
#[derive(Default)]
pub(crate) struct Seen {
    pub commands: Vec<String>,
    /// Folder, flags and message of each APPEND.
    pub appended: Vec<(String, String, String)>,
    /// Envelope recipients and message of each SMTP send.
    pub sent: Vec<(Vec<String>, String)>,
}

/// An IMAP server holding PLAIN (UID 1, read) and HTML (UID 2, unread) in
/// INBOX, with special-use Sent and Drafts. It takes the password "secret".
pub(crate) async fn imap_server(seen: Arc<Mutex<Seen>>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            let seen = seen.clone();
            tokio::spawn(async move {
                let (read, mut write) = socket.into_split();
                let mut read = BufReader::new(read);
                write
                    .write_all(b"* OK [CAPABILITY IMAP4rev1] fake\r\n")
                    .await
                    .unwrap();
                let mut line = String::new();
                while read.read_line(&mut line).await.unwrap_or(0) > 0 {
                    // A LITERAL+ string goes on the next line, without a wait.
                    while line.trim_end().ends_with("+}") {
                        read.read_line(&mut line).await.unwrap();
                    }
                    let text = line.trim_end().to_owned();
                    line.clear();
                    seen.lock().unwrap().commands.push(text.clone());
                    let (tag, command) = text.split_once(' ').unwrap();
                    let upper = command.to_ascii_uppercase();
                    let mut out = String::new();
                    if upper.starts_with("STARTTLS") {
                        out = format!("{tag} BAD no TLS here\r\n");
                    } else if upper.starts_with("CAPABILITY") {
                        out = format!("* CAPABILITY IMAP4rev1 LITERAL+\r\n{tag} OK done\r\n");
                    } else if upper.starts_with("LOGIN") {
                        out = if command.ends_with("\"secret\"") {
                            format!("{tag} OK signed in\r\n")
                        } else {
                            format!("{tag} NO [AUTHENTICATIONFAILED] wrong password\r\n")
                        };
                    } else if upper.starts_with("LIST") {
                        out.push_str("* LIST (\\HasNoChildren) \"/\" \"INBOX\"\r\n");
                        out.push_str("* LIST (\\HasNoChildren \\Sent) \"/\" \"Sent Items\"\r\n");
                        out.push_str("* LIST (\\HasNoChildren \\Drafts) \"/\" \"Drafts\"\r\n");
                        out.push_str(&format!("{tag} OK listed\r\n"));
                    } else if upper.starts_with("EXAMINE") {
                        out = if command.contains("\"INBOX\"") {
                            format!(
                                "* 2 EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n{tag} OK [READ-ONLY] done\r\n"
                            )
                        } else {
                            format!("{tag} NO no such folder\r\n")
                        };
                    } else if upper.starts_with("UID SEARCH") {
                        let uids = if upper.contains("UNSEEN") { "2" } else { "1 2" };
                        out = format!("* SEARCH {uids}\r\n{tag} OK searched\r\n");
                    } else if upper.starts_with("UID FETCH") {
                        let set = command.split(' ').nth(2).unwrap();
                        for uid in set.split(',') {
                            let (raw, flags) = match uid {
                                "1" => (PLAIN, "\\Seen"),
                                "2" => (HTML, ""),
                                _ => continue,
                            };
                            let (section, data) = if upper.contains("BODY.PEEK[HEADER]") {
                                (
                                    "BODY[HEADER]",
                                    raw.split("\r\n\r\n").next().unwrap().to_owned() + "\r\n\r\n",
                                )
                            } else {
                                ("BODY[]<0>", raw.to_owned())
                            };
                            out.push_str(&format!(
                                "* {uid} FETCH (UID {uid} FLAGS ({flags}) RFC822.SIZE {} {section} {{{}}}\r\n{data})\r\n",
                                raw.len(),
                                data.len()
                            ));
                        }
                        out.push_str(&format!("{tag} OK fetched\r\n"));
                    } else if upper.starts_with("APPEND") {
                        let size: usize = command
                            .rsplit_once('{')
                            .unwrap()
                            .1
                            .trim_end_matches('}')
                            .parse()
                            .unwrap();
                        write.write_all(b"+ go ahead\r\n").await.unwrap();
                        let mut body = vec![0; size + 2];
                        read.read_exact(&mut body).await.unwrap();
                        body.truncate(size);
                        let folder = command.split('"').nth(1).unwrap().to_owned();
                        let flags = command
                            .split_once('(')
                            .and_then(|(_, rest)| rest.split_once(')'))
                            .map(|(f, _)| f.to_owned())
                            .unwrap_or_default();
                        seen.lock().unwrap().appended.push((
                            folder,
                            flags,
                            String::from_utf8(body).unwrap(),
                        ));
                        out = format!("{tag} OK appended\r\n");
                    } else if upper.starts_with("LOGOUT") {
                        write
                            .write_all(format!("* BYE\r\n{tag} OK bye\r\n").as_bytes())
                            .await
                            .unwrap();
                        return;
                    } else {
                        out = format!("{tag} BAD unknown\r\n");
                    }
                    write.write_all(out.as_bytes()).await.unwrap();
                }
            });
        }
    });
    addr
}

/// An SMTP server that takes the password "secret".
pub(crate) async fn smtp_server(seen: Arc<Mutex<Seen>>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            let seen = seen.clone();
            tokio::spawn(async move {
                let (read, mut write) = socket.into_split();
                let mut read = BufReader::new(read);
                write.write_all(b"220 fake ESMTP\r\n").await.unwrap();
                let mut to = vec![];
                let mut line = String::new();
                while read.read_line(&mut line).await.unwrap_or(0) > 0 {
                    let text = line.trim_end().to_owned();
                    line.clear();
                    let upper = text.to_ascii_uppercase();
                    let reply = if upper.starts_with("EHLO") {
                        "250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n".to_owned()
                    } else if let Some(token) = text.strip_prefix("AUTH PLAIN ") {
                        let plain = base64::engine::general_purpose::STANDARD
                            .decode(token)
                            .unwrap();
                        if plain.ends_with(b"\0secret") {
                            "235 ok\r\n".to_owned()
                        } else {
                            "535 5.7.8 wrong password\r\n".to_owned()
                        }
                    } else if upper.starts_with("RCPT TO:") {
                        to.push(text[8..].trim_matches(['<', '>']).to_owned());
                        "250 ok\r\n".to_owned()
                    } else if upper == "DATA" {
                        write.write_all(b"354 go\r\n").await.unwrap();
                        let mut data = String::new();
                        loop {
                            let mut l = String::new();
                            read.read_line(&mut l).await.unwrap();
                            if l == ".\r\n" {
                                break;
                            }
                            data.push_str(&l);
                        }
                        // "Vanish" is taken, then the connection drops unanswered.
                        if data.contains("Subject: Vanish\r\n") {
                            return;
                        }
                        seen.lock()
                            .unwrap()
                            .sent
                            .push((std::mem::take(&mut to), data));
                        "250 queued\r\n".to_owned()
                    } else if upper == "QUIT" {
                        write.write_all(b"221 bye\r\n").await.unwrap();
                        return;
                    } else {
                        "250 ok\r\n".to_owned()
                    };
                    write.write_all(reply.as_bytes()).await.unwrap();
                }
            });
        }
    });
    addr
}

/// A home set up for the fake servers, and what they see.
async fn mailbox(password: &str) -> (tempfile::TempDir, Config, Arc<Mutex<Seen>>) {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let imap = imap_server(seen.clone()).await;
    let smtp = smtp_server(seen.clone()).await;
    let home = home_with(&[
        (ADDRESS, "me@example.org"),
        (PASSWORD, password),
        (IMAP_HOST, &imap),
        (SMTP_HOST, &smtp),
    ]);
    let cfg = config(home.path(), None).unwrap();
    (home, cfg, seen)
}

#[tokio::test]
async fn search_and_read_never_mark_mail_read() {
    let (_home, cfg, seen) = mailbox("secret").await;
    let rows = search(&cfg, "", 10).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0]["subject"], "Café",
        "newest first, its subject decoded"
    );
    assert_eq!(rows[0]["from"], "Bo <bo@example.net>");
    assert_eq!(rows[0]["unread"], true);
    assert_eq!(rows[0]["snippet"], "See the menu Bo");
    assert_eq!(rows[1]["snippet"], "Lunch on Friday?");
    assert_eq!(rows[1]["unread"], false);

    let unread = search(&cfg, "is:unread", 10).await.unwrap();
    assert_eq!(unread.len(), 1);
    search(&cfg, "café", 10).await.unwrap();

    let message = read(&cfg, rows[0]["id"].as_str().unwrap()).await.unwrap();
    assert_eq!(message["body"], "See the menu\nBo");
    assert_eq!(message["attachments"], json!(["menu.pdf"]));
    assert_eq!(message["thread_id"], "m2@example.net");

    let commands = seen.lock().unwrap().commands.clone();
    assert!(commands.iter().any(|c| c.contains("UID SEARCH UNSEEN")));
    assert!(
        commands
            .iter()
            .any(|c| c.ends_with("UID SEARCH CHARSET UTF-8 TEXT {5+}\r\ncafé")),
        "{commands:?}"
    );
    // Reading peeks and examines; nothing selects a folder to change it.
    assert!(
        commands
            .iter()
            .all(|c| !c.contains(" SELECT ") && !c.contains("STORE"))
    );
    assert!(
        commands
            .iter()
            .filter(|c| c.contains("UID FETCH"))
            .all(|c| c.contains("BODY.PEEK"))
    );

    // A folder that isn't there, and a message that isn't.
    assert_eq!(search(&cfg, "in:archive", 5).await.unwrap_err().code, 4215);
    assert_eq!(
        read(&cfg, &message_id("INBOX", 7, 9))
            .await
            .unwrap_err()
            .code,
        4215
    );
    assert_eq!(
        read(&cfg, &message_id("INBOX", 6, 1))
            .await
            .unwrap_err()
            .code,
        4215,
        "renumbered"
    );
}

#[tokio::test]
async fn a_sent_reply_stays_in_its_thread_and_is_filed() {
    let (_home, cfg, seen) = mailbox("secret").await;
    let id = message_id("INBOX", 7, 2);
    assert_eq!(original(&cfg, &id).await.unwrap().subject, "Café");
    let draft = mail::draft(&json!({
        "to": ["Bo <bo@example.net>"],
        "bcc": ["boss@example.org"],
        "subject": "Re: Café",
        "body": "Yes.\n.\nSee you",
        "reply_to": id,
    }))
    .unwrap();
    let done = deliver(&cfg, &draft, true, None).await.unwrap();
    assert_eq!(done["filed_in_sent"], true);
    let seen = seen.lock().unwrap();
    let (to, data) = &seen.sent[0];
    assert_eq!(to, &["bo@example.net", "boss@example.org"]);
    assert!(data.contains("From: me@example.org\r\n"));
    assert!(data.contains("In-Reply-To: <m2@example.net>\r\n"));
    assert!(data.contains("References: <m0@example.net> <m2@example.net>\r\n"));
    assert!(data.contains(&format!("Message-ID: {}\r\n", done["id"].as_str().unwrap())));
    assert!(
        !data.contains("Bcc:"),
        "who's copied blind isn't told to the others"
    );
    let (folder, flags, copy) = &seen.appended[0];
    assert_eq!((folder.as_str(), flags.as_str()), ("Sent Items", "\\Seen"));
    assert!(
        copy.contains("Bcc: boss@example.org\r\n"),
        "the user's copy keeps it"
    );
}

#[tokio::test]
async fn a_saved_draft_goes_to_drafts_and_nothing_is_sent() {
    let (_home, cfg, seen) = mailbox("secret").await;
    let draft = mail::draft(&json!({"subject": "Later", "body": "Not yet"})).unwrap();
    deliver(&cfg, &draft, false, None).await.unwrap();
    // Sending needs someone to send to.
    assert_eq!(
        deliver(&cfg, &draft, true, None).await.unwrap_err().code,
        4202
    );
    let seen = seen.lock().unwrap();
    assert!(seen.sent.is_empty());
    let (folder, flags, copy) = &seen.appended[0];
    assert_eq!(
        (folder.as_str(), flags.as_str()),
        ("Drafts", "\\Draft \\Seen")
    );
    assert!(copy.contains("Subject: Later\r\n"));
}

/// The server took the email and dropped without a word: it may have gone.
#[tokio::test]
async fn a_send_left_unanswered_says_where_to_look() {
    let (_home, cfg, _seen) = mailbox("secret").await;
    let draft =
        mail::draft(&json!({"to": ["bo@example.net"], "subject": "Vanish", "body": "x"})).unwrap();
    let e = deliver(&cfg, &draft, true, None).await.unwrap_err();
    assert_eq!(e.code, UNCERTAIN, "{}", e.message);
    assert!(e.message.contains("look in Sent"), "{}", e.message);
}

/// A server that can't be reached took nothing: the user is told so, not
/// to look in Sent.
#[tokio::test]
async fn a_send_that_never_connected_is_certain() {
    let (_home, mut cfg, _seen) = mailbox("secret").await;
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    cfg.smtp.port = closed.local_addr().unwrap().port();
    drop(closed);
    let draft =
        mail::draft(&json!({"to": ["bo@example.net"], "subject": "Hi", "body": "x"})).unwrap();
    let e = deliver(&cfg, &draft, true, None).await.unwrap_err();
    assert_eq!(e.code, 5240, "{}", e.message);
    assert!(
        e.message.contains("refused the connection"),
        "{}",
        e.message
    );
}

/// A reply goes in the thread its card was shown with, even once the
/// message it answers was archived.
#[tokio::test]
async fn a_reply_keeps_its_thread_after_the_original_moves() {
    let (_home, cfg, seen) = mailbox("secret").await;
    let kept = Original::from_form(
        &json!({"thread": {"message_id": "<m9@example.net>", "references": "<m8@example.net>"}}),
    )
    .unwrap();
    let draft = mail::draft(&json!({
        "to": ["bo@example.net"], "subject": "Re: Old", "body": "Yes.",
        "reply_to": message_id("INBOX", 7, 9),
    }))
    .unwrap();
    deliver(&cfg, &draft, true, Some(kept)).await.unwrap();
    let seen = seen.lock().unwrap();
    let data = &seen.sent[0].1;
    assert!(data.contains("In-Reply-To: <m9@example.net>\r\n"), "{data}");
    assert!(data.contains("References: <m8@example.net> <m9@example.net>\r\n"));
    assert!(
        seen.commands
            .iter()
            .all(|c| !c.contains("BODY.PEEK[HEADER]")),
        "not read again"
    );
}

#[tokio::test]
async fn a_wrong_password_is_told_to_the_user() {
    let (home, cfg, seen) = mailbox("wrong").await;
    let e = search(&cfg, "", 5).await.unwrap_err();
    assert_eq!(e.code, 4210);
    assert!(e.message.contains("app password"));
    assert!(
        seen.lock()
            .unwrap()
            .commands
            .iter()
            .all(|c| !c.contains("SEARCH"))
    );
    let probe = probe(home.path(), None).await;
    assert_eq!(probe["ok"], false);
    assert!(probe["message"].as_str().unwrap().starts_with("Reading:"));
}

#[tokio::test]
async fn the_test_signs_in_to_both_servers() {
    let (home, _cfg, _seen) = mailbox("secret").await;
    assert_eq!(
        probe(home.path(), None).await,
        json!({"ok": true, "message": "Connected as me@example.org."})
    );
}
