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

    def drag(selector, dx):
        handle = page.locator(selector + ' > [role=separator]')
        expect(handle).to_be_visible()
        box = handle.bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + dx, y, steps=12)
        page.mouse.up()

    nav, panel = '#function-navigation', '#session-panel'
    expect(page.locator('.member')).to_have_count(4)
    expect(page.locator('.member a, .member button')).to_have_count(0)
    page.locator('.member').first.click()
    expect(page.locator('.worker-readonly')).to_be_visible()
    page.locator('.chat-destination').click()
    page.get_by_role('button', name='Collapse sidebar').click()
    expect_width(nav, 64)
    nav_size = 224
    drag(nav, nav_size - 64)
    expect_width(nav, nav_size)
    page.locator(nav + ' > [role=separator]').press('ArrowRight')
    nav_size += 16
    expect_width(nav, nav_size)
    page.get_by_role('button', name='Session panel', exact=True).click()
    team_size = width(panel) + 75
    drag(panel, -75)
    expect_width(panel, team_size)
    page.locator(panel).get_by_role('button', name='Files', exact=True).click()
    expect_width(panel, team_size)
    drag(panel, 40)
    expect_width(panel, team_size - 40)
    page.get_by_role('button', name='Expand panel').click()
    expect(page.locator(panel + ' > [role=separator]')).to_be_hidden()
    page.get_by_role('button', name='Collapse panel').click()
    page.reload()
    expect_width(nav, nav_size)
    expect_width(panel, team_size - 40)
    page.set_viewport_size({'width': 805, 'height': 900})
    page.locator(nav + ' > [role=separator]').press('End')
    assert width('#conversation') >= 359
    expect(page.locator(panel + ' > [role=separator]')).to_be_hidden()
    page.set_viewport_size({'width': 390, 'height': 844})
    expect(page.locator('[role=separator]:visible')).to_have_count(0)
    page.get_by_role('button', name='Open navigation').click()
    page.locator('.member').first.click()
    expect(page.get_by_role('button', name='Open navigation')).to_have_attribute('aria-expanded', 'false')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert not errors, errors
    browser.close()
    print('Passed: conversation rail, both resizable edges, keyboard, persistence, expanded and mobile layouts.')
