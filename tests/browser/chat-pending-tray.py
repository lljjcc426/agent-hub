"""Run against a fresh examples/chat-acceptance.ts workflow host."""
import json
import sys
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
    page.goto(info['url'], wait_until='networkidle')
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

    send('Prepare the guide.')
    choice = tray.get_by_role('group', name='Which language?')
    expect(choice).to_be_visible(timeout=20000)
    one_height = tray.bounding_box()['height']
    send('Let me review the release notes before delivery.')
    file = tray.locator('.rp-approval').filter(has_text='release-notes.md')
    expect(file).to_be_visible(timeout=20000)
    assert empty_height < one_height < tray.bounding_box()['height']
    expect(trigger).to_have_accessible_name('Pending requests · 2')
    page.screenshot(path=str(out / 'pending-desktop.png'))
    panel_button=page.get_by_role('button',name='Session panel',exact=True)
    composer_left=page.locator('.composer').bounding_box()['x']
    panel_button.click()
    panel=page.get_by_role('complementary',name='Session panel')
    expect(panel).to_be_visible()
    expect(tray).to_be_visible()
    assert abs(page.locator('.composer').bounding_box()['x'] - composer_left) < 1
    assert panel.bounding_box()['y'] > panel_button.bounding_box()['y'] + panel_button.bounding_box()['height']
    transcript=page.locator('.transcript').bounding_box()
    mascot=page.locator('.chat-companion').bounding_box()
    assert transcript['y'] >= mascot['y'] + mascot['height']
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
    choice.locator('strong',has_text='Which language?').first.click()
    expect(tray).to_have_count(0)
    marked=page.locator('.transcript [data-located]')
    expect(marked).to_have_count(1)
    expect(marked).to_contain_text('Which language?')
    expect(marked).to_be_focused()
    expect(marked).to_have_count(0,timeout=5000)
    trigger.click()
    page.set_viewport_size({'width':390,'height':430})
    expect(tray).to_be_visible()
    assert tray.evaluate('(el)=>el.getBoundingClientRect().right<=innerWidth && el.getBoundingClientRect().bottom<=innerHeight')
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.screenshot(path=str(out / 'pending-mobile.png'))
    page.set_viewport_size({'width':1440,'height':960})
    other=ctx.new_page()
    other.goto(info['url'],wait_until='networkidle')
    other_tray=other.locator('#pending-tray')
    other_file=other_tray.locator('.rp-approval').filter(has_text='release-notes.md')
    other_file.get_by_text('Read draft',exact=True).click()
    expect(other_file.locator('pre')).to_contain_text('Layout verified')
    other_file.get_by_role('button',name='Deliver file',exact=True).click()
    expect(file).to_have_count(0)
    expect(trigger).to_have_accessible_name('Pending requests · 1')
    expect(page.locator('.transcript').get_by_text('release-notes.md',exact=True).first).to_be_visible()
    other.close()
    choice.get_by_role('button',name='English',exact=False).click()
    approval=tray.locator('.rp-approval').filter(has_text='Inspect the working directory')
    expect(approval).to_be_visible(timeout=20000)
    member=page.get_by_role('button',name='@Research',exact=True).first
    member.click()
    expect(page.locator('.worker-readonly textarea')).to_be_disabled()
    expect(approval).to_be_visible()
    approval.locator('xpath=ancestor::li[1]').get_by_role('button',name='Go to original message').click()
    expect(tray).to_have_count(0)
    expect(page.locator('.transcript [data-workflow-id][data-located]')).to_contain_text('Inspect the working directory')
    trigger.click()
    approval.get_by_role('button',name='Allow once').click()
    native=tray.get_by_role('group',name='Which layout?')
    expect(native).to_be_visible(timeout=20000)
    native.get_by_role('button',name='Table',exact=False).click()
    expect(tray.get_by_role('status')).to_have_text('You’re all caught up.')
    page.locator('.worker-readonly button').click()
    expect(page.locator('.transcript').get_by_role('group',name='Which language?').get_by_role('status')).to_have_text('English')
    expect(page.locator('.transcript').get_by_text('Verified layout: Table',exact=True).first).to_be_visible(timeout=20000)
    page.keyboard.press('Escape')
    expect(tray).to_have_count(0)
    expect(trigger).to_be_focused()
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
