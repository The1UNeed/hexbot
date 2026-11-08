# PDF guest protocol, version 1

This private protocol carries one render in one owned VM. It provides no shell,
paths, environment variables, network addresses or executable selection.
All integers are unsigned, big endian. Neither endpoint trusts peer lengths.

The helper installs a listener on its own VZ virtio socket device at port 5000
before boot. The guest connects to host CID 2 at that port. The helper accepts
one connection from that VM and sends one request. Neither endpoint half-closes
its write side before the terminal response. A disconnect cancels the job.

Request header, exactly 32 bytes:

| Offset | Size | Value |
| --- | --- | --- |
| 0 | 8 | ASCII `HXPDF001` |
| 8 | 4 | First page, 1 through 2147483647 |
| 12 | 4 | Last page, at least first, at most first + 24 and 2147483647 |
| 16 | 8 | PDF byte length, 5 through 47185920 |
| 24 | 8 | Reserved, must be zero |

Exactly that many PDF bytes follow. They must begin with `%PDF-`. There is no
filename or second request. Trailing request bytes are an error. Input is copied
to a newly created owner-only `/tmp/input.pdf`, inside a private 64 MiB tmpfs.

The response starts with eight ASCII bytes `HXPNG001`, followed by frames:

- A four-byte length in 1 through 65536, followed by exactly that many raw bytes.
- Or length zero followed by a four-byte terminal status. No payload follows it.

Statuses are 0 for success, 1 for invalid request, 2 for renderer failure, 3 for
output too large, and 4 for timeout. An incomplete response or unknown status is
an error. A validated success terminal frame ends the response. The helper
performs no further read, closes its channel and confirms that the entire VM
has stopped before returning success. Bytes queued after the terminal frame
are discarded during teardown and never forwarded or staged. Every frame
before the terminal remains subject to the chunk and aggregate limits.

The guest shuts down its socket write side after the terminal status. Its
unprivileged worker waits for host close under the same deadline before
exiting; root PID1 waits for the worker and powers off on every exit or startup
failure. The host can stop the VM while that bounded wait is pending. Neither
endpoint depends on a postterminal EOF round trip. There is no init
panic/reboot loop.
Diagnostics go only to the helper's stderr. Guest strings are never interpreted
as commands or inserted into host-facing error text.

Frames are transport chunks, not page boundaries. Their concatenated payload is
Poppler's concatenated PNG stream, with at most 99090240 bytes in total. The
helper enforces this aggregate cap before forwarding raw payload to stdout. The
daemon independently checks PNG signatures, checked chunk lengths, CRC, IHDR,
8192-pixel edges, IEND, page count and its encoded attachment envelope before
staging anything. No PNG files are written inside the VM.

Rendering always invokes the image-owned `/usr/bin/pdftoppm` directly with
`-png -r 150 -f FIRST -l LAST -W 8193 -H 8193 /tmp/input.pdf`. Page numbering,
EOF before the requested last page and A0 behavior retain the existing daemon
contract. Host code must still reject empty, malformed or oversized PNG pages.

The helper's single 120-second deadline covers asset checks, boot, connection,
request/response transfer and VM stop. The worker also enforces a 120-second
upper bound from its start, with deadline-aware socket and renderer polling.
The outer helper deadline is authoritative and includes guest boot. A timeout
can close the socket before a terminal status can be sent. The helper must
report failure and stop the VM in that case.

The worker bounds Poppler's Linux DATA to 512 MiB, CPU to 120 seconds, FSIZE to
99090240 bytes, CORE to zero, open files to 32 and tasks to 64, always retaining
stricter inherited limits. These are defense in depth. The VM's 768 MiB memory
allocation, one vCPU, no swap and owned teardown bound the entire guest and its
descendants. No guest network device, shared directory or host file mount is
configured. Only the immutable kernel/initramfs/rootfs assets and virtio socket
are supplied by the host.
