"""Pure rendering of a bot's room prompt."""

MAX_LINES = 40
MAX_BYTES = 96 * 1024

RULES = """Room rules:
- Reply once. Say (pass) when you have nothing to add.
- Mention a member by @handle to bring them in.
- Mention @user when you need the human, then wait.
- Do not reveal private conversations."""


def transcript_lines(events):
    lines = []
    for event in events:
        if event["kind"] not in {"message.user", "message.bot", "note"}:
            continue
        text = str(event.get("payload", {}).get("text", "")).replace("\r", "").strip()
        if not text:
            continue
        speaker = "User" if event["kind"] == "message.user" else (
            "System" if event["kind"] == "note" else f"@{event.get('actor_id')}")
        lines.extend(f"{speaker}: {part}" if index == 0 else part
                     for index, part in enumerate(text.splitlines()))
    return lines


def _cap(lines):
    omitted = 0
    while len(lines) > MAX_LINES or len("\n".join(lines).encode()) > MAX_BYTES:
        lines.pop(0); omitted += 1
    if omitted:
        summary = f"[... {omitted} older transcript lines omitted ...]"
        while lines and (len(lines) >= MAX_LINES or
                         len((summary + "\n" + "\n".join(lines)).encode()) > MAX_BYTES):
            lines.pop(0); omitted += 1
            summary = f"[... {omitted} older transcript lines omitted ...]"
        lines.insert(0, summary)
    return lines


def render(room, bot, events, collecting_replies=None):
    active = [m["member_id"] for m in room["members"] if m["left_at"] is None]
    titles = room.get("member_titles", {})
    members = ", ".join(f"@{name}" + (f" ({titles[name]})" if titles.get(name) else "") for name in active)
    lines = _cap(transcript_lines(events))
    if collecting_replies:
        lines.append("Replies to collect:")
        lines.extend(f"@{name}: {text}" for name, text in collecting_replies)
    transcript = "\n".join(lines) or "(no messages)"
    return f"Room: {room['name']}\nYou are @{bot}. Members: {members}\n\nTranscript since your last turn:\n{transcript}\n\n{RULES}"
