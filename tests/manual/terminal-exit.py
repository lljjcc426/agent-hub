"""Run on macOS/Linux: python3 tests/manual/terminal-exit.py.

Exercise the production TUI in a real PTY, including its native terminal writes.
Unsupported capability probes must never reach the original shell buffer.
"""
import errno
import fcntl
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import termios
import time

ROOT = Path(__file__).resolve().parents[2]
ENTER, LEAVE = b'\x1b[?1049h', b'\x1b[?1049l'


def check(mode):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
    original = termios.tcgetattr(slave)
    command = [str(ROOT / 'node_modules/.bin/bun'), str(Path(__file__).with_name('terminal-exit-fixture.ts'))]
    if mode == 'startup error':
        command.append('--fail')
    child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, cwd=ROOT,
                             env=dict(os.environ, TERM='xterm-256color', TERM_PROGRAM='Apple_Terminal'))
    output = b''
    sent = False
    deadline = time.monotonic() + 12
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                output += chunk
            elif child.poll() is not None:
                break
            if not sent and b'Ask Roppo' in output:
                if mode == '/exit':
                    os.write(master, b'/exit\r')
                elif mode == 'SIGTERM':
                    child.send_signal(signal.SIGTERM)
                sent = True
        assert child.poll() == 0, (mode, child.poll(), output[-2000:])
        assert output.count(ENTER) == output.count(LEAVE) == 1, mode
        before, active = output.split(ENTER)
        active, after = active.split(LEAVE)
        assert before == b'SHELL_BEFORE\r\n', (mode, before)
        assert after == b'SHELL_RETURN raw=false\r\n', (mode, after)
        # The screenshot's stray text comes from these two native probes.
        assert b'+q4d73' in active and b'Gi=31337' in active, mode
        assert b'\x1b[?1000l' in active and b'\x1b[?2004l' in active, mode
        assert termios.tcgetattr(slave) == original, mode
        print(f'PASS {mode}: shell buffer isolated, input and mouse modes restored')
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        os.close(master)
        os.close(slave)


for mode in ['/exit', 'SIGTERM', 'startup error']:
    check(mode)
