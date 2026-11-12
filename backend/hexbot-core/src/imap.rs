//! The IMAP mail connector: any other mailbox that speaks IMAP and SMTP,
//! such as iCloud, Fastmail or Yahoo, behind the same `hexbot_mail` as Gmail
//! and Outlook. IMAP searches and reads the mailbox and saves drafts; SMTP
//! sends, and only the draft card calls that (`runtime_mail.rs`).
//!
//! The user saves the address and an app password in Settings, Plugins, as
//! connector fields in `.env`, which no bot shell reads
//! (`credential-policy.json`). The daemon opens every connection, so the
//! model never sees the password. Well-known services need nothing else;
//! for any other the user names the servers.
//!
//! Every connection is TLS, verified against the web's roots, except on the
//! daemon's own computer, where a bridge such as Proton Mail Bridge serves a
//! certificate of its own: there TLS is used when offered and not verified,
//! since nothing leaves the computer.
use crate::{
    Error, Result,
    accounts::UNCERTAIN,
    mail::{self, Draft},
};
use async_imap::{
    Client, Session,
    error::Error as ImapError,
    imap_proto::NameAttribute,
    types::{Fetch, Flag},
};
use base64::Engine;
use futures_util::TryStreamExt;
use mail_parser::{Address, MessageParser, MimeHeaders};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
};
use tokio_rustls::{
    TlsConnector,
    rustls::{self, pki_types::ServerName},
};

/// The connector's id, its toolset and the account `hexbot_mail` names.
pub(crate) const ID: &str = "imap";
/// What the connector is called where no service name fits.
pub(crate) const NAME: &str = "IMAP mail";

const ADDRESS: &str = "IMAP_ADDRESS";
const PASSWORD: &str = "IMAP_PASSWORD";
const USERNAME: &str = "IMAP_USERNAME";
const IMAP_HOST: &str = "IMAP_HOST";
const SMTP_HOST: &str = "SMTP_HOST";

const MAX_RESULTS: usize = 20;
/// How much of each message search reads for its snippet.
const PREVIEW_BYTES: usize = 16 * 1024;
/// How much of a message read takes: its text, and any attachments' names
/// that fit.
const MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const CONNECT: Duration = Duration::from_secs(20);
const OPERATION: Duration = Duration::from_secs(90);

/// A service whose servers Hexbot knows, by the domains of its addresses.
struct Known {
    name: &'static str,
    domains: &'static [&'static str],
    imap: (&'static str, u16),
    smtp: (&'static str, u16),
    /// The service files what SMTP sends in Sent itself, so Hexbot doesn't.
    files_sent: bool,
}

const KNOWN: &[Known] = &[
    Known {
        name: "iCloud Mail",
        domains: &["icloud.com", "me.com", "mac.com"],
        imap: ("imap.mail.me.com", 993),
        smtp: ("smtp.mail.me.com", 587),
        files_sent: false,
    },
    Known {
        name: "Fastmail",
        domains: &["fastmail.com", "fastmail.fm"],
        imap: ("imap.fastmail.com", 993),
        smtp: ("smtp.fastmail.com", 465),
        files_sent: false,
    },
    Known {
        name: "Yahoo Mail",
        domains: &["yahoo.com", "ymail.com", "rocketmail.com"],
        imap: ("imap.mail.yahoo.com", 993),
        smtp: ("smtp.mail.yahoo.com", 465),
        files_sent: false,
    },
    Known {
        name: "AOL Mail",
        domains: &["aol.com"],
        imap: ("imap.aol.com", 993),
        smtp: ("smtp.aol.com", 465),
        files_sent: false,
    },
    Known {
        name: "Zoho Mail",
        domains: &["zoho.com", "zohomail.com"],
        imap: ("imap.zoho.com", 993),
        smtp: ("smtp.zoho.com", 465),
        files_sent: false,
    },
    Known {
        name: "GMX",
        domains: &["gmx.net", "gmx.de", "gmx.at", "gmx.ch"],
        imap: ("imap.gmx.net", 993),
        smtp: ("mail.gmx.net", 465),
        files_sent: false,
    },
    Known {
        name: "GMX",
        domains: &["gmx.com"],
        imap: ("imap.gmx.com", 993),
        smtp: ("mail.gmx.com", 465),
        files_sent: false,
    },
    Known {
        name: "Yandex Mail",
        domains: &["yandex.com", "yandex.ru"],
        imap: ("imap.yandex.com", 993),
        smtp: ("smtp.yandex.com", 465),
        files_sent: false,
    },
    Known {
        name: "mailbox.org",
        domains: &["mailbox.org"],
        imap: ("imap.mailbox.org", 993),
        smtp: ("smtp.mailbox.org", 465),
        files_sent: false,
    },
    Known {
        name: "Posteo",
        domains: &["posteo.de", "posteo.net"],
        imap: ("posteo.de", 993),
        smtp: ("posteo.de", 465),
        files_sent: false,
    },
    // Gmail with an app password, for those who'd rather not sign in.
    Known {
        name: "Gmail",
        domains: &["gmail.com", "googlemail.com"],
        imap: ("imap.gmail.com", 993),
        smtp: ("smtp.gmail.com", 465),
        files_sent: true,
    },
];

/// Microsoft stopped taking passwords over IMAP for these.
const OUTLOOK_DOMAINS: &[&str] = &["outlook.com", "hotmail.com", "live.com", "msn.com"];

/// One server: where it is, and how it starts TLS.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Server {
    pub host: String,
    pub port: u16,
    /// TLS from the first byte; STARTTLS on 143, 587, 25 and 2525, and on
    /// this computer.
    pub implicit_tls: bool,
}

