//! A player gets a link for one file through its authenticated chat connection.
//! Byte ranges travel over HTTP. Closing the socket releases its links.
use super::*;
use axum::{
    body::Body,
    extract::Path,
    http::{Method, header},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

#[derive(Clone)]
struct Grant {
    connection: u64,
    token: String,
    session: String,
    path: String,
    version: String,
}

#[derive(Default)]
pub(super) struct Links(Mutex<HashMap<String, Grant>>);

impl Links {
    pub(super) fn disconnect(&self, connection: u64) {
        self.0
            .lock()
            .unwrap()
            .retain(|_, grant| grant.connection != connection);
    }

    pub(super) fn link(
        &self,
        connection: u64,
        token: &str,
        session: &str,
        path: &str,
        version: &str,
    ) -> Result<String> {
        let mut links = self.0.lock().unwrap();
        let same_file = |grant: &Grant| {
            grant.connection == connection && grant.session == session && grant.path == path
        };
        if let Some((key, grant)) = links.iter().find(|(_, grant)| same_file(grant)) {
            if grant.version == version {
                return Ok(format!("/api/media/{key}"));
            }
            let old_key = key.clone();
            links.remove(&old_key);
        }
        if links.len() >= 4096 {
            return Err(Error::new(
                4202,
                "Too many open media links. Reconnect to open more.",
            ));
        }
        let key = common::id();
        links.insert(
            key.clone(),
            Grant {
                connection,
                token: token.to_owned(),
                session: session.to_owned(),
                path: path.to_owned(),
                version: version.to_owned(),
            },
        );
        Ok(format!("/api/media/{key}"))
    }
}

pub(super) async fn serve(
    State(app): State<Arc<App>>,
    Path(key): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let grant = app.media.0.lock().unwrap().get(&key).cloned();
    let Some(grant) = grant else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(Some(device)) = auth::verify_token(&app.home, &grant.token) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let owner = device["owner_id"].as_str().unwrap_or_default();
    let Ok(path) = app
        .runtime
        .panel_path(owner, &grant.session, &grant.path)
        .await
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if path.to_str() != Some(grant.path.as_str()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(media) = crate::runtime::open_media(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if media.version != grant.version {
        return StatusCode::GONE.into_response();
    }
    let size = media.size;
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, media.mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer");
    let mut file = tokio::fs::File::from_std(media.file);
    let count = if let Some(range) = headers.get(header::RANGE).filter(|_| method == Method::GET) {
        let ranges = range
            .to_str()
            .ok()
            .filter(|s| size > 0 && !s.contains(','))
            .and_then(|s| http_range_header::parse_range_header(s).ok())
            .and_then(|range| match range.validate(size) {
                Ok(ranges) => ranges.into_iter().next(),
                Err(http_range_header::RangeUnsatisfiableError::FileSuffixOutOfBounds) => {
                    Some(0..=size - 1)
                }
                Err(_) => None,
            });
        let Some(r) = ranges else {
            return response
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .body(Body::empty())
                .unwrap();
        };
        let (start, end) = (*r.start(), *r.end());
        if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        response = response
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
        end - start + 1
    } else {
        size
    };
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from_stream(ReaderStream::new(file.take(count)))
    };
    response
        .header(header::CONTENT_LENGTH, count)
        .body(body)
        .unwrap()
}
