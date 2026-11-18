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
    context.add_init_script("if (!localStorage.getItem('agenthub.configuration.language')) localStorage.setItem('agenthub.configuration.language','en')")
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
    toolbar = page.locator('.composer-toolbar')
    expect(toolbar.get_by_role('button', name='Browser', exact=True)).to_have_count(0)
    expect(toolbar.locator('.team-chip')).to_have_count(0)
    direct_model = toolbar.get_by_role('button', name='Model connection', exact=False)
    direct_policy = toolbar.get_by_role('button', name='Approval policy', exact=False)
    ring = toolbar.get_by_role('button', name='Context usage', exact=False)
    expect(toolbar.locator('.composer-choice .lucide-chevron-down')).to_have_count(0)
    expect(ring).to_have_attribute('aria-label', 'Context usage · No usage reported yet')
    expect(ring.locator('.usage-fill')).to_have_count(0)
    overview = page.get_by_role('dialog', name='Context usage')
    details = overview.get_by_role('button', name='View usage details')

    def composer_anchor():
        popover = page.locator('.composer-palette')
        popover.evaluate('el => Promise.allSettled(el.getAnimations().map(a => a.finished))')
        palette = popover.bounding_box()
        composer = page.locator('form.composer').bounding_box()
        assert palette and composer and abs(palette['x'] - composer['x']) <= 1, (palette, composer)
        return palette

    def same_anchor(before):
        after = composer_anchor()
        assert after and abs(before['x'] - after['x']) <= 1 and abs(before['width'] - after['width']) <= 1
        assert min(abs(before['y'] - after['y']),
                   abs(before['y'] + before['height'] - after['y'] - after['height'])) <= 1

    actions = page.get_by_role('button', name='Chat actions', exact=True)
    actions.click()
    menu = page.get_by_role('menu', name='Chat actions', exact=True)
    expect(menu.get_by_role('menuitem')).to_have_count(4)
    anchor = composer_anchor()
    menu.get_by_role('menuitem', name='Model connection').click()
    model_dialog=page.get_by_role('dialog',name='Chat model')
    select_connection = model_dialog.get_by_role('button', name='Model connection ·')
    effort = model_dialog.get_by_role('slider', name='Reasoning effort')
    expect(effort).to_be_visible()
    same_anchor(anchor)
    select_connection.click()
    expect(model_dialog.get_by_role('menuitemradio', checked=True)).to_be_focused()
    same_anchor(anchor)
    page.keyboard.press('Escape')
    expect(select_connection).to_be_focused()
    model_dialog.get_by_role('button', name='Back to chat actions').click()
    expect(menu.get_by_role('menuitem')).to_have_count(4)
    page.keyboard.press('Escape')
    expect(actions).to_be_focused()
    direct_model.click()
    expect(effort).to_be_visible()
    same_anchor(anchor)
    select_connection.click()
    same_anchor(anchor)
    model_dialog.get_by_role('link',name='Manage connections').click()
    expect(model_dialog).not_to_be_visible()
    page.locator('a.return-chat').click()
    expect(box).to_be_visible()
    box.fill('/');expect(page.get_by_role('option')).to_have_count(4)
    anchor = composer_anchor()
    page.get_by_role('option',name='Approval policy /permissions').click()
    same_anchor(anchor)
    page.keyboard.press('Escape')
    expect(box).to_be_focused()
    expect(box).to_have_value('/')
    expect(page.get_by_role('option')).to_have_count(4)
    box.fill('/permissions')
    box.press('Enter')
    policy=page.get_by_role('menu',name='Approval policy')
    expect(policy.get_by_role('menuitemradio',name='Request approval')).to_be_checked()
    full = policy.get_by_role('menuitemradio',name='Full access')

    def red(control):
        return control.evaluate("""el => {
          const [r,g,b] = getComputedStyle(el).color.match(/\d+/g).map(Number)
          return r > 1.4 * g && r > 1.4 * b
        }""")

    assert red(full)
    full.click()
    expect(policy).not_to_be_visible()
    expect(direct_policy).to_have_attribute('aria-label', 'Approval policy · Full access')
    assert red(direct_policy)
    page.reload()
    direct_policy.click()
    expect(full).to_be_checked()
    composer_anchor()
    page.keyboard.press('Escape')
    expect(direct_policy).to_be_focused()
    actions.click()
    page.get_by_role('menuitem',name='Approval policy Full access').click()
    expect(policy.get_by_role('menuitemradio',name='Full access')).to_be_checked()
    policy.get_by_role('menuitemradio',name='Request approval').click()
    expect(policy).not_to_be_visible()
    expect(direct_policy).to_have_attribute('aria-label', 'Approval policy · Request approval')
    assert not red(direct_policy)
    box.fill('/attach')
    with page.expect_file_chooser() as chooser:
        page.get_by_role('option',name='Add files /attach').click()
    chooser.value.set_files({'name':'permission-notes.txt','mimeType':'text/plain','buffer':b'Roppo'})
    attachment=page.get_by_role('button',name='Remove permission-notes.txt')
    expect(attachment).to_be_visible();attachment.click()
    box.fill('Keep this draft')
    actions.click();page.get_by_role('menuitem',name='Context usage').click()
    details.click()
    expect(panel).to_be_visible()
    panel.get_by_role('button',name='Close context usage').click()
    expect(box).to_have_value('Keep this draft')
    sidebar.get_by_role('button',name='Close panel').click()
    box.fill('Look at /notes.md')
    expect(page.locator('.composer-palette')).to_have_count(0)
    box.fill('/context')
    page.get_by_role('option', name='Context usage /context').click()
    details.click()
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
    trace = page.locator('.transcript .trace-inline').filter(has_text='Checked the team').first
    expect(trace.locator('> summary')).to_contain_text('Checked the team')
    expect(trace.locator('.trace-step').first).not_to_be_visible()
    assert trace.evaluate("e => getComputedStyle(e).borderTopWidth")=='0px'
    trace.locator('> summary').focus();page.keyboard.press('Enter')
    call=trace.locator('.trace-step').first
    call.locator('summary').click()
    expect(call.locator('code')).to_have_text('worker_manage')
    expect(call.locator('time')).to_contain_text(':')
    choice.locator('button', has_text='English').click()
    expect(choice.locator('.rp-chosen')).to_have_text('English')
    auth = page.get_by_role('group', name='Authorization request')
    expect(auth).to_contain_text('pwd', timeout=20000)
    assert auth.evaluate("e => !!e.closest('.transcript') && !e.closest('dialog,[role=dialog]')")
    expect(page.locator('.rp-plan')).to_have_count(1)
    expect(page.locator('.rp-plan li[data-state=done]')).to_have_count(2)
    box.fill('Keep going');box.press('Enter')
    expect(page.locator('.assistant-message').filter(has_text='Still here.')).to_be_visible()
    page.reload()
    expect(auth).to_contain_text('Inspect the working directory')
    auth.get_by_role('button', name='Allow once').click()
    expect(auth).to_contain_text('Approved')
    question = page.locator('.rp-decision').filter(has_text='Which layout?')
    expect(question).to_be_visible()
    question.locator('button', has_text='Table').click()
    expect(page.locator('.assistant-message').filter(has_text='The Worker verified the layout.')).to_be_visible(timeout=20000)
    expect(page.get_by_role('group', name='Which language?').get_by_role('status')).to_have_text('English')
    expect(page.get_by_role('status').filter(has_text='Which layout?')).to_contain_text('Answered')
    expect(page.locator('.assistant-message').filter(has_text='Verified layout: Table')).to_be_visible()
    expect(ring).to_have_attribute('aria-label', 'Context usage · 1.7% used')
    ring.click()
    expect(overview).to_contain_text('137 / 8,192 tokens')
    page.keyboard.press('Escape')
    expect(ring).to_be_focused()
    box.fill('/');expect(page.get_by_role('listbox')).to_be_visible()
    expect(panel).to_have_count(0)
    box.press('ArrowUp');box.press('Enter')
    expect(overview).to_contain_text('137 / 8,192 tokens')
    details.click()
    expect(panel).to_contain_text('137')
    expect(panel).to_contain_text('8,192')
    expect(panel.get_by_role('meter', name='Model window')).to_have_attribute('aria-valuenow', '137')
    expect(panel.get_by_role('meter',name='Model window').locator('[data-band="0"]')).to_have_count(2)
    grid = panel.get_by_role('img', name='Chat input composition')
    expect(grid.locator('i')).to_have_count(100)
    assert grid.evaluate("el => getComputedStyle(el).gridTemplateColumns.split(' ').length") == 25
    assert grid.evaluate("el => new Set([...el.children].map(cell => cell.offsetTop)).size") == 4
    for label in ['System instructions', 'Tool definitions', 'Attachment references', 'Conversation & task data', 'Memory']:
        expect(panel.get_by_role('button', name='Highlight ' + label)).to_be_visible()
    assert grid.locator('[data-band="0"]').count() > 0 and grid.locator('[data-band="1"]').count() > 0
    expect(panel.get_by_role('navigation', name='Input history')).to_have_count(0)
    expect(panel.get_by_text('Model calls', exact=False)).to_have_count(0)
    expect(panel.get_by_text('3,000 tokens')).to_have_count(0)
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
    user_messages = page.locator('.user-message [data-message-body]')
    sent_texts = ['Please prepare a release guide for our team.', 'Keep going']
    expect(user_messages).to_have_text(sent_texts)

    expect(sidebar).to_be_visible()
    page.get_by_role('tab', name='Schedules').click()
    box.fill('/');page.get_by_role('option',name='Context usage /context').click()
    details.click()
    expect(panel).to_be_visible()
    expect(page.get_by_role('tab', name='Schedules')).to_have_attribute('aria-selected', 'false')
    box.fill('/context');box.press('Enter')
    details.click()
    expect(sidebar.locator('.rp-inspector-card')).to_have_count(1)
    expect(page.locator('#session-panel')).to_have_count(1)
    panel.get_by_role('button', name='Close context usage').click()
    expect(page.get_by_role('tab', name='Schedules')).to_have_attribute('aria-selected', 'true')
    page.get_by_role('button', name='Close panel').click()

    # An opened card belongs to the overview. Tools keep their own workspace tabs.
    box.fill('/context');box.press('Enter')
    details.click()
    sidebar.get_by_role('button', name='Files', exact=True).click()
    expect(panel).to_have_count(0)
    expect(sidebar.get_by_role('tab', name='Files')).to_have_attribute('aria-selected', 'true')
    sidebar.get_by_role('radio', name='Task folders').check()
    sidebar.get_by_role('button', name='sidebar-review', exact=True).click()
    sidebar.get_by_role('button', name='grid-notes.md', exact=True).click()
    expect(sidebar.locator('.file-preview')).to_contain_text('Grid review')
    file_scroll = sidebar.locator('.file-content')
    file_scroll.evaluate('el => el.scrollTop = 180')
    position = file_scroll.evaluate('el => el.scrollTop')
    assert position > 0
    box.fill('/context');box.press('Enter')
    details.click()
    expect(panel).to_contain_text('137')
    panel.get_by_role('button', name='Close context usage').click()
    expect(sidebar.locator('.file-path')).to_contain_text('sidebar-review/grid-notes.md')
    assert file_scroll.evaluate('el => el.scrollTop') == position
    sidebar.get_by_role('button', name='Back to conversation overview').click()
    expect(panel).to_have_count(0)
    box.fill('/context');box.press('Enter')
    details.click()
    sidebar.get_by_role('tab', name='Agents').click()
    expect(panel).to_have_count(0)
    sidebar.get_by_role('tab', name='Overview').click()
    expect(panel).to_contain_text('137')
    sidebar.get_by_role('button', name='Close panel').click()
    page.get_by_role('button', name='Session panel', exact=True).click()
    expect(panel).to_have_count(0)
    sidebar.get_by_role('button', name='Close panel').click()

    box.fill('/context');box.press('Enter')
    details.click()
    expect(panel).to_contain_text('137')
    box.fill('Draft survives navigation')
    page.evaluate("""() => {window.qaFrames=[];const sample=()=>{for(const a of document.getAnimations()){
      if(a.animationName&&a.effect?.getComputedTiming().progress>0&&a.effect.getComputedTiming().progress<1)window.qaFrames.push(a.animationName)}requestAnimationFrame(sample)};sample()}""")
    def check_route(link, href):
        page.evaluate('window.qaFrames=[]')
        link.click()
        expect(page.locator('.workspace-page-stage')).to_have_attribute('data-route', href)
        page.wait_for_timeout(410)
        assert {'rp-page-in','rp-content-out'}.issubset(set(page.evaluate('window.qaFrames'))), (href, page.evaluate('window.qaFrames'))

    check_route(page.locator('a.footer-settings'), '/configure#general')
    links = page.locator('.studio-settings-links a')
    routes = links.evaluate_all("xs=>xs.map(a=>a.getAttribute('href')).filter(h=>h!='/configure#general')")
    assert '/configure#workspace' in routes and '/configure#models' in routes
    for href in [h for h in routes if h != '/configure#workspace'] + ['/configure#workspace']:
        check_route(links.and_(page.locator('a[href="'+href+'"]')), href)
    check_route(page.locator('.settings-directory a[href="/configure#advanced/host"]'), '/configure#advanced/host')
    check_route(page.locator('a.return-chat'), '/chat')
    expect(box).to_have_value('Draft survives navigation')
    expect(panel).to_have_count(0)
    page.emulate_media(reduced_motion='reduce')
    page.evaluate('window.qaFrames=[]')
    page.locator('a.footer-settings').click()
    page.go_back()
    expect(box).to_be_visible()
    assert 'rp-page-in' not in page.evaluate('window.qaFrames')
    sidebar.get_by_role('button',name='Close panel').click()
    for width in (390, 320):
        page.set_viewport_size({'width':width, 'height':780})
        assert direct_model.locator('span').evaluate("""span => {
          const range = document.createRange(); range.selectNodeContents(span)
          const bounds = span.getBoundingClientRect()
          return Array.from(range.getClientRects()).every(rect =>
            rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 &&
            rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1)
        }"""), 'The model name must fit horizontally and keep its descenders'
    page.set_viewport_size({'width':390,'height':780})
    for trigger in (direct_model, direct_policy, ring):
        trigger.click()
        composer_anchor()
        page.keyboard.press('Escape')
        expect(trigger).to_be_focused()
    actions.click()
    page.get_by_role('menuitem',name='Approval policy Request approval').click()
    bounds=policy.bounding_box();assert bounds and bounds['x']>=0 and bounds['x']+bounds['width']<=390
    page.keyboard.press('Escape');expect(menu).to_be_visible()
    page.keyboard.press('Escape');expect(actions).to_be_focused()
    box.fill('/model')
    anchor = composer_anchor()
    box.press('Enter')
    expect(effort).to_be_visible()
    same_anchor(anchor)
    select_connection.click()
    same_anchor(anchor)
    page.keyboard.press('Escape')
    expect(toolbar.get_by_role('button', name='Send message')).to_be_visible()
    model_dialog.get_by_role('button', name='Back to chat actions').click()
    expect(box).to_have_value('/model')
    box.press('Escape')

    box.fill('/context');box.press('Enter')
    details.click()
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
    details.click()
    model = panel.get_by_role('region', name='Model window')
    expect(model.locator('.rp-capacity strong')).to_have_text('0')
    expect(model).to_contain_text('Window capacity not reported')
    expect(ring).to_have_attribute('aria-label', 'Context usage · Window capacity not reported')
    expect(ring.locator('.usage-fill')).to_have_count(0)
    expect(model.get_by_role('meter')).to_have_count(0)
    budget = panel.get_by_role('region', name='Host context budget')
    expect(budget.get_by_role('meter')).to_have_attribute('aria-valuetext', '40%')
    expect(budget.locator('.rp-cells [data-band="0"]')).to_have_count(35)
    expect(budget.locator('.rp-cells [data-band="1"]')).to_have_count(5)
    expect(budget).to_contain_text('2,000 bytes')
    check_usage_alignment(panel)
    dismiss.click()
    expect(sidebar).to_be_visible()
    expect(user_messages).to_have_text(sent_texts)
    sidebar.get_by_role('button',name='Close panel').click()
    box.fill('Let me review the release notes before delivery.')
    box.press('Enter')
    review = page.locator('.rp-approval').filter(has_text='release-notes.md')
    expect(review).to_be_visible()
    expect(page.get_by_role('button',name='Open file release-notes.md')).to_have_count(0)
    review.locator('summary').click()
    expect(review.locator('pre')).to_have_text('# Release notes\n\nLayout verified by Research.')
    page.reload()
    review.get_by_role('button',name='Deliver file',exact=True).click()
    page.get_by_role('button',name='Open file release-notes.md').click()
    with page.expect_download() as download:
        page.locator('.delivery-download').click()
    assert download.value.path().read_text() == '# Release notes\n\nLayout verified by Research.'
    page.keyboard.press('Escape')
    box.fill('Draft a checklist; pick the layout.');box.press('Enter')
    optional=page.get_by_role('group',name='Checklist layout?')
    expect(optional).to_contain_text('Using this option')
    expect(page.get_by_role('button',name='Open file checklist.md')).to_be_visible()
    expect(page.locator('.assistant-message').filter(has_text='Checklist ready.')).to_be_visible()
    optional.get_by_role('button',name='Table',exact=False).click()
    expect(page.locator('.assistant-message').filter(has_text='Switched to table.')).to_be_visible()
    def current_settings():
        return context.request.get(info['base'] + '/configuration').json()['current']

    writes = []
    page.on('request', lambda r: writes.append(r) if r.method == 'POST' and r.url == info['base'] + '/settings' else None)
    def settings_response(r):
        return r.request.method == 'POST' and r.url == info['base'] + '/settings'

    box.fill('Unsaved message')
    direct_model.click()
    select_connection.click()
    model_dialog.get_by_role('menuitemradio', checked=True).click()
    expect(effort).to_be_visible()
    assert not writes
    initial = current_settings()
    page.emulate_media(reduced_motion='no-preference')
    model_dialog.evaluate('el => Promise.allSettled(el.getAnimations({subtree:true}).map(a => a.finished))')
    bounds = effort.bounding_box()
    y = bounds['y'] + bounds['height'] / 2
    thumb = model_dialog.locator('.effort-thumb')
    def thumb_center():
        rect = thumb.bounding_box()
        return rect['x'] + rect['width'] / 2
    start = thumb_center()
    page.mouse.move(start, y)
    page.mouse.down()
    page.mouse.move(start + 9, y, steps=3)
    moved = thumb_center() - start
    assert abs(moved - 9) <= 1.5, ('Thumb must follow a drag between detents', moved)
    expect(effort).to_have_attribute('aria-valuetext', 'Medium')
    page.mouse.move(bounds['x'] + bounds['width'] - 14, y, steps=12)
    expect(effort).to_have_attribute('aria-valuetext', 'Extra high')
    assert not writes, 'Dragging must preview until release'
    with page.expect_response(settings_response) as result:
        page.mouse.up()
    assert result.value.ok and len(writes) == 1
    after = current_settings()
    assert after['revision'] == initial['revision'] + 1 and after['config']['execution']['router']['effort'] == 'xhigh'
    expect(effort).to_be_focused()
    with page.expect_response(settings_response) as result:
        effort.press('ArrowLeft')
    assert result.value.ok
    expect(effort).to_have_attribute('aria-valuetext', 'High')
    page.reload(wait_until='domcontentloaded')
    expect(box).to_have_value('Unsaved message')
    direct_model.click()
    expect(effort).to_have_attribute('aria-valuetext', 'High')
    reset = model_dialog.get_by_role('button', name='Reset reasoning to model default')
    with page.expect_response(settings_response) as result:
        reset.click()
    assert result.value.ok
    expect(reset).to_be_disabled()
    expect(effort).to_have_attribute('aria-valuetext', 'Model default')
    assert 'effort' not in current_settings()['config']['execution']['router']
    page.keyboard.press('Escape')
    expect(direct_model).to_be_focused()
    assert not errors, errors
    print('PASS: live workflow, reviewed file download, current context usage, independent dismissal and mobile focus')
    browser.close()
