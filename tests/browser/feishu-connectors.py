"""Roppo UI and host with a simulated Feishu service and real SDK WebSocket."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
from tempfile import TemporaryDirectory
import time

from playwright.sync_api import expect, sync_playwright


def traces(database):
    with sqlite3.connect(database, timeout=5) as conn:
        return {
            json.loads(row[0]).get('meta', {}).get('messageId')
            for row in conn.execute("select body from records where kind='trigger'")
        }


output = Path('.local/feishu-connectors-browser')
output.mkdir(parents=True, exist_ok=True)
setup = '/api/connectors/feishu/setup'
with TemporaryDirectory(prefix='roppo-connectors-') as tmp, sync_playwright() as pw:
    root = Path(tmp)
    server = None
    error_log = (output / 'fixture.log').open('w+')

    def start():
        global server
        server = subprocess.Popen(
            ['node', '--import', 'tsx', 'tests/browser/fixtures/feishu-connectors.ts', str(root)],
            stdout=subprocess.PIPE, stderr=error_log, text=True,
        )
        assert server.stdout.readline().strip() == 'ready', (output / 'fixture.log').read_text()
        return json.loads((root / 'browser.json').read_text())

    def stop():
        if server is not None and server.poll() is None:
            server.terminate()
            try:
                server.wait(10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
                raise

    def context(browser, info, width=1280, dark=False):
        conn = browser.new_context(viewport={'width': width, 'height': 820}, reduced_motion='reduce')
        name, value = info['cookie'].split('=', 1)
        conn.add_cookies([{'name': name, 'value': value, 'url': info['base']}])
        conn.add_init_script("localStorage.setItem('agenthub.configuration.language','zh-CN')")
        if dark:
            conn.add_init_script("localStorage.setItem('agenthub.configuration.theme','dark')")
        return conn

    browser = pw.chromium.launch(channel=os.environ.get('ROPPO_TEST_BROWSER', 'chrome'), headless=True)
    errors = []
    try:
        info = start()
        base = info['base']
        conn = context(browser, info)
        page = conn.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(base + '/chat')
        page.get_by_role('link', name='连接器', exact=True).click()
        expect(page.get_by_role('heading', name='连接器')).to_be_visible()
        expect(page.locator('.studio-rail').get_by_role('link', name='连接器')).to_have_attribute('aria-current', 'page')
        expect(page.get_by_role('button', name='连接飞书')).to_be_visible()
        page.screenshot(path=str(output / 'connectors-light.png'))
        page.get_by_role('searchbox', name='搜索连接器').fill('GitHub')
        expect(page.locator('.connector-row')).to_have_count(1)
        expect(page.get_by_role('link', name='连接GitHub')).to_have_attribute('href', '/configure#connections/new/github')
        page.get_by_role('searchbox', name='搜索连接器').fill('')
        page.get_by_text('已连接', exact=True).click()
        expect(page.get_by_text('还没有连接的应用')).to_be_visible()
        page.get_by_text('可用', exact=True).click()
        page.goto(base + '/configure#integrations/library/app')
        expect(page).to_have_url(base + '/configure#connectors')
        assert pw.request.new_context().get(base + setup).status == 401
        assert conn.request.post(base + setup + '/start', data={}, headers={'origin': 'https://different.example'}).status == 403
        print('PASS: Chat and sidebar links, former URL, search, connected filter, operator boundary', flush=True)

        (root / 'expire-qr').touch()
        page.get_by_role('button', name='连接飞书').click()
        qr = page.get_by_role('img', name='飞书接入二维码')
        expect(qr).to_be_visible()
        once = conn.request.get(base + setup).json()
        repeat = conn.request.post(base + setup + '/start', data={}, headers={'origin': base}).json()
        assert once['id'] == repeat['id'] and once['url'] == repeat['url']
        expect(page.get_by_text('二维码已过期。')).to_be_visible(timeout=8000)
        (root / 'expire-qr').unlink()
        page.get_by_role('button', name='重新扫码').click()
        expect(qr).to_be_visible()
        active = conn.request.get(base + setup).json()
        assert active['id'] != once['id']
        assert qr.evaluate('img => img.complete && img.naturalWidth > 80')
        page.screenshot(path=str(output / 'feishu-qr-light.png'))
        compact = context(browser, info, width=390, dark=True)
        phone = compact.new_page()
        phone.on('pageerror', lambda error: errors.append(str(error)))
        phone.goto(base + '/configure#connectors')
        expect(phone.locator('html')).to_have_attribute('data-theme', 'dark')
        expect(phone.get_by_role('button', name='连接飞书')).to_be_visible()
        phone.screenshot(path=str(output / 'connectors-narrow-dark.png'))
        phone.get_by_role('button', name='连接飞书').click()
        expect(phone.get_by_role('img', name='飞书接入二维码')).to_be_visible()
        phone.screenshot(path=str(output / 'feishu-qr-narrow-dark.png'))
        phone.keyboard.press('Escape')
        expect(phone.get_by_role('dialog')).to_be_hidden()
        compact.close()

        (root / 'approve').touch()
        expect(page.get_by_text('在飞书把「Roppo」拉进群，再刷新。')).to_be_visible(timeout=10000)
        pending = root / 'state/setup/feishu-pairing.json'
        final = root / 'state/setup/credentials.json'
        assert pending.stat().st_mode & 0o777 == 0o600
        assert 'fixture-do-not-expose' not in conn.request.get(base + setup).text()
        assert not final.exists()
        assert conn.request.get(base + '/configuration').json()['current']['revision'] == 0
        print('PASS: SDK approval, expiry and retry, protected credentials before enabling groups', flush=True)

        conn.close()
        stop()
        info = start()
        base = info['base']
        conn = context(browser, info)
        page = conn.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(base + '/configure#connectors')
        assert conn.request.get(base + setup).json() == {'stage': 'saved', 'id': active['id']}
        page.get_by_role('button', name='连接飞书').click()
        expect(page.get_by_text('在飞书把「Roppo」拉进群，再刷新。')).to_be_visible()
        (root / 'show-groups').touch()
        page.get_by_role('button', name='刷新群列表').click()
        expect(page.get_by_role('checkbox', name='研发协作')).to_be_visible()
        expect(page.get_by_role('button', name='连接群', exact=True)).to_be_disabled()
        page.get_by_text('研发协作', exact=True).click()
        expect(page.get_by_role('button', name='连接 1 个群')).to_be_enabled()
        page.get_by_text('发布准备', exact=True).click()
        page.screenshot(path=str(output / 'feishu-groups-light.png'))
        invalid = conn.request.post(base + setup + '/apply', data={'id': active['id'], 'groups': ['oc_forged']}, headers={'origin': base})
        assert invalid.json()['code'] == 'feishu_group_unavailable'

        (root / 'deny-read').touch()
        page.get_by_role('button', name='连接 2 个群').click()
        expect(page.get_by_role('alert')).to_contain_text('机器人暂时无法读取群消息')
        assert pending.exists() and not final.exists()
        (root / 'deny-read').unlink()
        (root / 'fail-rebuild').touch()
        page.get_by_role('button', name='连接 2 个群').click()
        expect(page.get_by_role('alert')).to_contain_text('飞书暂未连接')
        assert pending.exists() and not final.exists()
        assert conn.request.get(base + '/configuration').json()['current']['revision'] == 0

        page.get_by_role('button', name='连接 2 个群').click()
        expect(page.get_by_text('飞书已连接 · 2 个群')).to_be_visible(timeout=18000)
        expect(page.get_by_role('dialog')).to_be_hidden()
        expect(page.get_by_role('link', name='管理Roppo')).to_be_visible()
        assert not pending.exists() and final.stat().st_mode & 0o777 == 0o600
        inventory = conn.request.get(base + '/configuration').json()['current']
        sources = [source for source in inventory['config']['sources'] if source['kind'] == 'feishu']
        assert len(sources) == 1 and inventory['revision'] == 1
        assert sources[0]['feishu']['chats'] == ['oc_build', 'oc_launch']
        assert sources[0]['feishu']['liveEvents']
        assert sources[0]['allowedActors'] == ['ou_pairing_owner']
        assert 'fixture-do-not-expose' not in json.dumps(inventory)
        request = {'id': active['id'], 'groups': ['oc_build', 'oc_launch']}
        assert conn.request.post(base + setup + '/apply', data=request, headers={'origin': base}).json()['sourceId'] == sources[0]['id']
        print('PASS: restart across approval, multi-group selection, permission failure, rollback, idempotent retry', flush=True)

        def live_ready():
            return any(row['status'] == 'ready' for row in conn.request.get(base + '/status').json()['liveSources'])

        deadline = time.monotonic() + 9
        while not live_ready() and time.monotonic() < deadline:
            time.sleep(.2)
        assert live_ready(), conn.request.get(base + '/status').json()['liveSources']
        events = root / 'events.json.tmp'
        events.write_text(json.dumps([
            {'chat': 'oc_build', 'message': 'om_build'},
            {'chat': 'oc_launch', 'message': 'om_launch'},
            {'chat': 'oc_other', 'message': 'om_wrong'},
            {'chat': 'oc_build', 'message': 'om_old', 'ago': 120000},
        ]))
        events.replace(root / 'events.json')
        seen = set()
        deadline = time.monotonic() + 12
        while not {'om_build', 'om_launch'}.issubset(seen) and time.monotonic() < deadline:
            seen = traces(root / 'state/state.sqlite')
            time.sleep(.2)
        assert seen == {'om_build', 'om_launch'}, seen
        assert not errors, errors
        page.screenshot(path=str(output / 'connectors-connected-light.png'))
        print('PASS: SDK WebSocket delivery enters the selected groups only, no historical replay', flush=True)

        conn.close()
        stop()
        info = start()
        base = info['base']
        conn = context(browser, info, width=390)
        page = conn.new_page()
        page.goto(base + '/configure#connectors')
        expect(page.get_by_role('button', name='连接飞书')).to_be_visible()
        page.locator('.connectors-filter').get_by_text('已连接', exact=True).click()
        expect(page.get_by_role('link', name='管理Roppo')).to_be_visible()
        assert page.locator('.connectors-page').evaluate('el => el.scrollWidth <= el.clientWidth')
        assert conn.request.get(base + '/configuration').json()['current']['config']['sources'][-1]['id'] == sources[0]['id']
        page.screenshot(path=str(output / 'connectors-connected-narrow.png'))
        print('PASS: credential and scope reloaded from the original host configuration', flush=True)
    finally:
        stop()
        error_log.close()
        browser.close()