impl Server {
    /// On the daemon's own computer: TLS is used when offered and its
    /// certificate isn't checked, as a local bridge serves its own.
    fn local(&self) -> bool {
        loopback(&self.host)
    }
}

fn loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// The mailbox as the user set it up.
#[derive(Clone)]
pub(crate) struct Config {
    pub address: String,
    /// The address as the From header gives it, with the user's name.
    from: String,
    username: String,
    password: String,
    /// The service as people call it: "iCloud Mail", or "IMAP mail".
    pub name: String,
    pub imap: Server,
    pub smtp: Server,
    files_sent: bool,
}

impl Config {
    /// Which mailbox this is, without its password: a draft goes from the
    /// mailbox its card showed, or not at all.
    pub(crate) fn grant(&self) -> String {
        let id = format!(
            "{}\n{}\n{}:{}\n{}:{}",
            self.address.to_ascii_lowercase(),
            self.username,
            self.imap.host,
            self.imap.port,
            self.smtp.host,
            self.smtp.port
        );
        format!("{:x}", Sha256::digest(id.as_bytes()))[..16].to_owned()
    }
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("address", &self.address)
            .field("username", &self.username)
            .field("name", &self.name)
            .field("imap", &self.imap)
            .field("smtp", &self.smtp)
            .finish_non_exhaustive()
    }
}

/// `host`, `host:port` or `[v6]:port`, with the port it defaults to.
fn server(text: &str, default_port: u16, field: &str) -> Result<Server> {
    let text = text.trim();
    let bad = || {
        Error::new(
            4202,
            format!(
                "{field} must be a server name, such as mail.example.com or mail.example.com:993."
            ),
        )
    };
    let (host, port) = if let Some(rest) = text.strip_prefix('[') {
        let (host, rest) = rest.split_once(']').ok_or_else(bad)?;
        match rest.strip_prefix(':') {
            Some(port) => (host, Some(port)),
            None if rest.is_empty() => (host, None),
            None => return Err(bad()),
        }
    } else {
        match text.rsplit_once(':') {
            Some((host, port)) if !host.contains(':') => (host, Some(port)),
            Some(_) => (text, None),
            None => (text, None),
        }
    };
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let ip = host.parse::<std::net::IpAddr>().is_ok();
    let name_ok = !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && !host.starts_with(['.', '-']);
    if !ip && !name_ok {
        return Err(bad());
    }
    let port = match port {
        Some(p) => p
            .trim()
            .parse::<u16>()
            .ok()
            .filter(|p| *p > 0)
            .ok_or_else(bad)?,
        None => default_port,
    };
    // STARTTLS on its own ports and on this computer, where a bridge uses
    // it on any port; TLS from the first byte everywhere else.
    let implicit_tls =
        matches!(port, 993 | 465) || (!loopback(&host) && !matches!(port, 143 | 587 | 25 | 2525));
    Ok(Server {
        host,
        port,
        implicit_tls,
    })
}

/// The mailbox from its fields, for `bot` (its own values first) or the
/// daemon. Servers the user left empty come from the known services, or
/// `imap.` and `smtp.` on the address's domain.
pub(crate) fn config(home: &Path, bot: Option<&str>) -> Result<Config> {
    let get = |key| crate::connectors::value(home, bot, key);
    let not_set_up = || {
        Error::new(
            4210,
            format!("{NAME} isn't set up. Add your address and app password in Settings, Plugins."),
        )
    };
    let address = get(ADDRESS)?.ok_or_else(not_set_up)?;
    let password = get(PASSWORD)?.ok_or_else(not_set_up)?;
    let (address, from) = match mail::addresses(&json!(address.trim()), "address")?.as_slice() {
        [one] => (
            mail::bare(one).to_owned(),
            mail::address_header(std::slice::from_ref(one)),
        ),
        _ => {
            return Err(Error::new(
                4202,
                "The email address must be one address, such as ana@example.com.",
            ));
        }
    };
    let domain = address
        .rsplit_once('@')
        .map(|(_, d)| d.to_ascii_lowercase())
        .unwrap_or_default();
    let known = KNOWN.iter().find(|k| k.domains.contains(&domain.as_str()));
    let imap_host = get(IMAP_HOST)?;
    let smtp_host = get(SMTP_HOST)?;
    if OUTLOOK_DOMAINS.contains(&domain.as_str()) && imap_host.is_none() {
        return Err(Error::new(
            4202,
            "Outlook.com no longer takes app passwords over IMAP. Connect the Outlook connector instead.",
        ));
    }
    let imap = match &imap_host {
        Some(h) => server(h, 993, "The IMAP server")?,
        None => match known {
            Some(k) => server(k.imap.0, k.imap.1, "The IMAP server")?,
            None => server(&format!("imap.{domain}"), 993, "The IMAP server")?,
        },
    };
    let smtp = match &smtp_host {
        Some(h) => server(h, 465, "The SMTP server")?,
        None => match known.filter(|_| imap_host.is_none()) {
            Some(k) => server(k.smtp.0, k.smtp.1, "The SMTP server")?,
            None => server(&format!("smtp.{domain}"), 465, "The SMTP server")?,
        },
    };
    // A known service by its own servers keeps its name.
    let known = known.filter(|k| imap.host == k.imap.0);
    Ok(Config {
        username: get(USERNAME)?.unwrap_or_else(|| address.clone()),
        address,
        from,
        password,
        name: known.map_or(NAME, |k| k.name).to_owned(),
        imap,
        smtp,
        files_sent: known.is_some_and(|k| k.files_sent),
    })
}

