"""Run after building Chat. This test starts and restarts an isolated workflow host."""
import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def stop(host):
    if host.poll() is not None:
        return
    host.terminate()
    try:
        host.wait(timeout=10)
    except subprocess.TimeoutExpired:
        host.kill()
        host.wait(timeout=5)


def start(root, port):
    info_file = root / 'browser.json'
    last_write = info_file.stat().st_mtime_ns if info_file.exists() else 0
    with (root / 'host.log').open('ab') as log:
        host = subprocess.Popen(['node', '--import', 'tsx', 'examples/chat-acceptance.ts', 'workflow', str(root)],
                                env={**os.environ, 'ROPPO_CHAT_PORT': str(port)}, stdout=log, stderr=log)
    deadline = time.monotonic() + 20
    while host.poll() is None and time.monotonic() < deadline:
        if info_file.exists() and info_file.stat().st_mtime_ns > last_write:
            try:
                return host, json.loads(info_file.read_text())
            except json.JSONDecodeError:
                pass
        time.sleep(0.1)
    stop(host)
    raise RuntimeError('The Chat fixture failed to start. See its host.log.')


def send(page, text, reply):
    composer = page.locator('.composer-input')
    composer.fill(text)
    composer.press('Enter')
    expect(page.locator('.transcript').get_by_text(reply, exact=True)).to_be_visible(timeout=20000)


root = Path(sys.argv[1]).resolve()
root.mkdir(mode=0o700)
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]

host, info = start(root, port)
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context()
        name, value = info['cookie'].split('=', 1)
        context.add_cookies([{'name': name, 'value': value, 'url': info['base']}])
        context.add_init_script("""
          localStorage.setItem('agenthub.configuration.language', 'zh-CN');
          window.chatStreams = [];
          window.sawReconnect = false;
          const NativeEventSource = window.EventSource;
          window.EventSource = class extends NativeEventSource {
            constructor(...args) { super(...args); window.chatStreams.push(this); }
          };
          new MutationObserver(() => {
            if (document.querySelector('.connection-state')) window.sawReconnect = true;
          }).observe(document, {childList: true, subtree: true});
        """)
        page = context.new_page()
        event_requests = []

        def fail_first_stream(route):
            event_requests.append(route.request.url)
            if len(event_requests) == 1:
                route.fulfill(status=503, json={'code': 'configuration_restarting'})
            else:
                route.continue_()

        page.route('**/api/chat/conversations/*/events', fail_first_stream)
        page.goto(info['url'])
        send(page, 'Keep going', 'Still here.')
        stream_open = '() => window.chatStreams.at(-1)?.readyState === EventSource.OPEN'
        page.wait_for_function(stream_open, timeout=12000)
        assert len(event_requests) >= 2
        assert not page.evaluate('() => window.sawReconnect')
        endpoint = event_requests[-1].removesuffix('/events')
        banner = page.locator('.connection-state')
        page.evaluate("() => {window.recoveryDocument = 'same page'}")

        def fail_one_snapshot(route):
            route.fulfill(status=503, json={'code': 'configuration_restarting'})

        page.route(endpoint + '?*', fail_one_snapshot, times=1)
        with page.expect_response(lambda res: res.url.startswith(endpoint + '?') and res.status == 503):
            page.evaluate("() => window.dispatchEvent(new Event('online'))")
        page.wait_for_event('response', predicate=lambda res: res.url.startswith(endpoint + '?') and res.ok, timeout=10000)
        assert page.evaluate(stream_open)
        assert not page.evaluate('() => window.sawReconnect')
        expect(page.locator('.notice.error')).to_have_count(0)

        measured = page.request.get(endpoint + '/context').json()
        assert measured['inputTokens'] == 137 and measured['capacity'] == 8192 and not measured['previous']
        with sqlite3.connect(root / 'state' / 'state.sqlite') as db:
            [(body,)] = db.execute("SELECT body FROM records WHERE kind='chat-call' AND id=?", (measured['activity'],)).fetchall()
            failed = json.loads(body)
            failed.update(id=str(uuid.uuid4()), state='failed', startedAt=failed['startedAt'] + 1)
            db.execute('INSERT INTO records VALUES (?, ?, ?)', ('chat-call', failed['id'], json.dumps(failed)))
        retained = page.request.get(endpoint + '/context').json()
        assert retained['previous'] and retained['activity'] == measured['activity'] and retained['inputTokens'] == 137
        previous_usage = page.get_by_role('button', name='上下文用量 · 已用 1.7%（上次记录）', exact=True)
        expect(previous_usage).to_be_visible()

        stop(host)
        expect(banner).to_be_visible(timeout=12000)
        expect(previous_usage).to_be_visible()
        host, _ = start(root, port)
        page.wait_for_function(stream_open, timeout=16000)
        expect(banner).to_have_count(0, timeout=10000)
        assert page.evaluate('() => window.recoveryDocument') == 'same page'
        send(page, 'Table', 'Switched to table.')
        expect(page.get_by_role('button', name='上下文用量 · 已用 1.7%', exact=True)).to_be_visible()
        empty = {'activity': None, 'at': None, 'model': None, 'composition': None,
                 'inputTokens': None, 'capacity': None, 'budget': None, 'previous': False}
        page.route(endpoint + '/context', lambda route: route.fulfill(json=empty))
        page.reload(wait_until='domcontentloaded')
        expect(previous_usage).to_be_visible()
        with page.expect_response(lambda response: response.url == endpoint + '/context'):
            previous_usage.click()
        expect(page.get_by_role('dialog', name='上下文用量')).to_contain_text('已用 1.7%（上次记录）')
        page.unroute(endpoint + '/context')
        page.keyboard.press('Escape')
        previous_usage.click()
        expect(page.get_by_role('dialog', name='上下文用量')).to_contain_text('已用 1.7%')
        expect(previous_usage).to_have_count(0)
        browser.close()
        print('PASS stream recovery, retained context after reload and empty responses, and refresh on opening usage')
finally:
    stop(host)
