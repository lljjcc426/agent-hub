"""Check the send preference against a fresh chat-acceptance.ts workflow host."""

import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


info = json.loads((Path(sys.argv[1]) / 'browser.json').read_text())
base = info['base']


def verify_shortcuts(browser, platform, modifier, label, reply_count):
    context = browser.new_context(viewport={'width': 1280, 'height': 820}, reduced_motion='reduce')
    name, value = info['cookie'].split('=', 1)
    context.add_cookies([{'name': name, 'value': value, 'url': base}])
    context.add_init_script(
        "localStorage.setItem('agenthub.configuration.language', 'zh-CN');"
        f"Object.defineProperty(navigator, 'platform', {{value: {json.dumps(platform)}}});"
    )
    chat = context.new_page()
    errors = []
    chat.on('pageerror', lambda error: errors.append(str(error)))
    chat.goto(info['url'])
    composer = chat.locator('.composer-input')
    send = chat.get_by_role('button', name='发送消息', exact=True)
    replies = chat.locator('.transcript').get_by_text('Still here.', exact=True)

    def submit(action):
        nonlocal reply_count
        expect(replies).to_have_count(reply_count)
        with chat.expect_request(lambda request: request.method == 'POST' and request.url.endswith('/messages')) as posted:
            action()
        assert posted.value.post_data_json['text'] == 'Keep going'
        reply_count += 1
        expect(replies).to_have_count(reply_count, timeout=15000)

    expect(send).to_have_attribute('aria-keyshortcuts', 'Enter')
    composer.fill('Keep')
    composer.press('Shift+Enter')
    expect(composer).to_have_value('Keep\n')
    composer.fill('Keep going')
    submit(lambda: composer.press('Enter'))

    settings = context.new_page()
    settings.on('pageerror', lambda error: errors.append(str(error)))
    settings.goto(base + '/configure#general')
    field = settings.get_by_role('combobox', name='发送消息快捷键')
    expect(field).to_have_value('enter')
    field.click()
    menu = settings.get_by_role('listbox', name='发送消息快捷键')
    menu.get_by_role('option', name=label, exact=True).click()
    expect(field).to_have_value('modifier-enter')
    expect(send).to_have_attribute('aria-keyshortcuts', modifier + '+Enter')
    settings.reload()
    expect(field).to_have_value('modifier-enter')
    chat.reload()
    expect(send).to_have_attribute('aria-keyshortcuts', modifier + '+Enter')

    composer.fill('Keep')
    composer.press('Enter')
    expect(composer).to_have_value('Keep\n')
    composer.press('Shift+Enter')
    expect(composer).to_have_value('Keep\n\n')
    composer.fill('Keep going')
    composer.evaluate("""input => {
        input.dispatchEvent(new KeyboardEvent('keydown',
            {key: 'Enter', ctrlKey: true, metaKey: true, isComposing: true, bubbles: true, cancelable: true}));
    }""")
    expect(composer).to_have_value('Keep going')
    submit(lambda: composer.press(modifier + '+Enter'))

    composer.fill('/context')
    expect(chat.get_by_role('option', name='上下文用量 /context')).to_be_visible()
    composer.press('Enter')
    context_dialog = chat.get_by_role('dialog', name='上下文用量')
    expect(context_dialog).to_be_visible()
    context_dialog.press('Escape')
    composer.fill('Keep going')
    submit(send.click)

    field.select_option('enter')
    expect(send).to_have_attribute('aria-keyshortcuts', 'Enter')
    composer.fill('Keep going')
    submit(lambda: composer.press('Enter'))
    assert not errors, errors
    context.close()
    return reply_count


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    reply_count = verify_shortcuts(browser, 'MacIntel', 'Meta', '⌘ + Enter', 0)
    verify_shortcuts(browser, 'Win32', 'Control', 'Ctrl + Enter', reply_count)
    browser.close()
print('PASS: default send, complete and persisted shortcut selection, platform keys, newlines, IME, slash menu and click send')
