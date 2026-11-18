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
def check_sticky_header(listing):
    # Scroll a row behind the header and hit-test the top and both edges of the scrollport.
    listing.scroll_into_view_if_needed()
    result = listing.evaluate("""el => {
        el.scrollTop = 124;
        const heading = el.querySelector('h3'), box = el.getBoundingClientRect();
        const x = box.left + el.clientLeft, width = el.clientWidth;
        const points = [[width / 2, 2], [2, 16], [width - 3, 16]];
        return el.scrollTop > 0 && points.every(([dx, dy]) =>
            heading.contains(document.elementFromPoint(x + dx, box.top + dy)));
    }""")
    assert result, 'Scrolled content is visible outside the sticky group heading'
    listing.evaluate('el => el.scrollTop = 0')

with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    context = browser.new_context(viewport={'width': 1440, 'height': 960})
    context.add_init_script("if(window===top && !localStorage.getItem('agenthub.configuration.language'))localStorage.setItem('agenthub.configuration.language','en')")
    name, value = info['cookie'].split('=', 1)
    context.add_cookies([{'name': name, 'value': value, 'url': info['base']}])
    errors = []
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(info['base'] + '/configure#integrations')
    tabs = page.get_by_role('navigation', name='Plugin sections')
    expect(tabs.get_by_role('link').first).to_have_text('Capability library')
    expect(tabs.get_by_role('link').first).to_have_attribute('aria-current', 'page')
    expect(page.locator('.integrations-page')).to_have_count(0)
    tabs.get_by_role('link', name='Tool connections').click()
    expect(page.locator('.integrations-page')).to_be_visible()
    tabs.get_by_role('link', name='Marketplace').click()
    expect(tabs.get_by_role('link', name='Marketplace')).to_have_attribute('aria-current', 'page')
    page.get_by_role('link', name='Tools & MCP', exact=True).click()
    expect(page).to_have_url(re.compile(r'#integrations/library$'))
    expect(page.get_by_role('heading', name='Capability library', exact=True)).to_be_visible()
    listing = page.get_by_role('navigation', name='Workspace capabilities')
    detail = page.get_by_role('article', name='Capability details')
    expect(detail.get_by_role('heading', name='AgentHub MCP')).to_be_visible()
    source = page.get_by_role('combobox', name='Filter by source')
    types = page.get_by_role('navigation', name='Capability types')
    expect(listing.get_by_role('region').first).to_have_attribute('aria-label', 'Roppo')
    expect(source.locator('option').nth(1)).to_have_text('Roppo')
    check_sticky_header(listing)
    source.select_option('Codex')
    expect(listing.get_by_role('region')).to_have_count(1)
    codex = listing.get_by_role('region', name='Codex', exact=True)
    expect(codex).to_be_visible()
    types.get_by_role('button', name=re.compile('MCP servers')).click()
    expect(codex.get_by_role('button').first).to_be_visible()
    expect(codex.get_by_role('button').first).to_contain_text('MCP servers')
    expect(codex.get_by_role('button').first).to_have_attribute('aria-current', 'true')
    codex.get_by_role('button').first.click()
    linked_url = page.url
    source.select_option('Roppo')
    expect(listing.get_by_role('region', name='Roppo')).to_be_visible()
    page.go_back()
    expect(page).to_have_url(linked_url)
    expect(source).to_have_value('Codex')
    expect(codex.locator('[aria-current="true"]')).to_be_visible()
    source.select_option('')
    types.get_by_role('button', name=re.compile(r'^All ')).click()
    expect(listing.get_by_role('region').first).to_have_attribute('aria-label', 'Roppo')
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
    types.get_by_role('button', name=re.compile(r'^Skills')).click()
    search.fill('feishu')
    listing.get_by_role('region', name='Roppo').get_by_role('button', name=re.compile(r'^feishu\b', re.I)).click()
    expect(detail).to_contain_text('message')
    library_url = page.url
    page.get_by_role('link', name='General', exact=True).click()
    page.get_by_role('radio', name='Dark', exact=True).check()
    page.goto(library_url)
    expect(detail).to_be_visible()
    page.screenshot(path=str(output / 'library-dark.png'))
    search.fill('NO_MATCH_839254')
    expect(listing).to_contain_text('No matching capabilities')
    search.fill('')
    page.set_viewport_size({'width': 390, 'height': 844})
    types.get_by_role('button', name=re.compile(r'^All ')).click()
    check_sticky_header(listing)
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
    print('Passed default and explicit navigation, source ordering and combined filters, tool-name search, schemas, deep link reload, Skills, empty state, dark mode and mobile back.')
    browser.close()