/// Whether `bot` has the connector on and set up.
pub(crate) fn on(home: &Path, bot: &str) -> Result<bool> {
    Ok(crate::connectors::enabled(home, bot, ID)?
        && crate::connectors::set_up(home, Some(bot), ID)?)
}

// --- Connections ----------------------------------------------------------

/// A connection, before or after TLS.
#[derive(Debug)]
enum Stream {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_read(cx, buf),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}
impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_write(cx, buf),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_flush(cx),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_shutdown(cx),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }
}

/// Accepts any certificate. Only for a server on the daemon's own computer.
#[derive(Debug)]
struct LocalCertificate(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for LocalCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn tls(server: &Server) -> Result<TlsConnector> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::new(5240, e.to_string()))?;
    let config = if server.local() {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(LocalCertificate(provider)))
            .with_no_client_auth()
    } else {
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        builder.with_root_certificates(roots).with_no_client_auth()
    };
    Ok(TlsConnector::from(Arc::new(config)))
}

/// Why a connection failed, in words the user can act on.
fn io_error(cfg: &Config, server: &Server, e: &std::io::Error) -> Error {
    never_connected(
        cfg,
        server,
        &e.to_string(),
        e.kind() == std::io::ErrorKind::ConnectionRefused,
    )
}

/// A connection that never opened, so nothing went: `text` is why.
fn never_connected(cfg: &Config, server: &Server, text: &str, refused: bool) -> Error {
    Error::new(
        5240,
        if text.contains("certificate") || text.contains("Certificate") {
            format!(
                "{}'s certificate isn't valid for {}. Check the server name in Settings, Plugins.",
                cfg.name, server.host
            )
        } else if refused {
            format!(
                "{} refused the connection on port {}. Check the server in Settings, Plugins.",
                server.host, server.port
            )
        } else {
            format!("{} could not be reached ({text}).", server.host)
        },
    )
}

async fn upgrade(cfg: &Config, server: &Server, tcp: TcpStream) -> Result<Stream> {
    let name = ServerName::try_from(server.host.clone())
        .map_err(|_| Error::new(4202, format!("{} isn't a server name.", server.host)))?;
    let stream = tokio::time::timeout(CONNECT, tls(server)?.connect(name, tcp))
        .await
        .map_err(|_| Error::new(5240, format!("{} timed out.", server.host)))?
        .map_err(|e| io_error(cfg, server, &e))?;
    Ok(Stream::Tls(Box::new(stream)))
}

/// What a failed IMAP command becomes.
fn imap_error(cfg: &Config, e: ImapError) -> Error {
    match e {
        ImapError::No(text) | ImapError::Bad(text) => Error::new(
            5240,
            format!(
                "{} refused it: {}",
                cfg.name,
                text.trim().trim_end_matches('.')
            ),
        ),
        ImapError::Validate(_) => Error::new(4202, "That holds a character IMAP can't send."),
        ImapError::Parse(_) => Error::new(
            5240,
            format!("{} answered with something Hexbot can't read.", cfg.name),
        ),
        ImapError::Io(_) | ImapError::ConnectionLost => {
            Error::new(UNCERTAIN, format!("{} stopped answering.", cfg.name))
        }
        ImapError::Append => Error::new(5240, format!("{} wouldn't take the email.", cfg.name)),
        other => Error::new(5240, format!("{}: {other}", cfg.name)),
    }
}

/// A signed-in IMAP session.
async fn session(cfg: &Config) -> Result<Session<Stream>> {
    let server = &cfg.imap;
    let tcp = tokio::time::timeout(
        CONNECT,
        TcpStream::connect((server.host.as_str(), server.port)),
    )
    .await
    .map_err(|_| Error::new(5240, format!("{} timed out.", server.host)))?
    .map_err(|e| io_error(cfg, server, &e))?;
    let lost = |e: std::io::Error| io_error(cfg, server, &e);
    let mut client = if server.implicit_tls {
        Client::new(upgrade(cfg, server, tcp).await?)
    } else {
        Client::new(Stream::Plain(tcp))
    };
    client
        .read_response()
        .await
        .map_err(lost)?
        .ok_or_else(|| Error::new(5240, format!("{} closed the connection.", server.host)))?;
    if !server.implicit_tls {
        match client.run_command_and_check_ok("STARTTLS", None).await {
            Ok(()) => {
                let Stream::Plain(tcp) = client.into_inner() else {
                    unreachable!("STARTTLS runs before TLS")
                };
                client = Client::new(upgrade(cfg, server, tcp).await?);
            }
            // Only a server on this computer may go without TLS.
            Err(ImapError::No(_) | ImapError::Bad(_)) if server.local() => {}
            Err(ImapError::No(_) | ImapError::Bad(_)) => {
                return Err(Error::new(
                    5240,
                    format!(
                        "{} doesn't offer TLS on port {}. Try port 993.",
                        server.host, server.port
                    ),
                ));
            }
            Err(e) => return Err(imap_error(cfg, e)),
        }
    }
    client
        .login(&cfg.username, &cfg.password)
        .await
        .map_err(|(e, _)| match e {
            ImapError::No(_) | ImapError::Bad(_) => Error::new(
                4210,
                format!(
                    "{} refused the sign-in. Check the address and app password in Settings, Plugins.",
                    cfg.name
                ),
            ),
            e => imap_error(cfg, e),
        })
}

