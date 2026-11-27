//! What the tools for Google and Microsoft connectors share: where they are
//! offered, and which account a call means. A tool such as `hexbot_calendar`
//! serves both Google Calendar and Outlook Calendar; the bot has it once
//! either connector is on and connected, and names the account only when
//! it has both.
use super::*;
use crate::accounts::{self, Service};

/// These tools reach the user's own mail, calendar and files, so they are
/// in the bot's own chat and its scheduled jobs only: a room or a thread
/// between bots may be read by someone who isn't their owner. A heartbeat
/// has none of them.
pub(super) fn here(own: bool, overrides: Option<&Value>) -> bool {
    let job = overrides.is_some_and(|o| o["job"].is_string());
    let heartbeat = overrides.is_some_and(|o| o["heartbeat"].is_string());
    !heartbeat && ((own && overrides.is_none()) || job)
}

/// The connectors of `pairs` (account, connector) that `bot` has on and
/// connected, Google first.
pub(super) fn on(home: &Path, bot: &str, pairs: &[(&str, &str)]) -> Result<Vec<&'static Service>> {
    let mut on = vec![];
    for (_, id) in pairs {
        if crate::connectors::enabled(home, bot, id)? && accounts::connected(home, id)? {
            on.push(accounts::service(id)?);
        }
    }
    Ok(on)
}

/// The connector a call means: the one `args.account` names, or the only
/// one the bot has. `what` is what the user would connect, as in "No
/// calendar is connected for you."
pub(super) fn pick(
    home: &Path,
    bot: &str,
    pairs: &[(&str, &str)],
    args: &Value,
    what: &str,
) -> Result<&'static Service> {
    let on = on(home, bot, pairs)?;
    match args["account"].as_str().filter(|a| !a.is_empty()) {
        Some(want) => {
            let Some((_, id)) = pairs.iter().find(|(account, _)| *account == want) else {
                return Err(Error::new(4202, "account must be google or microsoft"));
            };
            let svc = accounts::service(id)?;
            if on.iter().any(|s| s.id == svc.id) {
                Ok(svc)
            } else {
                Err(Error::new(
                    4210,
                    format!(
                        "{} isn't connected for you. The user connects it and turns it on for you in Settings, Plugins.",
                        svc.name
                    ),
                ))
            }
        }
        None => match on.as_slice() {
            [one] => Ok(one),
            [] => Err(Error::new(
                4210,
                format!(
                    "No {what} is connected for you. The user connects one in Settings, Plugins."
                ),
            )),
            both => Err(Error::new(
                4202,
                format!(
                    "The user has {}. Pass account: google or microsoft.",
                    both.iter()
                        .map(|s| s.name)
                        .collect::<Vec<_>>()
                        .join(" and ")
                ),
            )),
        },
    }
}
