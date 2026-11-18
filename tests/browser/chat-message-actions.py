"""Exercise inline message actions against a fresh examples/chat-space-browser.ts fixture."""
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

out = Path(sys.argv[1])
fixture = json.loads((out / 'fixture.json').read_text())
base = fixture['url']
source = '请**核对摘要**截断规则，再请开发同事验证。'
plain = '请核对摘要截断规则，再请开发同事验证。'
name, value = fixture['cookie'].split('=', 1)
errors = []


def open_chat(browser, width, touch=False):
    ctx = browser.new_context(viewport={'width': width, 'height': 900}, has_touch=touch,
                              is_mobile=touch, reduced_motion='reduce')
    ctx.add_cookies([{'name': name, 'value': value, 'url': base}])
    ctx.add_init_script("localStorage.setItem('agenthub.configuration.language','zh-CN')")
    page = ctx.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base + '/chat', wait_until='networkidle')
    return ctx, page


def assert_side(line, user):
    surface = line.locator('.message-surface').bounding_box()
    actions = line.locator('.message-actions').bounding_box()
    assert surface['y'] < actions['y'] + actions['height'] and actions['y'] < surface['y'] + surface['height']
    if user:
        assert actions['x'] + actions['width'] <= surface['x'] + 1
    else:
        assert surface['x'] + surface['width'] <= actions['x'] + 1


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx, page = open_chat(browser, 1440)
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=base)
    box = page.locator('.composer-input')
    box.fill(source)
    box.press('Enter')
    final = page.locator('.assistant-message').filter(has_text='开发 Worker 已完成修复和回归验证，请验收。')
    expect(final).to_be_visible(timeout=20000)
    expect(page.locator('.transcript .message-status.completed, .transcript .run-status.completed, .message .more-action')).to_have_count(0)
    page.mouse.move(10, 200)
    latest = final.locator('.message-actions')
    expect(latest).to_have_css('opacity', '0')
    assert_side(final.locator('.message-line'), False)
    assert float(final.evaluate("el => parseFloat(getComputedStyle(el).marginBottom)")) <= 14
    user = page.locator('.user-message').filter(has_text=plain).first
    line = user.locator('.message-line')
    assert_side(line, True)
    expect(line.locator('.message-actions')).to_have_css('opacity', '0')
    bubble = user.locator('.user-bubble')
    before = bubble.bounding_box()
    bubble.hover()
    actions = line.locator('.message-actions')
    expect(actions).to_have_css('opacity', '1')
    assert bubble.bounding_box() == before
    actions.get_by_role('button', name='复制消息', exact=True).click()
    assert page.evaluate('navigator.clipboard.readText()') == plain
    actions.get_by_role('button', name='复制 Markdown', exact=True).click()
    assert page.evaluate('navigator.clipboard.readText()') == source
    page.mouse.move(10, 200)
    expect(actions).to_have_css('opacity', '0')

    final.locator('.message-surface').hover()
    latest.get_by_role('button', name='引用回复').click()
    expect(page.locator('.composer-quote')).to_contain_text('开发 Worker 已完成')
    page.get_by_role('button', name='取消引用').click()
    final.locator('.message-surface').hover()
    reaction = latest.get_by_role('button', name='表情回应')
    reaction.click()
    dialog = page.get_by_role('dialog', name='选择表情')
    expect(dialog).to_be_visible()
    dialog.get_by_role('button', name='更多表情').click()
    dialog.get_by_role('textbox').fill('sparkles')
    dialog.get_by_role('button', name='✨').click()
    expect(final.locator('.reaction-pill')).to_contain_text('✨')
    page.mouse.move(10, 200)
    box.focus()
    page.screenshot(path=str(out / 'compact-chat.png'))
    final.locator('.message-surface').hover()
    expect(latest).to_have_css('opacity', '1')
    page.screenshot(path=str(out / 'compact-chat-hover.png'))
    page.mouse.move(10, 200)
    latest.get_by_role('button', name='引用回复').focus()
    page.keyboard.press('Tab')
    expect(reaction).to_be_focused()
    expect(latest).to_have_css('opacity', '1')
    page.keyboard.press('Enter')
    expect(dialog).to_be_visible()
    page.keyboard.press('Escape')
    expect(reaction).to_be_focused()

    touch_ctx, mobile = open_chat(browser, 320, touch=True)
    mobile_line = mobile.locator('.user-message .message-line').first
    mobile_actions = mobile_line.locator('.message-actions')
    expect(mobile_actions).to_have_css('opacity', '0')
    mobile_line.locator('.user-bubble').tap()
    expect(mobile_actions).to_have_css('opacity', '1')
    assert_side(mobile_line, True)
    for rect in [mobile_actions.bounding_box(), mobile_line.locator('.message-surface').bounding_box()]:
        assert rect['x'] >= 0 and rect['x'] + rect['width'] <= 320
    mobile_actions.get_by_role('button', name='引用回复').tap()
    expect(mobile.locator('.composer-quote')).to_contain_text(plain)
    mobile.locator('.composer-input').tap()
    expect(mobile_actions).to_have_css('opacity', '0')
    mobile.get_by_role('button', name='取消引用').tap()
    long_text = '请核对以下清单。' * 12 + '\n\n| 文件 | 状态 |\n| --- | --- |\n| ' + 'archive_' * 20 + ' | 完成 |'
    mobile.locator('.composer-input').fill(long_text)
    mobile.get_by_role('button', name='发送消息', exact=True).tap()
    long_line = mobile.locator('.user-message .message-line').filter(has_text='请核对以下清单。')
    expect(long_line.locator('table')).to_be_visible()
    long_bubble = long_line.locator('.user-bubble')
    before_width = long_bubble.bounding_box()['width']
    long_bubble.locator('p').tap()
    expect(long_line.locator('.message-actions')).to_have_css('opacity', '1')
    assert long_bubble.bounding_box()['width'] == before_width
    assert long_bubble.evaluate("el => el.scrollWidth <= el.clientWidth + 1")
    assert_side(long_line, True)
    assert not errors, errors
    print('Passed inline geometry, compact spacing, hidden actions, clipboard formats, quote, reactions, keyboard and touch.')
    browser.close()