/// Runs `work` on a signed-in session within the time an answer gets, then
/// signs out.
async fn with_session<T>(
    cfg: &Config,
    work: impl AsyncFnOnce(&mut Session<Stream>) -> Result<T>,
) -> Result<T> {
    tokio::time::timeout(OPERATION, async {
        let mut session = session(cfg).await?;
        let out = work(&mut session).await;
        let _ = session.logout().await;
        out
    })
    .await
    .map_err(|_| Error::new(UNCERTAIN, format!("{} timed out.", cfg.name)))?
}

// --- Folders --------------------------------------------------------------

/// A folder named by what it holds, which each server calls its own way.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Special {
    Sent,
    Drafts,
    Archive,
    Trash,
    Junk,
    All,
}

impl Special {
    fn from_word(word: &str) -> Option<Special> {
        Some(match word {
            "sent" => Special::Sent,
            "drafts" | "draft" => Special::Drafts,
            "archive" => Special::Archive,
            "trash" | "bin" | "deleted" => Special::Trash,
            "junk" | "spam" => Special::Junk,
            "all" | "anywhere" => Special::All,
            _ => return None,
        })
    }
    fn word(self) -> &'static str {
        match self {
            Special::Sent => "Sent",
            Special::Drafts => "Drafts",
            Special::Archive => "Archive",
            Special::Trash => "Trash",
            Special::Junk => "Junk",
            Special::All => "All Mail",
        }
    }
    fn attribute(self, a: &NameAttribute<'_>) -> bool {
        matches!(
            (self, a),
            (Special::Sent, NameAttribute::Sent)
                | (Special::Drafts, NameAttribute::Drafts)
                | (Special::Archive, NameAttribute::Archive)
                | (Special::Trash, NameAttribute::Trash)
                | (Special::Junk, NameAttribute::Junk)
                | (Special::All, NameAttribute::All)
        )
    }
    /// What servers without special-use flags call it.
    fn names(self) -> &'static [&'static str] {
        match self {
            Special::Sent => &[
                "Sent",
                "Sent Messages",
                "Sent Items",
                "Sent Mail",
                "INBOX.Sent",
            ],
            Special::Drafts => &["Drafts", "Draft", "INBOX.Drafts"],
            Special::Archive => &["Archive", "Archives", "INBOX.Archive"],
            Special::Trash => &["Trash", "Deleted Messages", "Deleted Items", "INBOX.Trash"],
            Special::Junk => &["Junk", "Spam", "Junk E-mail", "INBOX.Junk", "INBOX.Spam"],
            Special::All => &["All Mail", "[Gmail]/All Mail"],
        }
    }
}

/// The folder a search looks in.
#[derive(Debug, Clone, PartialEq)]
enum Folder {
    Inbox,
    Special(Special),
    Named(String),
}

/// The server's own name for `special`, if it has one.
async fn find(session: &mut Session<Stream>, special: Special) -> Result<Option<String>> {
    let names = session
        .list(Some(""), Some("*"))
        .await
        .map_err(|e| Error::new(5240, e.to_string()))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|e| Error::new(5240, e.to_string()))?;
    let selectable = |n: &&async_imap::types::Name| {
        !n.attributes()
            .iter()
            .any(|a| matches!(a, NameAttribute::NoSelect))
    };
    if let Some(n) = names
        .iter()
        .filter(selectable)
        .find(|n| n.attributes().iter().any(|a| special.attribute(a)))
    {
        return Ok(Some(n.name().to_owned()));
    }
    for want in special.names() {
        if let Some(n) = names
            .iter()
            .filter(selectable)
            .find(|n| n.name().eq_ignore_ascii_case(want))
        {
            return Ok(Some(n.name().to_owned()));
        }
    }
    Ok(None)
}

async fn folder_name(
    cfg: &Config,
    session: &mut Session<Stream>,
    folder: &Folder,
) -> Result<String> {
    match folder {
        Folder::Inbox => Ok("INBOX".to_owned()),
        Folder::Named(name) => Ok(name.clone()),
        Folder::Special(special) => find(session, *special).await?.ok_or_else(|| {
            Error::new(
                4215,
                format!("{} has no {} folder.", cfg.name, special.word()),
            )
        }),
    }
}

// --- Searching ------------------------------------------------------------

/// A search, in IMAP's words, and the folder it looks in.
#[derive(Debug, PartialEq)]
struct Query {
    folder: Folder,
    criteria: String,
}

