"""Desktop splitters and mobile drawers against a dedicated chat-acceptance fixture."""
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

fixture = json.loads((Path(sys.argv[1]) / 'browser.json').read_text())
assert not fixture['native']
base = fixture['base']
with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={'width': 1600, 'height': 900}, extra_http_headers={'Origin': base})
    name, value = fixture['cookie'].split('=', 1)
    context.add_cookies([{'name': name, 'value': value, 'url': base}])
    assert context.request.patch(base + '/api/chat/space', data={'display': 'agents'}).ok
    context.add_init_script("localStorage.setItem('agenthub.configuration.language','en')")
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base + '/chat')

    def width(selector):
        return round(page.locator(selector).bounding_box()['width'])

    def expect_width(selector, expected):
        page.wait_for_function('(p) => Math.abs(document.querySelector(p[0]).getBoundingClientRect().width - p[1]) <= 1',
                               arg=[selector, expected], timeout=3500)

    def expect_chat_fills_space():
        page.wait_for_function("""() => {
            const rect = s => document.querySelector(s).getBoundingClientRect()
            const main = rect('#conversation')
            return Math.abs(main.right - rect('.chat-shell').right) <= 1
                && main.left === 0 && !document.querySelector('#function-navigation, .chat-header')
        }""", timeout=3500)

    def expect_writing_line():
        box = page.locator('.composer-input')
        box.fill('第一行\nSecond line')
        result = box.evaluate("""input => {
            const form = input.closest('form'), style = getComputedStyle(form)
            const r = input.getBoundingClientRect(), f = form.getBoundingClientRect()
            return Math.abs(r.left - f.left - parseFloat(style.paddingLeft) - form.clientLeft) < 1
                && Math.abs(f.right - r.right - parseFloat(style.paddingRight) - form.clientLeft) < 1
                && ['start','left'].includes(getComputedStyle(input).textAlign)
        }""")
        assert result, 'The writing line must span the composer content box'
        box.fill('')

    def drag(selector, dx):
        handle = page.locator(selector + ' > [role=separator]')
        expect(handle).to_be_visible()
        handle.evaluate("el => Promise.all(el.parentElement.getAnimations().map(a => a.finished))")
        box = handle.bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + dx, y, steps=12)
        page.mouse.up()

    nav, panel = '#function-navigation', '#session-panel'
    picker = page.get_by_role('button', name='Switch conversation')
    picker.click()
    expect(page.locator('.member')).to_have_count(5)
    page.get_by_role('button', name='Research', exact=True).click()
    expect(page.locator('.worker-readonly')).to_be_visible()
    page.locator('.worker-readonly button').click()
    expect_chat_fills_space()
    expect_writing_line()
    settings = page.get_by_role('link', name='Settings', exact=True)
    settings.click()
    page.get_by_role('button', name='Collapse sidebar').click()
    expect_width(nav, 64)
    page.reload()
    expect_width(nav, 64)
    nav_size = 224
    drag(nav, nav_size - 64)
    expect_width(nav, nav_size)
    page.locator(nav + ' > [role=separator]').press('ArrowRight')
    nav_size += 16
    expect_width(nav, nav_size)
    page.get_by_role('link',name='Back to chat').click()
    page.get_by_role('button', name='Session panel', exact=True).click()
    expect_chat_fills_space()
    expect_writing_line()
    team_size = width(panel) + 75
    drag(panel, -75)
    expect_width(panel, team_size)
    page.locator(panel).get_by_role('tab', name='Agents', exact=True).click()
    expect_width(panel, team_size)
    drag(panel, 40)
    expect_width(panel, team_size - 40)
    page.reload()
    expect_chat_fills_space()
    expect_width(panel, team_size - 40)
    page.set_viewport_size({'width': 805, 'height': 900})
    expect_chat_fills_space()
    page.set_viewport_size({'width': 390, 'height': 844})
    expect(page.locator('[role=separator]:visible')).to_have_count(0)
    page.get_by_role('button', name='Session panel', exact=True).click()
    picker.click()
    page.get_by_role('button', name='Research', exact=True).click()
    expect(picker).to_have_attribute('aria-expanded', 'false')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert context.request.patch(base + '/api/chat/space', data={'display': 'group'}).ok
    page.reload()
    expect(page.locator('.composer-input')).to_be_visible()
    expect_chat_fills_space()
    expect_writing_line()
    page.set_viewport_size({'width': 1728, 'height': 970})
    expect_chat_fills_space()
    expect_writing_line()
    assert not errors, errors
    browser.close()
    print('Passed: floating member picker, settings and floating panel resize, keyboard, persistence and mobile layouts.')
