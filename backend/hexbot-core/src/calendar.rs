//! Google Calendar and Outlook Calendar behind one shape, for
//! `hexbot_calendar`. Times go in and out as the calendar's own local time
//! (`2026-11-12T09:00`) with its time zone named beside them, or as a date
//! for an all-day event whose last day is included. The daemon has no time
//! zone database, so a local time is never converted here: the service
//! resolves it in the zone it is given.
use crate::{
    Error, Result,
    accounts::{self, GOOGLE_API, Service, enc},
};
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Utc};
use reqwest::Method;
use serde_json::{Value, json};
use std::path::Path;

const MAX_EVENTS: usize = 100;
/// Calendars read when a list names none: the ones the user shows.
const MAX_CALENDARS: usize = 12;
const NOTE_CAP: usize = 2_000;

async fn call(
    home: &Path,
    svc: &Service,
    method: Method,
    path: &str,
    body: Option<&Value>,
    headers: &[(&str, &str)],
) -> Result<Value> {
    let host = if svc.google() { GOOGLE_API } else { svc.api };
    accounts::api(home, svc, None, method, host, path, body, headers, "event").await
}

// --- Times ----------------------------------------------------------------

/// A time as a bot writes it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum When {
    /// With an offset or `Z`: one instant everywhere.
    Instant(DateTime<Utc>),
    /// Without one: the calendar's own local time.
    Local(NaiveDateTime),
    /// A date alone: a whole day.
    Day(NaiveDate),
}

pub(crate) fn when(text: &str, field: &str) -> Result<When> {
    let text = text.trim();
    if let Ok(day) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return Ok(When::Day(day));
    }
    if let Ok(instant) = DateTime::parse_from_rfc3339(text) {
        return Ok(When::Instant(instant.with_timezone(&Utc)));
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(local) = NaiveDateTime::parse_from_str(text, format) {
            return Ok(When::Local(local));
        }
    }
    Err(Error::new(
        4202,
        format!(
            "{field} must be a date like 2026-11-12 or a time like 2026-11-12T09:00, with an offset such as +13:00 if it isn't the calendar's own time."
        ),
    ))
}