/// An IMAP string, with nothing that could end the command. A quoted string
/// holds only ASCII, so other text goes as a literal the server takes
/// without a round trip (`literal`: it offers LITERAL+ or LITERAL-), or
/// quoted as most servers still take it.
fn string(text: &str, literal: bool) -> String {
    let clean: String = text.chars().filter(|c| !c.is_control()).collect();
    if literal && !clean.is_ascii() && clean.len() <= 4096 {
        return format!("{{{}+}}\r\n{clean}", clean.len());
    }
    format!("\"{}\"", clean.replace('\\', "\\\\").replace('"', "\\\""))
}

/// `2026-03-01` as IMAP's `1-Mar-2026`.
fn imap_date(text: &str) -> Option<String> {
    let date = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .or_else(|_| chrono::NaiveDate::parse_from_str(text, "%Y/%m/%d"))
        .ok()?;
    Some(date.format("%-d-%b-%Y").to_string())
}

/// Words as a quote keeps them: `from:"Ana Lima" invoice` is two.
fn words(text: &str) -> Vec<String> {
    let mut out = vec![];
    let mut word = String::new();
    let mut quoted = false;
    for c in text.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !word.is_empty() {
                    out.push(std::mem::take(&mut word));
                }
            }
            c => word.push(c),
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// The search words `hexbot_mail` takes, as an IMAP search: `from:`,
/// `to:`, `cc:`, `subject:`, `is:unread`, `is:read`, `is:starred`,
/// `after:` (or `since:`) and `before:` with a date, `in:` with a folder,
/// and plain words, which match anywhere in the message. A `-` before one
/// leaves out what it matches. `literal` as in `string`.
fn query(text: &str, literal: bool) -> Result<Query> {
    let quoted = |t: &str| string(t, literal);
    let mut folder = Folder::Inbox;
    let mut keys = vec![];
    for word in words(text) {
        let (not, word) = match word.strip_prefix('-') {
            Some(rest) if !rest.is_empty() => (true, rest.to_owned()),
            _ => (false, word),
        };
        let key = match word.split_once(':') {
            Some((name, value)) if !value.is_empty() => {
                let value = value.trim();
                match name.to_ascii_lowercase().as_str() {
                    "from" => format!("FROM {}", quoted(value)),
                    "to" => format!("TO {}", quoted(value)),
                    "cc" => format!("CC {}", quoted(value)),
                    "subject" => format!("SUBJECT {}", quoted(value)),
                    "is" => match value.to_ascii_lowercase().as_str() {
                        "unread" => "UNSEEN".to_owned(),
                        "read" => "SEEN".to_owned(),
                        "starred" | "flagged" => "FLAGGED".to_owned(),
                        "answered" => "ANSWERED".to_owned(),
                        _ => {
                            return Err(Error::new(
                                4202,
                                format!(
                                    "is:{value} isn't an IMAP search. Use is:unread, is:read or is:starred."
                                ),
                            ));
                        }
                    },
                    // IMAP can't tell an attachment from the message's other parts.
                    "has" => {
                        return Err(Error::new(
                            4202,
                            format!("IMAP can't search by has:{value}. Search for words instead."),
                        ));
                    }
                    "after" | "since" | "before" => {
                        let date = imap_date(value).ok_or_else(|| {
                            Error::new(4202, format!("{name}: takes a date such as 2026-03-01"))
                        })?;
                        if name.eq_ignore_ascii_case("before") {
                            format!("BEFORE {date}")
                        } else {
                            format!("SINCE {date}")
                        }
                    }
                    "in" if !not => {
                        let lower = value.to_ascii_lowercase();
                        folder = if lower == "inbox" {
                            Folder::Inbox
                        } else if let Some(s) = Special::from_word(&lower) {
                            Folder::Special(s)
                        } else {
                            Folder::Named(value.chars().filter(|c| !c.is_control()).collect())
                        };
                        continue;
                    }
                    _ => format!("TEXT {}", quoted(&word)),
                }
            }
            _ => format!("TEXT {}", quoted(&word)),
        };
        keys.push(if not { format!("NOT {key}") } else { key });
    }
    let mut criteria = if keys.is_empty() {
        "ALL".to_owned()
    } else {
        keys.join(" ")
    };
    if !criteria.is_ascii() {
        criteria = format!("CHARSET UTF-8 {criteria}");
    }
    Ok(Query { folder, criteria })
}

/// A message's id for `hexbot_mail`: its folder, the folder's UIDVALIDITY
/// and its UID, so a renumbered folder can't hand back another message.
fn message_id(folder: &str, validity: u32, uid: u32) -> String {
    format!(
        "{validity}.{uid}.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(folder.as_bytes())
    )
}
fn parse_id(id: &str) -> Result<(String, u32, u32)> {
    let bad = || Error::new(4202, "id must be a message id from search");
    let mut parts = id.splitn(3, '.');
    let validity = parts.next().and_then(|p| p.parse().ok()).ok_or_else(bad)?;
    let uid = parts.next().and_then(|p| p.parse().ok()).ok_or_else(bad)?;
    let folder = parts
        .next()
        .and_then(|p| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(p)
                .ok()
        })
        .and_then(|b| String::from_utf8(b).ok())
        .filter(|f| !f.is_empty())
        .ok_or_else(bad)?;
    Ok((folder, validity, uid))
}

