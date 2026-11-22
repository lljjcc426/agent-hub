"""Check the conversation sidebar against an isolated examples/browser-acceptance.ts host."""
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


root = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
info = json.loads((root / 'browser.json').read_text())
assert not info['native']
base = info['base']


def fixture_tasks():
    for year, day, count in [(2026, 22, 18), (2026, 21, 4), (2026, 20, 2), (2025, 22, 1)]:
        for index in range(count):
            time = datetime.fromisoformat(f'{year}-11-{day}T00:{59 - index:02}:00+08:00')
            state = 'running' if index == 0 else 'completed' if index != 2 else 'waiting'
            yield dict(id=f'{year}-{day}-{index}', title=f'任务 {year}/{day}/{index}',
                       workerId='research', state=state, failed=index == 2,
                       reviewing=False, updatedAt=int(time.timestamp() * 1000))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    context = browser.new_context(viewport={'width': 1440, 'height': 960}, timezone_id='Asia/Shanghai')
    name, value = info['cookie'].split('=', 1)
    context.add_cookies([{'name': name, 'value': value, 'url': base}])
    context.add_init_script("localStorage.setItem('agenthub.configuration.language','zh-CN')")
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    sidebar = page.locator('#session-panel')
    popup = page.get_by_role('dialog', name='浏览器', exact=True)
    sessions = popup.get_by_label('浏览器会话', exact=True)
    address = popup.get_by_label('网站地址', exact=True)
    live = popup.get_by_alt_text('浏览器实时页面')
    close_browser = popup.get_by_role('button', name='关闭浏览器视图', exact=True)
    thumbnails = sidebar.locator('.team-browser-preview')
    session_id = None

    def remote(*args):
        state = page.request.get(base + '/api/browser').json()
        session = next(item for item in state['sessions'] if item['id'] == session_id)
        profile = root / 'state/browser/profiles' / session['profileId']
        result = subprocess.run([
            'node_modules/.bin/agent-browser', '--config', str(root / 'state/browser/driver.json'),
            '--session', 'roppo-' + session_id, '--profile', str(profile), '--json', *args,
        ], check=True, capture_output=True, text=True, timeout=12)
        return json.loads(result.stdout)['data']

    def check_fullscreen():
        expect(popup).to_be_visible()
        expect(live).to_be_visible(timeout=20000)
        expect(popup).to_have_css('transform', 'none')
        box = popup.bounding_box()
        assert abs(box['width'] - page.viewport_size['width']) < 2
        assert abs(box['height'] - page.viewport_size['height']) < 2
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')

    try:
        page.goto(info['url'])
        skip = page.get_by_role('button', name='直接聊天', exact=True)
        if skip.is_visible():
            skip.click()
        expect(sidebar.get_by_role('tab', name='Agents')).to_have_attribute('aria-selected', 'true')
        expect(sidebar.locator('.team-browser-heading')).to_be_visible()
        expect(sidebar.get_by_role('tab', name='文件', exact=True)).to_have_count(0)
        sidebar.get_by_role('button', name='打开浏览器', exact=True).click()
        expect(address).to_be_enabled(timeout=25000)
        session_id = sessions.input_value()
        address.fill(info['site'] + '/inputs')
        address.press('Enter')
        input_page = popup.get_by_role('tab', name=re.compile(r'Roppo browser lab|inputs$'))
        expect(input_page).to_be_visible(timeout=15000)
        expect(address).to_be_enabled()
        check_fullscreen()

        box = remote('get', 'box', '#text')
        live_rect = live.bounding_box()
        size = live.evaluate('el => ({w: el.naturalWidth, h: el.naturalHeight})')
        scale = min(live_rect['width'] / size['w'], live_rect['height'] / size['h'])
        x = live_rect['x'] + (live_rect['width'] - size['w'] * scale) / 2 + (box['x'] + box['width'] / 2) * scale
        y = live_rect['y'] + (live_rect['height'] - size['h'] * scale) / 2 + (box['y'] + box['height'] / 2) * scale
        page.mouse.click(x, y)
        page.keyboard.press('Control+a')
        page.keyboard.type('Manual browser input')
        for _ in range(30):
            if remote('get', 'value', '#text')['value'] == 'Manual browser input':
                break
            page.wait_for_timeout(200)
        else:
            raise AssertionError('Manual pointer and text input did not reach the remote page')

        popup.get_by_role('button', name='新建网页').click()
        expect(popup.get_by_role('tab', name='空白页')).to_have_attribute('aria-selected', 'true')
        popup.get_by_role('tab', name='空白页').press('Home')
        expect(input_page).to_have_attribute('aria-selected', 'true')
        popup.get_by_role('button', name='关闭标签页 空白页').click()
        expect(popup.get_by_role('tab', name='空白页')).to_have_count(0)
        expect(address).to_have_value(info['site'] + '/inputs')
        close_browser.click()
        expect(popup).to_have_count(0)
        expect(thumbnails).to_have_count(1)
        expect(thumbnails.first.locator('img')).to_be_visible(timeout=10000)
        thumbnails.first.locator('img').evaluate('el => el.decode()')
        frame = thumbnails.first.locator('.team-browser-frame').bounding_box()
        assert abs(frame['width'] / frame['height'] - 16 / 9) < .02
        page.screenshot(path=str(out / 'agents-browser.png'))

        thumbnails.first.click()
        expect(sessions).to_have_value(session_id)
        expect(address).to_have_value(info['site'] + '/inputs')
        check_fullscreen()
        page.screenshot(path=str(out / 'browser-fullscreen.png'))
        page.keyboard.press('Escape')
        expect(popup).to_have_count(0)
        expect(thumbnails.first).to_be_focused()

        page.set_viewport_size({'width': 390, 'height': 844})
        page.emulate_media(reduced_motion='reduce')
        thumbnails.first.click()
        check_fullscreen()
        expect(close_browser).to_be_visible()
        page.screenshot(path=str(out / 'browser-mobile.png'))
        close_browser.click()
        expect(popup).to_have_count(0)

        page.set_viewport_size({'width': 1440, 'height': 960})
        page.emulate_media(reduced_motion='no-preference')
        sidebar.get_by_role('button', name='收起面板', exact=True).click()
        page.locator('.composer-input').fill('Open the browser lab using both Workers.')
        page.get_by_role('button', name='发送消息', exact=True).click()
        page.get_by_role('button', name='会话面板', exact=True).click()
        sidebar.get_by_role('tab', name='Agents').click()
        worker_browsers = thumbnails.filter(has_text=re.compile(r' · '))
        expect(worker_browsers).to_have_count(2, timeout=60000)
        expect(page.locator('.transcript').get_by_text('Agent 正在浏览', exact=True)).to_have_count(0)
        expect(page.locator('.transcript').get_by_role('button', name='查看网页', exact=True)).to_have_count(0)
        expect(page.locator('.transcript').get_by_role('button', name='接管', exact=True)).to_have_count(0)
        worker_browsers.first.click()
        popup.get_by_role('button', name='接管', exact=True).click()
        continue_task = popup.get_by_role('button', name='继续任务', exact=True)
        expect(continue_task).to_be_visible()
        expect(live).to_be_visible(timeout=20000)
        worker_session = sessions.input_value()
        assert worker_session != session_id
        continue_task.click()
        expect(continue_task).to_have_count(0)
        close_browser.click()
        expect(popup).to_have_count(0)
        expect(thumbnails).to_have_count(3)

        tasks = list(fixture_tasks())

        def serve_tasks(route):
            result = route.fetch()
            data = result.json()
            data.update(plans=[], publicPlans=[], tasks=tasks)
            route.fulfill(response=result, json=data)

        page.route(re.compile(r'/api/chat/conversations/[0-9a-f-]+\?'), serve_tasks)
        page.reload()
        sidebar.get_by_role('tab', name='概览', exact=True).click()
        days = sidebar.locator('.task-activity-day')
        rows = sidebar.locator('.task-activity')
        expect(days).to_have_count(2)
        expect(days.locator('time')).to_have_text(['11月22日', '11月21日'])
        expect(rows).to_have_count(22)
        expect(rows.locator('[data-status="working"]').first).to_have_css('animation-name', 'task-activity-spin')
        expect(rows.locator('[data-status="success"]').first).to_be_visible()
        expect(rows.locator('[data-status="failure"]').first).to_be_visible()
        date = days.first.locator('summary')
        date.press('Enter')
        expect(days.first.locator('.task-activity').first).to_be_hidden()
        date.click()
        expect(days.first.locator('.task-activity').first).to_be_visible()
        older = sidebar.get_by_role('button', name='展开更早任务')
        older.click()
        expect(days).to_have_count(4)
        expect(rows).to_have_count(25)
        expect(days.locator('time').last).to_have_attribute('datetime', '2025-11-22')
        sidebar.get_by_role('button', name='收起更早任务').click()
        expect(rows).to_have_count(22)
        expect(sidebar.get_by_role('heading', name='交付文件')).to_have_count(1)
        days.first.locator('summary').click()
        sidebar.locator('.team-tab-content').evaluate('el => el.scrollTop = 0')
        sidebar.screenshot(path=str(out / 'task-dates.png'))
        assert not errors, errors
        print('PASS date grouping, task icons, desktop/mobile fullscreen, manual input and Worker takeover and return')
    except Exception:
        page.screenshot(path=str(out / 'failure.png'))
        raise
    finally:
        browser.close()
