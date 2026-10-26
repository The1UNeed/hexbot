---
name: computer-use
description: "Work on the bots' shared computer: look, act, look again; hand over when stuck."
version: 3.0.0
author: Hexbot
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [computer-use, desktop, automation, gui, cua]
    category: desktop
    related_skills: []
---

# Computer use

With Computer use on, you have a `computer_use` tool and a computer your bots
share: a Linux desktop (Ubuntu with Xfce, Firefox and a terminal) in a
[Cua](https://cua.ai) sandbox. It is not the user's computer and not your
workspace. Files you make there stay there unless you move them.

Other bots may work on it too. You take turns one action at a time, so the
screen can change between your actions: look before you act, and leave
other bots' windows alone unless the user asks. The user can watch the
screen live in the Computer tab, where each bot's cursor shows its face,
and can take over at any time. While they have it, your actions are
refused: wait until they give it back, then look again before you continue.

## The loop

1. **Look.** `computer_use(action="screenshot")`. Coordinates in every other
   action are pixels in the latest screenshot (its long edge is at most
   1200 px), so take a new one whenever the screen may have changed.
2. **Act.** One step: `click`, `double_click`, `right_click`, `type`, `key`,
   `scroll`, `drag`, `move`.
3. **Check.** Look again, or pass `capture_after=true` to get the screenshot
   with the action's result.

```
computer_use(action="open", url="https://example.com")
computer_use(action="screenshot")
computer_use(action="click", coordinate=[612, 340], capture_after=true)
computer_use(action="type", text="hello")
computer_use(action="key", keys="enter")
computer_use(action="key", keys="ctrl+l")
computer_use(action="scroll", direction="down", amount=5, coordinate=[600, 400])
computer_use(action="drag", coordinate=[100, 200], to_coordinate=[400, 200])
```

Typing goes to the focused window. Click the field first, and check that it
has focus before you type anything long.

## Shortcuts worth taking

- `open` with a URL or a file path opens it in the right app.
- `launch` starts an app by name, such as `firefox` or `xfce4-terminal`.
- `windows` lists open windows when the screen is cluttered.
- `shell` runs a command on that computer (120 s limit): install a package,
  download a file, read what a page saved. It is faster than driving a
  terminal window, and it never touches the user's computer.
- `wait` pauses up to 30 seconds while a page loads.

## When to stop and ask

- A sign-in, a payment, a CAPTCHA, or anything the user's rules say to ask
  about: tell the user what you need. They can take over, do it, and give the
  computer back.
- The same step fails twice: say what you see instead of trying a third time.
- The computer is off or still starting: the first start downloads it, which
  can take a few minutes. Wait, then look again.