fn person(a: &mail_parser::Addr<'_>) -> String {
    let address = a.address().unwrap_or("");
    match a.name().filter(|n| !n.is_empty() && *n != address) {
        Some(name) if name.contains([',', ';']) => {
            format!("\"{}\" <{address}>", name.replace('"', ""))
        }
        Some(name) if address.is_empty() => name.to_owned(),
        Some(name) => format!("{name} <{address}>"),
        None => address.to_owned(),
    }
}
fn people(list: Option<&Address<'_>>) -> String {
    list.map(|l| l.iter().map(person).collect::<Vec<_>>().join(", "))
        .unwrap_or_default()
}

fn unread(fetch: &Fetch) -> bool {
    !fetch.flags().any(|f| f == Flag::Seen)
}

/// What search and read share about a message.
fn row(folder: &str, validity: u32, fetch: &Fetch, message: &mail_parser::Message<'_>) -> Value {
    json!({
        "id": message_id(folder, validity, fetch.uid.unwrap_or(0)),
        "thread_id": message.message_id(),
        "folder": folder,
        "from": people(message.from()),
        "to": people(message.to()),
        "subject": message.subject().unwrap_or(""),
        "date": message.date().map(|d| d.to_rfc3339()),
        "unread": unread(fetch),
    })
}

/// Selects `folder` to read: EXAMINE, so nothing reading does marks it.
async fn examine(cfg: &Config, session: &mut Session<Stream>, folder: &str) -> Result<u32> {
    let mailbox = session.examine(folder).await.map_err(|e| match e {
        ImapError::No(_) => Error::new(4215, format!("{} has no folder {folder}.", cfg.name)),
        e => imap_error(cfg, e),
    })?;
    Ok(mailbox.uid_validity.unwrap_or(0))
}

/// Messages matching the search words, newest first; the latest in the
/// inbox for an empty query.
pub(crate) async fn search(cfg: &Config, text: &str, max: usize) -> Result<Vec<Value>> {
    let max = max.clamp(1, MAX_RESULTS);
    let mut query = query(text, false)?;
    with_session(cfg, async |session| {
        if !query.criteria.is_ascii() {
            let literal = session
                .capabilities()
                .await
                .is_ok_and(|c| c.has_str("LITERAL+") || c.has_str("LITERAL-"));
            query = self::query(text, literal)?;
        }
        let folder = folder_name(cfg, session, &query.folder).await?;
        let validity = examine(cfg, session, &folder).await?;
        let mut uids = session
            .uid_search(&query.criteria)
            .await
            .map_err(|e| match e {
                ImapError::Bad(text) | ImapError::No(text) => Error::new(
                    4202,
                    format!("{} couldn't search for that: {}", cfg.name, text.trim()),
                ),
                e => imap_error(cfg, e),
            })?
            .into_iter()
            .collect::<Vec<_>>();
        uids.sort_unstable_by_key(|u| std::cmp::Reverse(*u));
        uids.truncate(max);
        if uids.is_empty() {
            return Ok(vec![]);
        }
        let set = uids
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let fetches = session
            .uid_fetch(&set, format!("(UID FLAGS BODY.PEEK[]<0.{PREVIEW_BYTES}>)"))
            .await
            .map_err(|e| imap_error(cfg, e))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| imap_error(cfg, e))?;
        let mut rows = fetches
            .iter()
            .filter(|f| f.uid.is_some())
            .map(|f| {
                let bytes = f.body().unwrap_or_default();
                let message = MessageParser::default().parse(bytes).unwrap_or_default();
                let mut r = row(&folder, validity, f, &message);
                r["snippet"] = json!(
                    message
                        .body_preview(200)
                        .map(|p| p.split_whitespace().collect::<Vec<_>>().join(" "))
                        .unwrap_or_default()
                );
                (f.uid.unwrap_or(0), r)
            })
            .collect::<Vec<_>>();
        rows.sort_unstable_by_key(|r| std::cmp::Reverse(r.0));
        Ok(rows.into_iter().map(|(_, r)| r).collect())
    })
    .await
}

/// One message by its id: the fetch and the folder's state, or no such
/// message. `query` is what to fetch.
async fn fetch_one(
    cfg: &Config,
    session: &mut Session<Stream>,
    id: &str,
    query: &str,
) -> Result<(String, u32, Fetch)> {
    let (folder, validity, uid) = parse_id(id)?;
    let gone = || Error::new(4215, format!("{} has no such message.", cfg.name));
    let now = examine(cfg, session, &folder)
        .await
        .map_err(|e| if e.code == 4215 { gone() } else { e })?;
    if now != validity {
        return Err(gone());
    }
    let fetch = session
        .uid_fetch(uid.to_string(), query)
        .await
        .map_err(|e| imap_error(cfg, e))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|e| imap_error(cfg, e))?
        .into_iter()
        .find(|f| f.uid == Some(uid))
        .ok_or_else(gone)?;
    Ok((folder, validity, fetch))
}

