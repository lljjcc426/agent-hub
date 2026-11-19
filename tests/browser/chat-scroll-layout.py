"""Check the floating Chat controls against a fresh workflow fixture."""

import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


root = Path(sys.argv[1])
info = json.loads((root / 'browser.json').read_text())
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    context = browser.new_context(viewport={'width': 1280, 'height': 820}, reduced_motion='reduce')
    name, value = info['cookie'].split('=', 1)
    context.add_cookies([{'name': name, 'value': value, 'url': info['base']}])
    context.add_init_script("localStorage.setItem('agenthub.configuration.language','zh-CN')")
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(info['url'])

    def send(page):
        composer = page.locator('.composer-input')
        composer.fill('Keep going')
        expect(page.get_by_role('button', name='发送消息', exact=True)).to_be_enabled()
        composer.press('Enter')

    transcript = page.locator('.transcript')
    latest = page.locator('.scroll-bottom')
    replies = transcript.get_by_text('Still here.', exact=True)
    for count in range(1, 7):
        send(page)
        expect(replies).to_have_count(count, timeout=15000)

    def show_first_message():
        transcript.hover()
        page.mouse.wheel(0, -10000)
        expect(latest).to_have_attribute('data-visible', 'true')
        expect(latest.locator('span')).to_have_count(0)
        page.wait_for_function("document.querySelector('.transcript').scrollTop === 0")
        return transcript.evaluate("""el => {
            const rect = node => node.getBoundingClientRect();
            const lane = el.closest('.conversation-lane');
            const controls = lane.querySelector('.chat-float-center');
            const first = rect(el.querySelector('.message'));
            return {topGap: rect(el).top - rect(lane).top, clearance: first.top - rect(controls).bottom};
        }""")

    layout = show_first_message()
    icon = latest.evaluate("""button => {
        const border = button.getBoundingClientRect();
        const svg = button.querySelector('svg').getBoundingClientRect();
        return {width: border.width, height: border.height,
            dx: svg.x + svg.width / 2 - (border.x + border.width / 2),
            dy: svg.y + svg.height / 2 - (border.y + border.height / 2)};
    }""")
    assert abs(layout['topGap']) < 1 and layout['clearance'] >= 6 and (
        abs(icon['width'] - icon['height']) < 1 and abs(icon['dx']) < .5 and abs(icon['dy']) < .5
    ), (layout, icon)

    assert transcript.evaluate("""el => {
        const bubble = el.querySelector('.user-bubble');
        const controls = el.closest('.conversation-lane').querySelector('.chat-float-center');
        const y = controls.getBoundingClientRect().bottom + 10;
        const first = bubble.getBoundingClientRect();
        el.scrollTop += first.top + first.height / 2 - y;
        const bounds = bubble.getBoundingClientRect();
        return bubble.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
    }""")
    page.screenshot(path=str(root / 'chat-scroll-layout.png'))

    sender = context.new_page()
    sender.goto(info['url'])
    send(sender)
    expect(replies).to_have_count(7, timeout=15000)
    expect(latest).to_have_text('有新消息')
    assert latest.evaluate('el => el.scrollWidth <= el.clientWidth')
    sender.close()
    latest.press('Enter')
    expect(latest).to_have_attribute('data-visible', 'false')
    page.wait_for_function("""() => {
        const el = document.querySelector('.transcript');
        return el.scrollHeight - el.clientHeight - el.scrollTop <= 1;
    }""")

    page.get_by_role('button', name='会话面板', exact=True).click()
    drawer = page.locator('#session-panel')
    expect(drawer).to_be_visible()
    layout = show_first_message()
    assert abs(layout['topGap']) < 1 and layout['clearance'] >= 6, layout
    drawer.get_by_role('button', name='收起面板').click()
    expect(drawer).to_have_count(0)
    page.set_viewport_size({'width': 390, 'height': 820})
    layout = show_first_message()
    assert abs(layout['topGap']) < 1 and layout['clearance'] >= 6, layout
    assert not errors, errors
    print('PASS full-height scroll viewport, first message clearance, centered jump icon, unread badge and keyboard jump')
