"""Exercise the built-in Chat against a fresh examples/chat-acceptance.ts workflow host."""
import json
import sys
from pathlib import Path
from playwright.sync_api import expect, sync_playwright


def check_usage_alignment(panel):
    edges = panel.evaluate("""el => {
      const bounds = selector => [...el.querySelectorAll(selector)].map(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect();
      });
      const meters = [...el.querySelectorAll('[role=meter], .rp-cells')].map(node => node.getBoundingClientRect());
      return {
        left: [...bounds('h3,h4,.rp-capacity strong,dt'), ...meters].map(r => r.left),
        right: [...bounds('.rp-capacity b,.rp-context-legend b,dd'), ...meters].map(r => r.right),
      };
    }""")
    for values in edges.values():
        assert max(values) - min(values) <= 1, values


root = Path(sys.argv[1])
info = json.loads((root / 'browser.json').read_text())
notes_dir = root / 'workspace' / 'sidebar-review'
notes_dir.mkdir(exist_ok=True)
(notes_dir / 'grid-notes.md').write_text('Grid review\n' + 'Sidebar acceptance line\n' * 175)
with sync_playwright() as pw:
    browser = pw.chromium.launch(channel='msedge')
    context = browser.new_context(viewport={'width': 1400, 'height': 940})
    name, value = info['cookie'].split('=', 1)
    context.add_cookies([{'name': name, 'value': value, 'url': info['base']}])
    page = context.new_page()
    errors, context_requests = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: context_requests.append(r.url) if r.url.endswith('/context') else None)
    page.goto(info['url'])
    box = page.locator('.composer-input')
    sidebar = page.get_by_role('complementary', name='Session panel')
    panel = sidebar.get_by_role('region', name='Context usage')
    expect(box).to_be_visible()
    box.fill('Look at /notes.md')
    expect(page.locator('.slash-surface')).to_have_count(0)
    box.fill('/context')
    page.get_by_role('option', name='Context usage /context').click()
    expect(panel).to_contain_text('No usage reported yet')
    expect(panel.get_by_role('meter')).to_have_count(0)
    panel.get_by_role('button', name='Close context usage').click()
    expect(panel).to_have_count(0)
    expect(sidebar.get_by_role('tab', name='Overview')).to_be_visible()
    expect(box).to_be_focused()
    assert not context_requests
    box.fill('Please prepare a release guide for our team.')
    box.press('Enter')
    choice = page.locator('.rp-decision')
    expect(choice).to_contain_text('Which language?', timeout=20000)
    expect(page.locator('.rp-plan')).to_have_count(1)
    page.locator('.tool-activity summary').first.click()
    call = page.locator('.rp-call-group details').first
    call.locator('summary').click()
    expect(call.locator('pre').first).to_have_text('worker_manage')
    expect(call.locator('time')).to_contain_text(':')
    choice.locator('button', has_text='English').click()
    expect(choice.locator('.rp-chosen')).to_have_text('English')
    auth = page.get_by_role('group', name='Authorization request')
    expect(auth).to_contain_text('pwd', timeout=20000)
    expect(page.locator('.rp-plan')).to_have_count(1)
    expect(page.locator('.rp-plan li[data-state=done]')).to_have_count(2)
    box.fill('Keep going');box.press('Enter')
    expect(page.locator('.assistant-message').filter(has_text='Still here.')).to_be_visible()
    assert not context_requests
    page.reload()
    expect(auth).to_contain_text('Inspect the working directory')
    auth.get_by_role('button', name='Allow once').click()
    expect(auth).to_contain_text('Approved')
    question = page.locator('.rp-decision').filter(has_text='Which layout?')
    expect(question).to_be_visible()
    question.locator('button', has_text='Table').click()
    expect(page.locator('.assistant-message').filter(has_text='The Worker verified the layout.')).to_be_visible(timeout=20000)
    assert not context_requests
    box.fill('/');expect(page.get_by_role('listbox')).to_be_visible()
    expect(panel).to_have_count(0)
    assert not context_requests
    box.press('ArrowDown');box.press('Enter')
    expect(panel).to_contain_text('137')
    expect(panel).to_contain_text('8,192')
    expect(panel.get_by_role('meter', name='Model window')).to_have_attribute('aria-valuenow', '137')
    expect(panel.get_by_role('meter',name='Model window').locator('[data-band="0"]')).to_have_count(2)
    grid = panel.get_by_role('img', name='Router input composition')
    expect(grid.locator('i')).to_have_count(100)
    assert grid.evaluate("el => getComputedStyle(el).gridTemplateColumns.split(' ').length") == 25
    assert grid.evaluate("el => new Set([...el.children].map(cell => cell.offsetTop)).size") == 4
    for label in ['System instructions', 'Tool definitions', 'Attachment references', 'Conversation & task data', 'Memory']:
        expect(panel.get_by_role('button', name='Highlight ' + label)).to_be_visible()
    assert grid.locator('[data-band="0"]').count() > 0 and grid.locator('[data-band="1"]').count() > 0
    panel.locator('summary',has_text='Model calls').click()
    expect(panel.locator('.usage-steps')).to_contain_text('3,000 tokens')
    panel.get_by_role('button',name='Older turn').click()
    expect(panel.locator('.usage-history')).to_contain_text('Earlier turn')
    panel.get_by_role('button',name='Latest turn').click()
    expect(panel.locator('.usage-history')).to_contain_text('Latest turn')
    expect(panel).to_have_css('border-radius', '16px')
    expect(sidebar.get_by_role('tab', name='Overview')).to_have_attribute('aria-selected', 'true')
    expect(sidebar.get_by_role('heading', name='Tasks', exact=True)).to_be_visible()
    page.wait_for_function("""() => Math.abs(document.querySelector('#session-panel').getBoundingClientRect().left -
      document.querySelector('.thread').getBoundingClientRect().right) < 1""")
    check_usage_alignment(panel)
    assert context_requests
    box.fill('Draft survives navigation')
    box.press('Escape')
    expect(panel).to_have_count(0)
    expect(box).to_be_focused()
    expect(box).to_have_value('Draft survives navigation')
    expect(page.locator('.user-message')).to_have_count(3)

    expect(sidebar).to_be_visible()
    page.get_by_role('tab', name='Schedules').click()
    box.fill('/');page.get_by_role('option').click()
    expect(panel).to_be_visible()
    expect(page.get_by_role('tab', name='Schedules')).to_have_attribute('aria-selected', 'false')
    box.fill('/context');box.press('Enter')
    expect(sidebar.locator('.rp-inspector-card')).to_have_count(1)
    expect(page.locator('#session-panel')).to_have_count(1)
    panel.get_by_role('button', name='Close context usage').click()
    expect(page.get_by_role('tab', name='Schedules')).to_have_attribute('aria-selected', 'true')
    page.get_by_role('button', name='Close panel').click()

    # An opened card belongs to the overview. Tools keep their own workspace tabs.
    box.fill('/context');box.press('Enter')
    sidebar.get_by_role('button', name='Files', exact=True).click()
    expect(panel).to_have_count(0)
    expect(sidebar.get_by_role('tab', name='Files')).to_have_attribute('aria-selected', 'true')
    sidebar.get_by_role('button', name='sidebar-review', exact=True).click()
    sidebar.get_by_role('button', name='grid-notes.md', exact=True).click()
    expect(sidebar.locator('.file-preview')).to_contain_text('Grid review')
    file_scroll = sidebar.locator('.file-content')
    file_scroll.evaluate('el => el.scrollTop = 180')
    position = file_scroll.evaluate('el => el.scrollTop')
    assert position > 0
    box.fill('/context');box.press('Enter')
    expect(panel).to_contain_text('137')
    panel.get_by_role('button', name='Close context usage').click()
    expect(sidebar.locator('.file-path')).to_contain_text('sidebar-review/grid-notes.md')
    assert file_scroll.evaluate('el => el.scrollTop') == position
    sidebar.get_by_role('button', name='Back to conversation overview').click()
    expect(panel).to_have_count(0)
    box.fill('/context');box.press('Enter')
    sidebar.get_by_role('tab', name='Agents').click()
    expect(panel).to_have_count(0)
    sidebar.get_by_role('tab', name='Overview').click()
    expect(panel).to_contain_text('137')
    sidebar.get_by_role('button', name='Close panel').click()
    page.get_by_role('button', name='Session panel', exact=True).click()
    expect(panel).to_have_count(0)
    sidebar.get_by_role('button', name='Close panel').click()

    box.fill('/context');box.press('Enter')
    expect(panel).to_contain_text('137')
    box.fill('Draft survives navigation')
    page.evaluate("""() => {window.qaFrames=[];const sample=()=>{for(const a of document.getAnimations()){
      if(a.animationName&&a.effect?.getComputedTiming().progress>0&&a.effect.getComputedTiming().progress<1)window.qaFrames.push(a.animationName)}requestAnimationFrame(sample)};sample()}""")
    routes = page.locator('.function-groups a.function-link').evaluate_all("links => links.map(a=>a.getAttribute('href')).filter(h=>h!='/chat')")
    for href in routes + ['/configure#advanced/host', '/configure#usage', '/chat']:
        page.evaluate('window.qaFrames=[]')
        page.locator('a.function-link[href="'+href+'"]').click()
        expect(page.locator('.workspace-page-stage')).to_have_attribute('data-route', href)
        page.wait_for_timeout(410)
        assert {'rp-page-in','rp-content-out'}.issubset(set(page.evaluate('window.qaFrames'))), (href, page.evaluate('window.qaFrames'))
    expect(box).to_have_value('Draft survives navigation')
    expect(panel).to_have_count(0)
    page.emulate_media(reduced_motion='reduce')
    page.evaluate('window.qaFrames=[]')
    page.locator('a[href="/configure#models"].function-link').click()
    page.go_back()
    expect(box).to_be_visible()
    assert 'rp-page-in' not in page.evaluate('window.qaFrames')
    sidebar.get_by_role('button',name='Close panel').click()
    page.set_viewport_size({'width':390,'height':780})
    box.fill('/context');box.press('Enter')
    expect(panel).to_contain_text('137')
    dismiss = panel.get_by_role('button', name='Close context usage')
    expect(dismiss).to_be_focused()
    expect(page.locator('.thread')).to_have_attribute('inert', '')
    bounds=sidebar.bounding_box();assert abs(bounds['x'])<=1 and abs(bounds['width']-390)<=1
    card=panel.bounding_box();assert abs(card['x']-(390-card['x']-card['width'])) <= 1
    check_usage_alignment(panel)
    dismiss.click()
    expect(sidebar).to_be_visible()
    expect(sidebar.get_by_role('tab',name='Overview')).to_be_focused()
    sidebar.get_by_role('button',name='Close panel').click()
    expect(box).to_be_focused()
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')

    partial = {'model': 'provider/' + 'long-model-name' * 5, 'inputTokens': 0, 'capacity': None,
               'budget': {'bytes': 700, 'reservedBytes': 100, 'maxBytes': 2000}}
    page.route('**/conversations/*/context', lambda route: route.fulfill(json=partial))
    box.fill('/context')
    page.get_by_role('button', name='Send message').click()
    model = panel.get_by_role('region', name='Model window')
    expect(model.locator('.rp-capacity strong')).to_have_text('0')
    expect(model).to_contain_text('Window capacity not reported')
    expect(model.get_by_role('meter')).to_have_count(0)
    budget = panel.get_by_role('region', name='Host context budget')
    expect(budget.get_by_role('meter')).to_have_attribute('aria-valuetext', '40%')
    expect(budget.locator('.rp-cells [data-band="0"]')).to_have_count(35)
    expect(budget.locator('.rp-cells [data-band="1"]')).to_have_count(5)
    expect(budget).to_contain_text('2,000 bytes')
    check_usage_alignment(panel)
    dismiss.click()
    expect(sidebar).to_be_visible()
    expect(page.locator('.user-message')).to_have_count(3)
    sidebar.get_by_role('button',name='Close panel').click()
    box.fill('Show me examples of the Chat cards.')
    box.press('Enter')
    preview = page.get_by_role('region',name='Card preview')
    expect(preview).to_be_visible()
    example_actions = []
    page.on('request', lambda r: example_actions.append(r.url) if r.method == 'POST' else None)
    sample = preview.get_by_role('group',name='Authorization request')
    sample.get_by_role('button',name='Deny').click()
    expect(sample).to_contain_text('Denied')
    sample.get_by_role('button',name='Try again').click()
    sample.get_by_role('button',name='Allow once').click()
    expect(sample).to_contain_text('Approved')
    decision = preview.locator('.rp-decision')
    decision.get_by_role('button',name='Table',exact=False).click()
    expect(decision.locator('.rp-chosen')).to_have_text('Table')
    expect(preview.locator('.rp-plan')).to_contain_text('Organize the notes')
    preview.locator('summary',has_text='router_read').click()
    expect(preview.locator('.rp-call-data')).to_contain_text('Example note')
    expect(page.locator('.user-message')).to_have_count(4)
    assert not any('/messages' in url or '/approvals' in url or '/decisions' in url for url in example_actions)
    assert not errors, errors
    print('PASS: live workflow, card previews, context history and composition, independent dismissal, navigation, and mobile focus')
    browser.close()