/// One message with its text, at most what `hexbot_mail` shows of one.
pub(crate) async fn read(cfg: &Config, id: &str) -> Result<Value> {
    parse_id(id)?;
    with_session(cfg, async |session| {
        let (folder, validity, fetch) = fetch_one(
            cfg,
            session,
            id,
            &format!("(UID FLAGS RFC822.SIZE BODY.PEEK[]<0.{MESSAGE_BYTES}>)"),
        )
        .await?;
        let bytes = fetch.body().unwrap_or_default();
        let message = MessageParser::default().parse(bytes).unwrap_or_default();
        let mut r = row(&folder, validity, &fetch, &message);
        r["cc"] = json!(people(message.cc()));
        r["reply_to"] = json!(people(message.reply_to()));
        let body = message
            .text_bodies()
            .filter_map(|part| {
                let text = part.text_contents()?;
                Some(if part.is_text_html() {
                    mail::html_text(text)
                } else {
                    text.to_owned()
                })
            })
            .filter(|t| !t.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut body = mail::capped(&body);
        if fetch.size.is_some_and(|s| s as usize > MESSAGE_BYTES) {
            body.push_str("\n\n[This message is large; attachments past its start aren't listed.]");
        }
        r["body"] = json!(body);
        r["attachments"] = json!(
            message
                .attachments()
                .filter_map(|a| a.attachment_name().map(str::to_owned))
                .collect::<Vec<_>>()
        );
        Ok(r)
    })
    .await
}

/// What a reply needs of the message it answers.
pub(crate) struct Original {
    pub subject: String,
    message_id: String,
    references: String,
}

impl Original {
    /// The thread, as the draft card keeps it.
    pub(crate) fn to_form(&self) -> Value {
        json!({"message_id": self.message_id, "references": self.references})
    }
    /// The thread the draft card kept, if it kept one.
    pub(crate) fn from_form(form: &Value) -> Option<Original> {
        let thread = &form["thread"];
        Some(Original {
            subject: String::new(),
            message_id: thread["message_id"].as_str()?.to_owned(),
            references: thread["references"].as_str().unwrap_or("").to_owned(),
        })
    }
}

async fn read_original(cfg: &Config, session: &mut Session<Stream>, id: &str) -> Result<Original> {
    let (_, _, fetch) = fetch_one(cfg, session, id, "(UID BODY.PEEK[HEADER])").await?;
    let header = fetch.header().unwrap_or_default();
    let message = MessageParser::default().parse(header).unwrap_or_default();
    let message_id = message
        .message_id()
        .map(|m| format!("<{}>", m.trim_matches(['<', '>'])))
        .unwrap_or_default();
    let references = message
        .references()
        .as_text_list()
        .map(|l| l.iter().map(|r| format!("<{r}>")).collect::<Vec<_>>())
        .or_else(|| {
            message
                .references()
                .as_text()
                .map(|r| vec![format!("<{r}>")])
        })
        .unwrap_or_default()
        .join(" ");
    Ok(Original {
        subject: message.subject().unwrap_or("").to_owned(),
        message_id,
        references,
    })
}

/// What a reply needs of message `id`: proof it has something to answer,
/// its subject, and its thread.
pub(crate) async fn original(cfg: &Config, id: &str) -> Result<Original> {
    parse_id(id)?;
    with_session(cfg, async |session| read_original(cfg, session, id).await).await
}

// --- Drafts ---------------------------------------------------------------

/// The email as it goes: the draft with its sender, date and thread.
fn message(cfg: &Config, draft: &Draft, original: Option<&Original>, id: &str) -> String {
    let mut headers = vec![
        ("From", cfg.from.clone()),
        ("Date", chrono::Utc::now().to_rfc2822()),
        ("Message-ID", id.to_owned()),
    ];
    if let Some(o) = original.filter(|o| !o.message_id.is_empty()) {
        headers.push(("In-Reply-To", o.message_id.clone()));
        headers.push((
            "References",
            format!("{} {}", o.references, o.message_id)
                .trim()
                .to_owned(),
        ));
    }
    mail::mime(draft, &headers)
}

fn smtp(cfg: &Config) -> Result<lettre::AsyncSmtpTransport<lettre::Tokio1Executor>> {
    use lettre::transport::smtp::{
        authentication::Credentials,
        client::{Tls, TlsParameters},
        extension::ClientId,
    };
    let server = &cfg.smtp;
    let params = TlsParameters::builder(server.host.clone())
        .dangerous_accept_invalid_certs(server.local())
        .build_rustls()
        .map_err(|e| Error::new(5240, e.to_string()))?;
    let tls = if server.implicit_tls {
        Tls::Wrapper(params)
    } else if server.local() {
        Tls::Opportunistic(params)
    } else {
        Tls::Required(params)
    };
    Ok(
        lettre::AsyncSmtpTransport::<lettre::Tokio1Executor>::builder_dangerous(&server.host)
            .port(server.port)
            .tls(tls)
            .hello_name(ClientId::Ipv4(std::net::Ipv4Addr::LOCALHOST))
            .credentials(Credentials::new(cfg.username.clone(), cfg.password.clone()))
            .timeout(Some(Duration::from_secs(60)))
            .build(),
    )
}

/// What a failed SMTP step becomes. A refusal is certain; anything else may
/// have happened after the server took the email.
fn smtp_error(cfg: &Config, e: lettre::transport::smtp::Error) -> Error {
    let code = e.status().map(|c| c.to_string()).unwrap_or_default();
    // A reply Hexbot couldn't read whole (`is_response`) may follow the
    // server taking the email: only a 4xx or 5xx is a refusal.
    if e.is_permanent() || e.is_transient() {
        if code == "535" || code == "534" || code == "530" {
            return Error::new(
                4210,
                format!(
                    "{} refused the sign-in for sending. Check the app password in Settings, Plugins.",
                    cfg.name
                ),
            );
        }
        return Error::new(5240, format!("{} refused to send it: {e}", cfg.name));
    }
    // Connecting, the name lookup and TLS fail as lettre's Connection
    // error, which it gives no check for; nothing went. lettre is pinned, and
    // a test sends to a closed port to catch a change in its words.
    let text = e.to_string();
    if text.starts_with("Connection error") {
        return never_connected(cfg, &cfg.smtp, &text, text.contains("refused"));
    }
    if e.is_client() {
        return Error::new(
            5240,
            format!("Hexbot couldn't reach {}: {e}", cfg.smtp.host),
        );
    }
    Error::new(UNCERTAIN, format!("{} stopped answering.", cfg.name))
}

/// Sends `draft`, or with `send` false saves it to Drafts. Only the draft
/// card calls this, with what the user left on it. A send that got no whole
/// answer may have gone out, and says so.
/// `original` is the thread the card kept when it showed; without one, a
/// reply reads its message again.
pub(crate) async fn deliver(
    cfg: &Config,
    draft: &Draft,
    send: bool,
    original: Option<Original>,
) -> Result<Value> {
    if send && draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
        return Err(Error::new(4202, "Add someone to send it to."));
    }
    let domain = cfg.address.rsplit_once('@').map_or("hexbot", |(_, d)| d);
    let id = format!("<{}@{domain}>", uuid::Uuid::new_v4());
    let maybe = |e: Error| mail::maybe_done(e, send, &cfg.name);
    // The message a reply answers, read before anything goes.
    let original = match (&draft.reply_to, original) {
        (Some(_), Some(kept)) => Some(kept),
        (None, _) => None,
        (Some(reply), None) => Some(
            with_session(cfg, async |session| read_original(cfg, session, reply).await)
                .await
                .map_err(|e| match e.code {
                    4215 => Error::new(
                        4215,
                        format!(
                            "The email this answers is no longer in {}. Discard this and ask for a new draft.",
                            cfg.name
                        ),
                    ),
                    UNCERTAIN => Error::new(5240, e.message),
                    _ => e,
                })?,
        ),
    };
    let text = message(cfg, draft, original.as_ref(), &id);
    if !send {
        with_session(cfg, async |session| {
            let drafts = folder_name(cfg, session, &Folder::Special(Special::Drafts)).await?;
            session
                .append(&drafts, Some("(\\Draft \\Seen)"), None, text.as_bytes())
                .await
                .map_err(|e| imap_error(cfg, e))
        })
        .await
        .map_err(maybe)?;
        return Ok(json!({"id": id}));
    }
    // The copy that goes out names no Bcc; the one filed in Sent does.
    let outgoing = message(
        cfg,
        &Draft {
            bcc: vec![],
            ..draft.clone()
        },
        original.as_ref(),
        &id,
    );
    let parse = |a: &String| {
        mail::bare(a)
            .parse::<lettre::Address>()
            .map_err(|_| Error::new(4202, format!("{a} isn't an email address.")))
    };
    let to = draft
        .to
        .iter()
        .chain(&draft.cc)
        .chain(&draft.bcc)
        .map(parse)
        .collect::<Result<Vec<_>>>()?;
    let envelope = lettre::address::Envelope::new(Some(parse(&cfg.address)?), to)
        .map_err(|e| Error::new(4202, e.to_string()))?;
    use lettre::AsyncTransport;
    smtp(cfg)?
        .send_raw(&envelope, outgoing.as_bytes())
        .await
        .map_err(|e| maybe(smtp_error(cfg, e)))?;
    // It went. Filing it in Sent is a courtesy: a failure there leaves the
    // email sent, and says it wasn't filed.
    let filed = cfg.files_sent
        || with_session(cfg, async |session| {
            let sent = folder_name(cfg, session, &Folder::Special(Special::Sent)).await?;
            session
                .append(&sent, Some("(\\Seen)"), None, text.as_bytes())
                .await
                .map_err(|e| imap_error(cfg, e))
        })
        .await
        .is_ok();
    Ok(json!({"id": id, "filed_in_sent": filed}))
}

/// Signs in to both servers, as Test in Settings, Plugins does.
pub(crate) async fn probe(home: &Path, bot: Option<&str>) -> Value {
    let cfg = match config(home, bot) {
        Ok(cfg) => cfg,
        Err(e) => return json!({"ok": false, "message": e.message}),
    };
    let reading = with_session(&cfg, async |session| {
        examine(&cfg, session, "INBOX").await.map(|_| ())
    })
    .await;
    if let Err(e) = reading {
        return json!({"ok": false, "message": format!("Reading: {}", e.message)});
    }
    let sending = async {
        let ok = smtp(&cfg)?
            .test_connection()
            .await
            .map_err(|e| smtp_error(&cfg, e))?;
        if ok {
            Ok(())
        } else {
            Err(Error::new(
                5240,
                format!("{} didn't answer.", cfg.smtp.host),
            ))
        }
    }
    .await;
    match sending {
        Ok(()) => json!({"ok": true, "message": format!("Connected as {}.", cfg.address)}),
        Err(e) => json!({"ok": false, "message": format!("Sending: {}", e.message)}),
    }
}

#[cfg(test)]
#[path = "imap_tests.rs"]
pub(crate) mod tests;
