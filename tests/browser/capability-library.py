"""Exercise an authenticated Roppo host through its regular navigation."""
import json
import re
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(sys.argv[1])
info = json.loads((root / 'browser.json').read_text())
output = root / 'screenshots'
output.mkdir(exist_ok=True)
with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    context = browser.new_context(viewport={'width': 1440, 'height': 960})
    name, value = info['cookie'].split('=', 1)
    context.add_cookies([{'name': name, 'value': value, 'url': info['base']}])
    errors = []
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(info['base'] + '/configure#integrations/market')
    page.get_by_role('link', name='Capability library', exact=True).click()
    expect(page.get_by_role('heading', name='Capability library', exact=True)).to_be_visible()
    listing = page.get_by_role('navigation', name='Workspace capabilities')
    detail = page.get_by_role('article', name='Capability details')
    expect(detail.get_by_role('heading', name='AgentHub MCP')).to_be_visible()
    search = page.get_by_role('textbox', name='Search capabilities or tool names')
    page.keyboard.press('/')
    expect(search).to_be_focused()
    search.fill('agent_status')
    listing.get_by_role('button', name=re.compile('AgentHub MCP')).click()
    detail.locator('summary').filter(has_text='agent_status').click()
    expect(detail.locator('details[open]')).to_contain_text('discussion')
    shared = page.url
    page.screenshot(path=str(output / 'library-mcp.png'))
    page.reload()
    expect(detail.get_by_role('heading', name='AgentHub MCP')).to_be_visible()
    assert page.url == shared
    types = page.get_by_role('navigation', name='Capability types')
    types.get_by_role('button', name=re.compile(r'^Skills')).click()
    search.fill('feishu')
    listing.get_by_role('button', name=re.compile(r'^feishu Roppo', re.I)).click()
    expect(detail).to_contain_text('message')
    page.get_by_role('button', name='Switch to dark mode', exact=True).click()
    page.screenshot(path=str(output / 'library-dark.png'))
    search.fill('NO_MATCH_839254')
    expect(listing).to_contain_text('No matching capabilities')
    search.fill('')
    page.set_viewport_size({'width': 390, 'height': 844})
    types.get_by_role('button', name=re.compile('MCP servers')).click()
    expect(listing).to_be_visible()
    listing.get_by_role('button', name=re.compile('AgentHub MCP')).click()
    expect(listing).to_be_hidden()
    expect(detail.get_by_role('heading', name='AgentHub MCP')).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(output / 'library-mobile.png'))
    detail.get_by_role('button', name='Back to list').click()
    expect(listing).to_be_visible()
    assert not errors, errors
    print('Passed desktop navigation, tool-name search, schemas, deep link reload, Skills, empty state, dark mode and mobile back.')
    browser.close()
