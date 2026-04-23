#!/usr/bin/env python3
"""
PTY capture helper for differential testing fixtures.

Runs a command under a pseudo-terminal, optionally feeds scripted input, and
dumps all output bytes to a file. Used by scripts/capture-real-app-fixtures.sh
to produce test/differential/corpus/2X-*.vt fixtures.

Usage:
  capture-fixture.py [--cols N] [--rows N] [--term STR] [--settle MS]
                     [--input-delay MS] [--input KEYS]... [--timeout SEC]
                     --output FILE -- command [args...]

Options:
  --cols N          columns for PTY (default 80)
  --rows N          rows for PTY (default 24)
  --term STR        TERM env var (default xterm-256color)
  --settle MS       wait this many ms after child exits before closing (default 100)
  --input-delay MS  wait this many ms between --input chunks (default 150)
  --input KEYS      bytes to send to child stdin; may be repeated. Standard
                    Python escapes interpreted (\\x1b, \\r, \\n, \\033, etc.).
  --timeout SEC     kill child after this many seconds (default 10)
  --output FILE     write captured bytes here (required)

Exit codes:
  0  normal (child exited or was killed after timeout)
  2  argument error
"""
import argparse
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(add_help=True)
    p.add_argument("--cols", type=int, default=80)
    p.add_argument("--rows", type=int, default=24)
    p.add_argument("--term", default="xterm-256color")
    p.add_argument("--settle", type=int, default=100, help="ms after exit before closing")
    p.add_argument("--input-delay", type=int, default=150, help="ms between input chunks")
    p.add_argument("--input", action="append", default=[], help="bytes to send; may repeat")
    p.add_argument("--timeout", type=float, default=10.0)
    p.add_argument("--output", required=True)
    p.add_argument("cmd", nargs=argparse.REMAINDER, help="command after --")
    args = p.parse_args()
    if not args.cmd or args.cmd[0] == "--":
        args.cmd = args.cmd[1:] if args.cmd and args.cmd[0] == "--" else args.cmd
    if not args.cmd:
        p.error("missing command (use -- before cmd)")
    return args


def decode_input(s: str) -> bytes:
    # Interpret Python-style escapes in the --input string: \x1b \r \n \t \\ etc.
    return s.encode("utf-8").decode("unicode_escape").encode("latin-1", errors="replace")


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main() -> int:
    args = parse_args()

    inputs: list[bytes] = [decode_input(s) for s in args.input]

    pid, fd = pty.fork()
    if pid == 0:
        # child
        os.environ["TERM"] = args.term
        os.environ["LC_ALL"] = "en_US.UTF-8"
        os.environ["LANG"] = "en_US.UTF-8"
        os.environ["COLUMNS"] = str(args.cols)
        os.environ["LINES"] = str(args.rows)
        try:
            os.execvp(args.cmd[0], args.cmd)
        except OSError as e:
            sys.stderr.write(f"capture-fixture: exec {args.cmd[0]} failed: {e}\n")
            os._exit(127)

    # parent: set window size on the pty
    set_winsize(fd, args.rows, args.cols)

    captured = bytearray()
    start = time.monotonic()
    next_input_at = start + (args.input_delay / 1000.0) if inputs else None
    child_exited = False
    exit_status = 0

    # Set fd non-blocking so select + read is clean
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    while True:
        now = time.monotonic()
        if now - start > args.timeout:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            break

        # Send next scheduled input chunk
        if inputs and next_input_at is not None and now >= next_input_at:
            chunk = inputs.pop(0)
            try:
                os.write(fd, chunk)
            except OSError:
                pass
            next_input_at = now + (args.input_delay / 1000.0) if inputs else None

        timeout_s = 0.05
        try:
            r, _, _ = select.select([fd], [], [], timeout_s)
        except InterruptedError:
            continue

        if fd in r:
            try:
                data = os.read(fd, 4096)
            except OSError as e:
                if e.errno == errno.EIO:
                    # On Linux/macOS, EIO on pty master means child closed its end
                    data = b""
                elif e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    continue
                else:
                    raise
            if data:
                captured.extend(data)
            else:
                break

        # Poll child status
        try:
            done_pid, status = os.waitpid(pid, os.WNOHANG)
            if done_pid == pid:
                child_exited = True
                exit_status = status
                # Drain any remaining output, then settle briefly
                deadline = time.monotonic() + (args.settle / 1000.0)
                while time.monotonic() < deadline:
                    r, _, _ = select.select([fd], [], [], 0.02)
                    if fd in r:
                        try:
                            more = os.read(fd, 4096)
                        except OSError:
                            more = b""
                        if more:
                            captured.extend(more)
                        else:
                            break
                    else:
                        time.sleep(0.01)
                break
        except ChildProcessError:
            break

    # Make sure we reaped
    if not child_exited:
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass

    try:
        os.close(fd)
    except OSError:
        pass

    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    with open(args.output, "wb") as f:
        f.write(bytes(captured))
    sys.stderr.write(
        f"capture-fixture: wrote {len(captured)} bytes to {args.output} "
        f"(cmd={args.cmd[0]}, status={exit_status})\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
