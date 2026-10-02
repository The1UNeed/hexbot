"""Forward historical service commands to the native Hexbot runtime."""

import os
from pathlib import Path
import sys
import time

from hexbot import native_transition
from hexbot.native_transition import handoff

RETRY_FIRST = 30
RETRY_MAX = 3600


def _has_marker() -> bool:
    return (Path(native_transition.__file__).resolve().parent.parent / native_transition.MARKER).is_file()


def main(argv=None, sleep=time.sleep):
    home = str(Path(os.environ.get("HEXBOT_HOME", "~/.hexbot")).expanduser())
    os.environ["HEXBOT_HOME"] = home
    os.environ["HERMES_HOME"] = home
    arguments = list(sys.argv[1:] if argv is None else argv)
    delay = RETRY_FIRST
    while True:
        try:
            # A successful handoff replaces this process, so returning means it failed.
            handoff(arguments)
        except Exception as error:
            if arguments[:1] != ["serve"]:
                raise
            print(f"Hexbot service handoff failed ({error})", file=sys.stderr, flush=True)
        if arguments[:1] != ["serve"] or not _has_marker():
            print("Hexbot service handoff unavailable. Install the native Hexbot runtime.", file=sys.stderr)
            return 1
        # launchd and systemd restart a failing service at once, and systemd soon
        # gives up. Stay up and retry so the service recovers once the install works.
        print(f"Retrying the service handoff in {delay} seconds", file=sys.stderr, flush=True)
        sleep(delay)
        delay = min(delay * 2, RETRY_MAX)


if __name__ == "__main__":
    raise SystemExit(main())
