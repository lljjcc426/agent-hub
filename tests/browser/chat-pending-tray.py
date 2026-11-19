"""Run against a fresh examples/chat-acceptance.ts workflow host."""
import json
import sys
from urllib.parse import unquote
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

info = json.loads(Path(sys.argv[1]).read_text())
out = Path(sys.argv[1]).parent
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
    name, value = info['cookie'].split('=', 1)
    ctx.add_cookies([{'name': name, 'value': value, 'url': info['base']}])
    ctx.add_init_script("localStorage.setItem('agenthub.configuration.language','en')")
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(info['url'], wait_until='domcontentloaded')
    expect(page.locator('.chat-header, .studio-rail, .studio-brandbar')).to_have_count(0)
    controls = page.locator('.chat-float')
    expect(controls).to_have_count(3)
    for width in (320, 390, 800, 1440):
        page.set_viewport_size({'width': width, 'height': 960})
        regions = [el.bounding_box() for el in controls.all()]
        left, center, right = regions
        assert 0 <= left['x'] and left['x'] + left['width'] < center['x']
        character = page.locator('.chat-companion .roppo-character').bounding_box()
        status = page.locator('.companion-label').bounding_box()
        assert status['y'] >= character['y'] + character['height']
        for box in (center, character, status):
            assert abs(box['x'] + box['width'] / 2 - width / 2) < 1
        assert center['x'] + center['width'] < right['x'] and right['x'] + right['width'] <= width
    trigger = page.locator('.pending-trigger')
    tray = page.get_by_role('complementary', name='Pending requests')
    trigger.click()
    expect(tray.get_by_role('status')).to_have_text('You’re all caught up.')
    empty_height = tray.bounding_box()['height']
    box = page.locator('.composer-input')

    def send(text):
        box.fill(text)
        box.press('Enter')

    panel_button=page.get_by_role('button',name='Session panel',exact=True)
    panel=page.get_by_role('complementary',name='Session panel')
    send('Keep going')
    expect(page.locator('.transcript').get_by_text('Still here.',exact=True)).to_be_visible(timeout=20000)
    panel_button.click()
    expect(panel.get_by_text('No tasks yet', exact=True)).to_be_visible()
    panel_button.click()
    send('Prepare the guide.')
    choice = tray.get_by_role('group', name='Which language?')
    expect(choice).to_be_visible(timeout=20000)
    one_height = tray.bounding_box()['height']
    send('Let me review the release notes before delivery.')
    file = tray.locator('.rp-approval').filter(has_text='release-notes.md')
    expect(file).to_be_visible(timeout=20000)
    assert empty_height < one_height < tray.bounding_box()['height']
    expect(trigger).to_have_accessible_name('Pending requests · 2')
    transcript = page.locator('.transcript')
    expect(transcript.locator('.rp-decision, .rp-approval')).to_have_count(0)
    answer_link = transcript.get_by_role('link', name='answer', exact=True)
    review_link = transcript.get_by_role('link', name='approval', exact=True)
    expect(answer_link.locator('..')).to_have_text('Before I draft the guide, please answer the language question.')
    expect(review_link.locator('..')).to_have_text('Sending the release notes needs your approval.')
    expect(answer_link).to_have_css('text-decoration-line', 'underline')
    expect(answer_link).to_have_css('color', 'rgb(21, 93, 193)')
    expect(review_link).to_have_css('text-decoration-line','underline')
    assert review_link.evaluate('(e)=>getComputedStyle(e).color===getComputedStyle(e.parentElement).color')
    for link, card in [(answer_link, choice), (review_link, file)]:
        link.click()
        target = card.locator('xpath=ancestor::li[1]')
        expect(target).to_be_focused()
        expect(target).to_have_attribute('data-pending-id', unquote(page.url.split('/pending/')[-1]))
    review_url = page.url
    page.reload()
    expect(file.locator('xpath=ancestor::li[1]')).to_be_focused()
    page.screenshot(path=str(out / 'pending-desktop.png'))
    composer_left=page.locator('.composer').bounding_box()['x']
    panel_button.click()
    panel=page.get_by_role('complementary',name='Session panel')
    expect(panel).to_be_visible()
    expect(tray).to_be_visible()
    def center(el):
        bounds=el.bounding_box()
        return bounds['x']+bounds['width']/2
    lane=page.locator('.conversation-lane')
    sidebar=panel.bounding_box()
    assert page.locator('.composer').bounding_box()['x'] < composer_left
    for el in [page.locator('.composer'),page.locator('.transcript-inner'),page.locator('.chat-companion')]:
        assert abs(center(el)-center(lane)) < 1
    assert abs(lane.bounding_box()['width'] - sidebar['x']) < 1
    assert sidebar['y'] <= 16 and 0 < 960-sidebar['y']-sidebar['height'] <= 16
    expect(panel.locator('.task-activity')).to_have_count(1)
    activity=panel.locator('.task-activity')
    activity_id=activity.get_attribute('data-activity-id')
    activity.click()
    details = panel.get_by_role('region', name='Task details')
    expect(details.get_by_role('tabpanel', name='Progress')).to_contain_text('Choose language')
    page.screenshot(path=str(out/'session-panel-split.png'))
    first_message=transcript.locator('.message').first.bounding_box()
    mascot=page.locator('.chat-companion').bounding_box()
    assert first_message['y'] + transcript.evaluate('el => el.scrollTop') >= mascot['y'] + mascot['height']
    assert tray.bounding_box()['x']+tray.bounding_box()['width']<=panel.bounding_box()['x']+1
    panel_button.click()
    tray.get_by_role('button', name='Hide pending requests').click()
    expect(trigger).to_be_focused()
    page.reload()
    expect(trigger).to_have_accessible_name('Pending requests · 2')
    expect(tray).to_have_count(0)
    trigger.click()
    page.reload()
    expect(file).to_be_visible()
    expect(choice).to_be_visible()
    panel_button.click()
    choice.locator('strong',has_text='Which language?').first.click()
    expect(panel).to_be_visible()
    expect(tray).to_have_count(0)
    marked=page.locator('.transcript [data-located]')
    expect(marked).to_have_count(1)
    expect(marked).to_contain_text('answer the language question')
    expect(marked).to_be_focused()
    panel_button.click()
    expect(marked).to_have_count(0,timeout=5000)
    trigger.click()
    page.set_viewport_size({'width':390,'height':430})
    expect(tray).to_be_visible()
    assert tray.evaluate('(el)=>el.getBoundingClientRect().right<=innerWidth && el.getBoundingClientRect().bottom<=innerHeight')
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.screenshot(path=str(out / 'pending-mobile.png'))
    page.set_viewport_size({'width':1440,'height':960})
    other=ctx.new_page()
    other.goto(info['url'],wait_until='domcontentloaded')
    other_tray=other.locator('#pending-tray')
    other_file=other_tray.locator('.rp-approval').filter(has_text='release-notes.md')
    other_file.get_by_text('Read draft',exact=True).click()
    expect(other_file.locator('pre')).to_contain_text('Layout verified')
    source = other_file.locator('pre').text_content().encode()
    other_file.get_by_role('button',name='Deliver file',exact=True).click()
    expect(file).to_have_count(0)
    expect(trigger).to_have_accessible_name('Pending requests · 1')
    expect(page.locator('.transcript').get_by_text('release-notes.md',exact=True).first).to_be_visible()
    tile = other.locator('.transcript').get_by_role('button', name='Open file release-notes.md')
    tile.click()
    viewer = other.get_by_role('dialog', name='release-notes.md')
    expect(viewer.get_by_role('heading', name='Release notes', exact=True)).to_be_visible()
    with other.expect_download() as downloaded:
        viewer.get_by_role('link', name='Download').click()
    assert downloaded.value.path().read_bytes() == source
    other.keyboard.press('Escape')
    expect(tile).to_be_focused()
    other.goto(review_url)
    expect(other_tray.get_by_role('heading',name='Approval history')).to_be_visible()
    expect(other_tray.locator('[data-record-id]')).to_contain_text('release-notes.md')
    expect(other_tray.get_by_role('button',name='Deliver file')).to_have_count(0)
    other.close()
    choice.get_by_role('button',name='English',exact=False).click()
    approval=tray.locator('.permission-review').filter(has_text='Inspect the working directory')
    expect(approval).to_be_visible(timeout=20000)
    member=page.get_by_role('button',name='@Research',exact=True).first
    member.click()
    expect(page.locator('.worker-readonly textarea')).to_be_disabled()
    panel_button.click()
    expect(activity).to_have_count(1)
    expect(activity).to_have_attribute('data-activity-id',activity_id)
    panel_button.click()
    expect(approval).to_be_visible()
    approval.locator('xpath=ancestor::li[1]').get_by_role('button',name='Go to original message').click()
    expect(tray).to_have_count(0)
    expect(page.locator('.transcript [data-workflow-id][data-located]')).to_contain_text('Inspect the working directory')
    trigger.click()
    approval.get_by_role('button',name='Allow once').click()
    expect(tray).to_have_count(0)
    trigger.click()
    native=tray.get_by_role('group',name='Which layout?')
    expect(native).to_be_visible(timeout=20000)
    native.get_by_role('button',name='Table',exact=False).click()
    expect(tray.get_by_role('status')).to_have_text('You’re all caught up.')
    page.locator('.worker-readonly button').click()
    expect(transcript.locator('.pending-notice').filter(has_text='Which language?')).to_contain_text('English')
    expect(page.locator('.transcript').get_by_text('Verified layout: Table',exact=True).first).to_be_visible(timeout=20000)
    page.keyboard.press('Escape')
    expect(tray).to_have_count(0)
    expect(trigger).to_be_focused()
    panel_button.click()
    expect(activity).to_have_count(1)
    expect(activity).to_have_attribute('data-activity-id', activity_id)
    activity.click()
    expect(details.get_by_role('tabpanel', name='Progress')).to_contain_text('Verify the layout')
    details.get_by_role('button',name='Back to task list').click()
    expect(activity).to_be_focused()
    panel_button.click()
    for i in range(1, 7):
        send(f'Choose a language for draft {i}.')
        expect(trigger).to_have_accessible_name(f'Pending requests · {i}',timeout=15000)
    page.set_viewport_size({'width':390,'height':620})
    trigger.click()
    scroll=tray.locator('.pending-list')
    expect(scroll.locator('li')).to_have_count(6)
    assert scroll.evaluate('(el)=>el.scrollHeight>el.clientHeight')
    scroll.locator('li').last.scroll_into_view_if_needed()
    assert scroll.evaluate('(el)=>el.scrollTop>0')
    assert not errors, errors
    print('Passed desktop, mobile, reload, two-tab synchronization, file review, Router choice and native approval/question.')
    browser.close()