fn local_text(time: NaiveDateTime) -> String {
    time.format("%Y-%m-%dT%H:%M:%S").to_string()
}
fn instant_text(time: DateTime<Utc>) -> String {
    time.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// The span a list covers. A local bound has no instant here, so the
/// request asks for every instant it could be (UTC-12 to UTC+14) and
/// `Span::holds` keeps the events inside the local bounds.
struct Span {
    from: When,
    to: When,
}

impl Span {
    fn new(from: Option<&str>, to: Option<&str>) -> Result<Self> {
        let from = match from.filter(|v| !v.trim().is_empty()) {
            Some(text) => when(text, "from")?,
            None => When::Instant(Utc::now()),
        };
        let to = match to.filter(|v| !v.trim().is_empty()) {
            // A day named as the end is included whole.
            Some(text) => match when(text, "to")? {
                When::Day(day) => When::Day(day + Duration::days(1)),
                other => other,
            },
            None => match from {
                When::Instant(at) => When::Instant(at + Duration::days(7)),
                When::Local(at) => When::Local(at + Duration::days(7)),
                When::Day(day) => When::Day(day + Duration::days(7)),
            },
        };
        let span = Span { from, to };
        // Two local times compare as written; with an instant among them,
        // only the instants they could be can.
        let backwards = match (Self::local(from), Self::local(to)) {
            (Some(from), Some(to)) => to <= from,
            _ => false,
        };
        if backwards || span.earliest() >= span.latest() {
            return Err(Error::new(4202, "to must be after from"));
        }
        if span.latest() - span.earliest() > Duration::days(400) {
            return Err(Error::new(4202, "Ask for a year of events at most."));
        }
        Ok(span)
    }
    fn local(at: When) -> Option<NaiveDateTime> {
        match at {
            When::Instant(_) => None,
            When::Local(at) => Some(at),
            When::Day(day) => day.and_hms_opt(0, 0, 0),
        }
    }
    /// The first instant the span could start at, anywhere on Earth.
    fn earliest(&self) -> DateTime<Utc> {
        match self.from {
            When::Instant(at) => at,
            other => Self::local(other).unwrap().and_utc() - Duration::hours(14),
        }
    }
    fn latest(&self) -> DateTime<Utc> {
        match self.to {
            When::Instant(at) => at,
            other => Self::local(other).unwrap().and_utc() + Duration::hours(12),
        }
    }
    /// Whether an event with these local times, as the service gave them
    /// in the calendar's zone, lies inside the span's local bounds.
    fn holds(&self, start: &str, end: &str) -> bool {
        let parse = |text: &str| {
            NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S")
                .ok()
                .or_else(|| {
                    NaiveDate::parse_from_str(text, "%Y-%m-%d")
                        .ok()
                        .and_then(|d| d.and_hms_opt(0, 0, 0))
                })
        };
        let (Some(start), Some(end)) = (parse(start), parse(end)) else {
            return true;
        };
        Self::local(self.from).is_none_or(|from| end > from || (end == start && start >= from))
            && Self::local(self.to).is_none_or(|to| start < to)
    }
}

/// `2026-11-12T09:00:00+13:00` as the local `2026-11-12T09:00:00`: the
/// service already wrote it in the calendar's zone.
fn without_offset(text: &str) -> String {
    let local = text.get(..19).unwrap_or(text);
    // Without seconds.
    if local.len() == 16 {
        format!("{local}:00")
    } else {
        local.to_owned()
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

// --- Reading --------------------------------------------------------------

/// The user's calendars.
pub(crate) async fn calendars(home: &Path, svc: &Service) -> Result<Vec<Value>> {
    if svc.google() {
        let list = call(
            home,
            svc,
            Method::GET,
            "/calendar/v3/users/me/calendarList?maxResults=250",
            None,
            &[],
        )
        .await?;
        return Ok(list["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["hidden"] != true)
            .map(|c| {
                json!({
                    "id": c["id"],
                    "name": c["summaryOverride"].as_str().or(c["summary"].as_str()).unwrap_or(""),
                    "primary": c["primary"] == true,
                    "can_edit": matches!(c["accessRole"].as_str(), Some("owner" | "writer")),
                    "shown": c["selected"] == true,
                    "time_zone": c["timeZone"],
                })
            })
            .collect());
    }
    let list = call(
        home,
        svc,
        Method::GET,
        "/v1.0/me/calendars?$top=100&$select=id,name,isDefaultCalendar,canEdit",
        None,
        &[],
    )
    .await?;
    Ok(list["value"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            json!({
                "id": c["id"],
                "name": c["name"],
                "primary": c["isDefaultCalendar"] == true,
                "can_edit": c["canEdit"] != false,
                "shown": true,
            })
        })
        .collect())
}

/// The zone Outlook shows the user's calendar in.
pub(crate) async fn outlook_zone(home: &Path, svc: &Service) -> Result<String> {
    let zone = call(
        home,
        svc,
        Method::GET,
        "/v1.0/me/mailboxSettings/timeZone",
        None,
        &[],
    )
    .await?;
    Ok(zone["value"]
        .as_str()
        // A zone the user made up has no name the service takes back.
        .filter(|z| !z.is_empty() && !z.contains('"') && !z.contains("://"))
        .unwrap_or("UTC")
        .to_owned())
}

/// The zone of a Google calendar.
async fn google_zone(home: &Path, svc: &Service, calendar: &str) -> Result<String> {
    let found = call(
        home,
        svc,
        Method::GET,
        &format!("/calendar/v3/calendars/{}", enc(calendar)),
        None,
        &[],
    )
    .await?;
    Ok(found["timeZone"].as_str().unwrap_or("UTC").to_owned())
}

fn google_event(e: &Value, calendar: &Value) -> Value {
    let all_day = e["start"]["date"].is_string();
    let (start, end) = if all_day {
        // Google's last day is the one after; ours is included.
        let end = e["end"]["date"]
            .as_str()
            .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
            .map(|d| (d - Duration::days(1)).to_string())
            .unwrap_or_default();
        (e["start"]["date"].as_str().unwrap_or("").to_owned(), end)
    } else {
        (
            without_offset(e["start"]["dateTime"].as_str().unwrap_or("")),
            without_offset(e["end"]["dateTime"].as_str().unwrap_or("")),
        )
    };
    let meeting = e["hangoutLink"].as_str().or_else(|| {
        e["conferenceData"]["entryPoints"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["entryPointType"] == "video")
            .and_then(|p| p["uri"].as_str())
    });
    json!({
        "id": e["id"],
        "calendar": calendar["id"],
        "calendar_name": calendar["name"],
        "title": e["summary"].as_str().unwrap_or("(No title)"),
        "start": start,
        "end": end,
        "all_day": all_day,
        "location": e["location"].as_str().unwrap_or(""),
        "description": capped(&crate::mail::html_text(e["description"].as_str().unwrap_or(""))),
        "attendees": e["attendees"].as_array().into_iter().flatten().map(|a| json!({
            "email": a["email"],
            "name": a["displayName"].as_str().unwrap_or(""),
            "response": match a["responseStatus"].as_str() {
                Some("accepted") => "accepted",
                Some("declined") => "declined",
                Some("tentative") => "maybe",
                _ => "no answer",
            },
            "you": a["self"] == true,
        })).collect::<Vec<_>>(),
        "organizer": e["organizer"]["email"].as_str().unwrap_or(""),
        "link": e["htmlLink"].as_str().unwrap_or(""),
        "meeting_link": meeting.unwrap_or(""),
        "repeats": e["recurringEventId"].is_string(),
    })
}

fn graph_event(e: &Value, calendar: &Value) -> Value {
    let all_day = e["isAllDay"] == true;
    let time = |v: &Value| without_offset(v["dateTime"].as_str().unwrap_or(""));
    let (mut start, mut end) = (time(&e["start"]), time(&e["end"]));
    if all_day {
        start.truncate(10);
        end = NaiveDate::parse_from_str(&end[..end.len().min(10)], "%Y-%m-%d")
            .map(|d| (d - Duration::days(1)).to_string())
            .unwrap_or_default();
    }
    json!({
        "id": e["id"],
        "calendar": calendar["id"],
        "calendar_name": calendar["name"],
        "title": e["subject"].as_str().filter(|s| !s.is_empty()).unwrap_or("(No title)"),
        "start": start,
        "end": end,
        "all_day": all_day,
        "location": e["location"]["displayName"].as_str().unwrap_or(""),
        "description": capped(e["bodyPreview"].as_str().unwrap_or("")),
        "attendees": e["attendees"].as_array().into_iter().flatten().map(|a| json!({
            "email": a["emailAddress"]["address"],
            "name": a["emailAddress"]["name"].as_str().unwrap_or(""),
            "response": match a["status"]["response"].as_str() {
                Some("accepted" | "organizer") => "accepted",
                Some("declined") => "declined",
                Some("tentativelyAccepted") => "maybe",
                _ => "no answer",
            },
        })).collect::<Vec<_>>(),
        "organizer": e["organizer"]["emailAddress"]["address"].as_str().unwrap_or(""),
        "link": e["webLink"].as_str().unwrap_or(""),
        "meeting_link": e["onlineMeeting"]["joinUrl"].as_str().unwrap_or(""),
        "repeats": e["seriesMasterId"].is_string(),
    })
}

const GRAPH_FIELDS: &str = "$select=id,subject,bodyPreview,location,start,end,isAllDay,attendees,organizer,webLink,onlineMeeting,seriesMasterId,isCancelled";

/// Whether `event` mentions `query`, in its title, place, notes or guests.
fn mentions(event: &Value, query: &str) -> bool {
    let query = query.trim().to_lowercase();
    query.is_empty()
        || ["title", "location", "description", "organizer"]
            .iter()
            .any(|k| {
                event[*k]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&query)
            })
        || event["attendees"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|a| {
                format!(
                    "{} {}",
                    a["email"].as_str().unwrap_or(""),
                    a["name"].as_str().unwrap_or("")
                )
                .to_lowercase()
                .contains(&query)
            })
}

/// Events between `from` and `to`, earliest first: in `calendar` when it is
/// named, otherwise in every calendar the user shows.
pub(crate) async fn list(
    home: &Path,
    svc: &Service,
    from: Option<&str>,
    to: Option<&str>,
    query: &str,
    calendar: Option<&str>,
    max: usize,
) -> Result<Value> {
    let span = Span::new(from, to)?;
    let max = max.clamp(1, MAX_EVENTS);
    let all = calendars(home, svc).await?;
    let chosen: Vec<&Value> = match calendar.filter(|c| !c.is_empty()) {
        Some(id) => {
            let found = all
                .iter()
                .find(|c| c["id"] == id || (id == "primary" && c["primary"] == true));
            vec![found.ok_or_else(|| {
                Error::new(
                    4215,
                    format!("{} has no such calendar. calendars lists them.", svc.name),
                )
            })?]
        }
        None => {
            let mut shown: Vec<&Value> = all.iter().filter(|c| c["shown"] == true).collect();
            // The user's own calendar first, so a cap never drops it.
            shown.sort_by_key(|c| c["primary"] != true);
            shown.truncate(MAX_CALENDARS);
            shown
        }
    };
    let (earliest, latest) = (instant_text(span.earliest()), instant_text(span.latest()));
    let zone = if svc.google() {
        chosen
            .iter()
            .find(|c| c["primary"] == true)
            .or(chosen.first())
            .and_then(|c| c["time_zone"].as_str())
            .unwrap_or("UTC")
            .to_owned()
    } else {
        outlook_zone(home, svc).await?
    };
    let prefer = format!("outlook.timezone=\"{zone}\"");
    let paths = chosen
        .iter()
        .map(|c| {
            let id = enc(c["id"].as_str().unwrap_or(""));
            if svc.google() {
                format!(
                    "/calendar/v3/calendars/{id}/events?singleEvents=true&orderBy=startTime&maxResults=250&timeMin={}&timeMax={}&timeZone={}{}",
                    enc(&earliest),
                    enc(&latest),
                    enc(&zone),
                    if query.trim().is_empty() {
                        String::new()
                    } else {
                        format!("&q={}", enc(query.trim()))
                    }
                )
            } else {
                format!(
                    "/v1.0/me/calendars/{id}/calendarView?startDateTime={}&endDateTime={}&$top=250&$orderby=start/dateTime&{GRAPH_FIELDS}",
                    enc(&earliest),
                    enc(&latest)
                )
            }
        })
        .collect::<Vec<_>>();
    let headers: &[(&str, &str)] = if svc.google() {
        &[]
    } else {
        &[("Prefer", prefer.as_str())]
    };
    let answers = futures_util::future::join_all(
        paths
            .iter()
            .map(|path| call(home, svc, Method::GET, path, None, headers)),
    )
    .await;
    let mut events = vec![];
    // A calendar with more in the span than one page holds: later ones.
    let mut cut = false;
    for (calendar, answer) in chosen.iter().zip(answers) {
        // One shared calendar that won't answer doesn't hide the rest.
        let answer = match answer {
            Ok(answer) => answer,
            Err(_) if chosen.len() > 1 && calendar["primary"] != true => continue,
            Err(e) => return Err(e),
        };
        cut |= answer["nextPageToken"].is_string() || answer["@odata.nextLink"].is_string();
        let rows = if svc.google() {
            &answer["items"]
        } else {
            &answer["value"]
        };
        for row in rows.as_array().into_iter().flatten() {
            if row["status"] == "cancelled" || row["isCancelled"] == true {
                continue;
            }
            let event = if svc.google() {
                google_event(row, calendar)
            } else {
                graph_event(row, calendar)
            };
            // An all-day event's last day is included, so it ends after it.
            let end = event["end"].as_str().unwrap_or("");
            let ends = if event["all_day"] == true {
                NaiveDate::parse_from_str(end, "%Y-%m-%d")
                    .map(|d| (d + Duration::days(1)).to_string())
                    .unwrap_or_default()
            } else {
                end.to_owned()
            };
            if span.holds(event["start"].as_str().unwrap_or(""), &ends)
                && (svc.google() || mentions(&event, query))
            {
                events.push(event);
            }
        }
    }
    events.sort_by(|a, b| {
        a["start"]
            .as_str()
            .unwrap_or("")
            .cmp(b["start"].as_str().unwrap_or(""))
    });
    let more = cut || events.len() > max;
    events.truncate(max);
    Ok(json!({
        "account": svc.provider.id,
        "time_zone": zone,
        "events": events,
        "more": more,
    }))
}

// --- Changing -------------------------------------------------------------

/// What a bot asks an event to be. A field left out of a change stays.
#[derive(Debug, Default, Clone)]
pub(crate) struct Change {
    pub title: Option<String>,
    pub start: Option<When>,
    pub end: Option<When>,
    pub time_zone: Option<String>,
    pub location: Option<String>,
    pub description: Option<String>,
    pub attendees: Option<Vec<String>>,
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
        let time = |key: &str| -> Result<Option<When>> {
            text(key, 64)?.map(|v| when(&v, key)).transpose()
        };
        let attendees = match &p["attendees"] {
            Value::Null => None,
            list => {
                let list = crate::mail::addresses(list, "attendees")?;
                Some(list)
            }
        };
        let time_zone = text("time_zone", 64)?.filter(|z| !z.trim().is_empty());
        if time_zone.as_ref().is_some_and(|z| {
            !z.chars()
                .all(|c| c.is_ascii_alphanumeric() || "/_+- ".contains(c))
        }) {
            return Err(Error::new(
                4202,
                "time_zone must be a zone name like Pacific/Auckland",
            ));
        }
        Ok(Change {
            title: text("title", 1_000)?,
            start: time("start")?,
            end: time("end")?,
            time_zone,
            location: text("location", 1_000)?,
            description: text("description", 8_000)?,
            attendees,
        })
    }

    /// Start and end as a pair that makes sense together: both days or
    /// both times, the end after the start. An event with a start and no
    /// end lasts an hour, or its one day.
    fn times(&self) -> Result<Option<(When, When)>> {
        let Some(start) = self.start else {
            return if self.end.is_some() {
                Err(Error::new(4202, "Pass start with end."))
            } else {
                Ok(None)
            };
        };
        let end = match (start, self.end) {
            (When::Day(day), None) => When::Day(day),
            (When::Local(at), None) => When::Local(at + Duration::hours(1)),
            (When::Instant(at), None) => When::Instant(at + Duration::hours(1)),
            (_, Some(end)) => end,
        };
        let ok = match (start, end) {
            (When::Day(a), When::Day(b)) => b >= a,
            (When::Local(a), When::Local(b)) => b > a,
            (When::Instant(a), When::Instant(b)) => b > a,
            _ => {
                return Err(Error::new(
                    4202,
                    "start and end must be written the same way: both dates, both local times, or both with an offset.",
                ));
            }
        };
        if !ok {
            return Err(Error::new(4202, "end must be after start"));
        }
        Ok(Some((start, end)))
    }

    fn google(&self, zone: &str) -> Result<Value> {
        let mut body = json!({});
        if let Some(title) = &self.title {
            body["summary"] = json!(title);
        }
        if let Some(location) = &self.location {
            body["location"] = json!(location);
        }
        if let Some(description) = &self.description {
            body["description"] = json!(description);
        }
        if let Some(attendees) = &self.attendees {
            body["attendees"] = json!(
                attendees
                    .iter()
                    .map(|a| json!({"email": crate::mail::bare(a)}))
                    .collect::<Vec<_>>()
            );
        }
        if let Some((start, end)) = self.times()? {
            let point = |at: When, last: bool| match at {
                // Google's last day is the one after ours.
                When::Day(day) => json!({
                    "date": (day + Duration::days(i64::from(last))).to_string(),
                    "dateTime": null,
                }),
                When::Local(at) => {
                    json!({"dateTime": local_text(at), "timeZone": zone, "date": null})
                }
                When::Instant(at) => json!({"dateTime": instant_text(at), "date": null}),
            };
            body["start"] = point(start, false);
            body["end"] = point(end, true);
        }
        Ok(body)
    }

    fn graph(&self, zone: &str) -> Result<Value> {
        let mut body = json!({});
        if let Some(title) = &self.title {
            body["subject"] = json!(title);
        }
        if let Some(location) = &self.location {
            body["location"] = json!({"displayName": location});
        }
        if let Some(description) = &self.description {
            body["body"] = json!({"contentType": "text", "content": description});
        }
        if let Some(attendees) = &self.attendees {
            body["attendees"] = json!(
                attendees
                    .iter()
                    .map(|a| json!({
                        "emailAddress": {"address": crate::mail::bare(a)},
                        "type": "required",
                    }))
                    .collect::<Vec<_>>()
            );
        }
        if let Some((start, end)) = self.times()? {
            let midnight = |day: NaiveDate| local_text(day.and_hms_opt(0, 0, 0).unwrap());
            let point = |at: When, last: bool| match at {
                When::Day(day) => json!({
                    "dateTime": midnight(day + Duration::days(i64::from(last))),
                    "timeZone": zone,
                }),
                When::Local(at) => json!({"dateTime": local_text(at), "timeZone": zone}),
                When::Instant(at) => {
                    json!({"dateTime": local_text(at.naive_utc()), "timeZone": "UTC"})
                }
            };
            body["start"] = point(start, false);
            body["end"] = point(end, true);
            body["isAllDay"] = json!(matches!(start, When::Day(_)));
        }
        Ok(body)
    }

    /// Whether the calendar's zone has to be looked up: for a local time,
    /// and for Outlook's whole days, which start at a midnight.
    fn needs_zone(&self, google: bool) -> bool {
        self.time_zone.is_none()
            && match self.start {
                Some(When::Local(_)) => true,
                Some(When::Day(_)) => !google,
                _ => false,
            }
    }
}

/// The end that keeps `event` as long as it was once it starts at `start`.
/// None when it turns from a whole day into a time or back: then it lasts
/// the usual hour, or the one day.
fn kept_end(start: When, event: &Value) -> Option<When> {
    let at = |key: &str| event[key].as_str().and_then(|text| when(text, key).ok());
    match (start, at("start")?, at("end")?) {
        (When::Day(to), When::Day(a), When::Day(b)) if b >= a => Some(When::Day(to + (b - a))),
        (When::Local(to), When::Local(a), When::Local(b)) if b > a => {
            Some(When::Local(to + (b - a)))
        }
        (When::Instant(to), When::Local(a), When::Local(b)) if b > a => {
            Some(When::Instant(to + (b - a)))
        }
        _ => None,
    }
}

/// An Outlook event by its id, in the calendar it was listed from when one
/// is named: an event of a calendar someone shared is reached only there.
fn graph_path(id: &str, calendar: Option<&str>) -> String {
    match calendar.filter(|c| !c.is_empty() && *c != "primary") {
        Some(calendar) => format!("/v1.0/me/calendars/{}/events/{}", enc(calendar), enc(id)),
        None => format!("/v1.0/me/events/{}", enc(id)),
    }
}

fn google_path(calendar: Option<&str>) -> String {
    format!(
        "/calendar/v3/calendars/{}/events",
        enc(calendar.filter(|c| !c.is_empty()).unwrap_or("primary"))
    )
}

/// One event as it is now, by its id.
async fn find(home: &Path, svc: &Service, id: &str, calendar: Option<&str>) -> Result<Value> {
    if id.is_empty() || id.len() > 1_024 {
        return Err(Error::new(4202, "id must be an event id from list"));
    }
    if svc.google() {
        let path = format!("{}/{}", google_path(calendar), enc(id));
        let event = call(home, svc, Method::GET, &path, None, &[]).await?;
        return Ok(google_event(
            &event,
            &json!({"id": calendar.filter(|c| !c.is_empty()).unwrap_or("primary")}),
        ));
    }
    let event = call(
        home,
        svc,
        Method::GET,
        &format!("{}?{GRAPH_FIELDS}", graph_path(id, calendar)),
        None,
        &[],
    )
    .await?;
    Ok(graph_event(&event, &Value::Null))
}

/// Adds an event. Guests are invited by the service.
pub(crate) async fn create(
    home: &Path,
    svc: &Service,
    change: &Change,
    calendar: Option<&str>,
) -> Result<Value> {
    if change.title.as_deref().unwrap_or("").trim().is_empty() {
        return Err(Error::new(4202, "An event needs a title."));
    }
    if change.start.is_none() {
        return Err(Error::new(4202, "An event needs a start."));
    }
    if svc.google() {
        let zone = match &change.time_zone {
            Some(zone) => zone.clone(),
            None if change.needs_zone(true) => {
                google_zone(
                    home,
                    svc,
                    calendar.filter(|c| !c.is_empty()).unwrap_or("primary"),
                )
                .await?
            }
            None => "UTC".to_owned(),
        };
        let made = call(
            home,
            svc,
            Method::POST,
            &format!("{}?sendUpdates=all", google_path(calendar)),
            Some(&change.google(&zone)?),
            &[],
        )
        .await?;
        return Ok(json!({"id": made["id"], "link": made["htmlLink"]}));
    }
    let zone = match &change.time_zone {
        Some(zone) => zone.clone(),
        None if change.needs_zone(false) => outlook_zone(home, svc).await?,
        None => "UTC".to_owned(),
    };
    let path = match calendar.filter(|c| !c.is_empty() && *c != "primary") {
        Some(id) => format!("/v1.0/me/calendars/{}/events", enc(id)),
        None => "/v1.0/me/events".to_owned(),
    };
    let made = call(
        home,
        svc,
        Method::POST,
        &path,
        Some(&change.graph(&zone)?),
        &[],
    )
    .await?;
    Ok(json!({"id": made["id"], "link": made["webLink"]}))
}

/// Changes the fields a bot named, leaving the rest. Guests hear of it.
pub(crate) async fn update(
    home: &Path,
    svc: &Service,
    id: &str,
    change: &Change,
    calendar: Option<&str>,
) -> Result<Value> {
    // A new start alone moves the event: it keeps its length.
    let moved;
    let change = match (change.start, change.end) {
        (Some(start), None) => {
            let event = find(home, svc, id, calendar).await?;
            moved = Change {
                end: kept_end(start, &event),
                ..change.clone()
            };
            &moved
        }
        _ => change,
    };
    if id.is_empty() || id.len() > 1_024 {
        return Err(Error::new(4202, "id must be an event id from list"));
    }
    if svc.google() {
        let zone = match &change.time_zone {
            Some(zone) => zone.clone(),
            None if change.needs_zone(true) => {
                google_zone(
                    home,
                    svc,
                    calendar.filter(|c| !c.is_empty()).unwrap_or("primary"),
                )
                .await?
            }
            None => "UTC".to_owned(),
        };
        let body = change.google(&zone)?;
        if body.as_object().is_none_or(|b| b.is_empty()) {
            return Err(Error::new(4202, "Name what to change."));
        }
        let done = call(
            home,
            svc,
            Method::PATCH,
            &format!("{}/{}?sendUpdates=all", google_path(calendar), enc(id)),
            Some(&body),
            &[],
        )
        .await?;
        return Ok(json!({"id": done["id"], "link": done["htmlLink"]}));
    }
    let zone = match &change.time_zone {
        Some(zone) => zone.clone(),
        None if change.needs_zone(false) => outlook_zone(home, svc).await?,
        None => "UTC".to_owned(),
    };
    let body = change.graph(&zone)?;
    if body.as_object().is_none_or(|b| b.is_empty()) {
        return Err(Error::new(4202, "Name what to change."));
    }
    let done = call(
        home,
        svc,
        Method::PATCH,
        &graph_path(id, calendar),
        Some(&body),
        &[],
    )
    .await?;
    Ok(json!({"id": done["id"], "link": done["webLink"]}))
}

/// Deletes the event `id`, once `title` is what it is called: the approval
/// the user gave names a title, and a wrong id must not delete another.
pub(crate) async fn delete(
    home: &Path,
    svc: &Service,
    id: &str,
    title: &str,
    calendar: Option<&str>,
) -> Result<Value> {
    let event = find(home, svc, id, calendar).await?;
    let actual = event["title"].as_str().unwrap_or("");
    if !actual.trim().eq_ignore_ascii_case(title.trim()) {
        return Err(Error::new(
            4202,
            format!(
                "That id is the event \"{actual}\", not \"{}\". Pass its title to delete it.",
                title.trim()
            ),
        ));
    }
    let path = if svc.google() {
        format!("{}/{}?sendUpdates=all", google_path(calendar), enc(id))
    } else {
        graph_path(id, calendar)
    };
    call(home, svc, Method::DELETE, &path, None, &[]).await?;
    Ok(json!({"deleted": true, "title": actual}))
}

#[cfg(test)]
#[path = "calendar_tests.rs"]
mod tests;
