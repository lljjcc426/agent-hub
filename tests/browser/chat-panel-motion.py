"""Exercise the two right-hand panels in a fresh workflow fixture."""

import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def assert_greeting(page):
    page.wait_for_function("""() => {
        const portrait = document.querySelector('.team-portrait');
        const lift = getComputedStyle(portrait.querySelector('.roppo-pose')).transform;
        const hand = portrait.querySelector('.roppo-greeting-hand');
        const bounds = hand.getBoundingClientRect();
        const smilingEyes = getComputedStyle(portrait.querySelector('.roppo-eyes-happy')).opacity;
        return new DOMMatrix(lift).m42 < -2 && Number(smilingEyes) > .9
            && Number(getComputedStyle(hand).opacity) > .9 && Math.abs(bounds.width - bounds.height) < .05
            && hand.getAnimations().some(animation => animation.effect.getTiming().duration >= 1100);
    }""", timeout=1800)


def assert_dock_slide(page, trigger, opening):
    motion = page.evaluate("""async trigger => {
        const body = document.querySelector('.conversation-body');
        const transcript = document.querySelector('.transcript-inner');
        const composer = document.querySelector('.composer');
        const center = el => {
            const bounds = el.getBoundingClientRect();
            return bounds.left + bounds.width / 2;
        };
        const position = () => [center(transcript), center(composer), body.scrollLeft];
        const frames = [position()];
        const button = document.querySelector(trigger);
        button.focus({preventScroll: true});
        button.click();
        let duration;
        const deadline = performance.now() + 340;
        do {
            await new Promise(requestAnimationFrame);
            const panel = document.querySelector('#session-panel');
            const slide = panel?.getAnimations().find(animation => animation.transitionProperty === 'margin-right');
            duration ??= slide?.effect.getTiming().duration;
            frames.push(position());
        } while (performance.now() < deadline);
        return {frames, duration};
    }""", trigger)
    frames = motion['frames']
    assert all(abs(chat - composer) < 1 and scroll == 0 for chat, composer, scroll in frames), frames
    first, last = frames[0][0], frames[-1][0]
    assert (first - last if opening else last - first) > 100, motion
    left, right = sorted((first, last))
    assert any(left + 12 < chat < right - 12 for chat, _, _ in frames), motion
    if not opening:
        assert motion['duration'] <= 180, motion


def assert_surfaces(page):
    colors = page.evaluate("""() => ['.conversation-body', '.thread', '#session-panel']
        .map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor)""")
    assert len(set(colors)) == 1, colors


root = Path(sys.argv[1])
info = json.loads((root / 'browser.json').read_text())
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    context = browser.new_context(viewport={'width': 1280, 'height': 820}, reduced_motion='no-preference')
    name, value = info['cookie'].split('=', 1)
    context.add_cookies([{'name': name, 'value': value, 'url': info['base']}])
    context.add_init_script("""
        localStorage.setItem('agenthub.configuration.language', 'zh-CN');
        window.exits = [];
        document.addEventListener('transitionrun', event => {
            const el = event.target;
            if (el.id === 'session-panel' && el.hasAttribute('data-closing') && ['transform', 'margin-right'].includes(event.propertyName))
                exits.push([el.classList.contains('team-drawer') ? 'overview' : 'resources', el.inert]);
        });
        document.addEventListener('animationstart', event => {
            const el = event.target;
            const host = el.closest('.tray-presence[data-closing]');
            if (el.id === 'pending-tray' && host) {
                const animation = el.getAnimations().find(animation => animation.animationName === event.animationName);
                exits.push([event.animationName, host.inert, animation?.effect.getTiming().duration]);
            }
        });
    """)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(info['url'])
    composer = page.locator('.composer-input')
    composer.fill('Keep going')
    expect(page.get_by_role('button', name='发送消息', exact=True)).to_be_enabled()
    composer.press('Enter')
    expect(page.locator('.transcript')).to_contain_text('Still here.')

    drawer = page.locator('#session-panel')
    drawer_toggle = page.get_by_role('button', name='会话面板', exact=True)
    portrait = drawer.get_by_role('button', name='和 Roppo 打招呼')
    close_drawer = drawer.get_by_role('button', name='收起面板')
    mascot = portrait.locator('.roppo-character')
    assert_dock_slide(page, 'button[aria-controls="session-panel"]', opening=True)
    expect(drawer).to_be_visible()
    assert_greeting(page)
    expect(portrait).to_have_css('background-color', 'rgba(0, 0, 0, 0)')
    expect(portrait).to_have_css('border-top-width', '0px')
    expect(mascot.locator('.roppo-greeting-smile')).to_have_count(0)
    expect(mascot.locator('.roppo-greeting-hand')).to_have_css('border-radius', '50%')
    expect(mascot).not_to_have_attribute('data-greeting', 'true')
    edit = drawer.get_by_role('link', name='编辑资料')
    expect(edit).to_have_attribute('href', '/configure#execution/configuration/router')
    bounds = [el.bounding_box() for el in (drawer, portrait, drawer.locator('.team-profile>strong'), edit)]
    centers = [rect['x'] + rect['width'] / 2 for rect in bounds]
    assert max(centers) - min(centers) <= 1, bounds
    assert bounds[1]['y'] + bounds[1]['height'] < bounds[2]['y'] < bounds[3]['y'], bounds
    assert_surfaces(page)

    portrait.press('Enter')
    assert_greeting(page)
    expect(portrait).to_have_css('box-shadow', 'none')
    portrait.click()
    assert_greeting(page)
    page.screenshot(path=str(root / 'roppo-greeting.png'))
    expect(mascot).not_to_have_attribute('data-greeting', 'true')
    assert_dock_slide(page, '#session-panel .team-drawer-head > .icon-button', opening=False)
    expect(drawer).to_have_count(0)
    expect(drawer_toggle).to_be_focused()
    assert ['overview', True] in page.evaluate('exits')

    drawer_toggle.click()
    assert_greeting(page)
    assert page.evaluate("""async () => {
        const panel = document.querySelector('#session-panel');
        panel.querySelector('.team-drawer-head > .icon-button').click();
        await new Promise(resolve => setTimeout(resolve, 55));
        const stillExiting = panel.hasAttribute('data-closing') && panel.inert;
        document.querySelector('button[aria-controls="session-panel"]').click();
        return stillExiting;
    }""")
    assert_greeting(page)
    expect(mascot).not_to_have_attribute('data-greeting', 'true')
    expect(drawer_toggle).to_have_attribute('aria-expanded', 'true')
    expect(drawer).to_be_visible()
    drawer.get_by_role('button', name='文件', exact=True).click()
    expect(drawer).to_have_class('session-panel resource-workspace')
    assert_surfaces(page)
    close_drawer.click()
    expect(drawer).to_have_count(0)
    assert ['resources', True] in page.evaluate('exits')

    pending_toggle = page.locator('.pending-trigger')
    pending = page.locator('#pending-tray')
    pending_toggle.click()
    expect(pending).to_be_visible()
    page.keyboard.press('Escape')
    expect(pending).to_have_count(0)
    expect(pending_toggle).to_be_focused()
    assert ['tray-leave', True, 170] in page.evaluate('exits')

    page.set_viewport_size({'width': 390, 'height': 780})
    lane = page.locator('.conversation-lane')
    expect(page.locator('.conversation-body')).to_have_class('conversation-body panel-overlay')
    narrow_width = lane.bounding_box()['width']
    page.evaluate("""window.dispatchEvent(new StorageEvent('storage', {
        key:'agenthub.configuration.theme', newValue:'dark'
    }))""")
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    page.locator('.chat-companion').click()
    assert_greeting(page)
    assert lane.bounding_box()['width'] == narrow_width
    assert_surfaces(page)
    expect(portrait).to_have_css('background-color', 'rgba(0, 0, 0, 0)')
    close_drawer.click()
    expect(drawer).to_have_count(0)
    pending_toggle.click()
    expect(pending).to_be_visible()
    page.keyboard.press('Escape')
    expect(pending).to_have_count(0)
    assert ['tray-sheet-out', True, 170] in page.evaluate('exits')

    page.emulate_media(reduced_motion='reduce')
    page.evaluate('exits.length = 0')
    page.set_viewport_size({'width': 1280, 'height': 820})
    expect(page.locator('.conversation-body')).to_have_class('conversation-body')
    page.locator('.chat-companion').click()
    portrait.click()
    assert drawer.evaluate('el => el.getAnimations().length') == 0
    expect(mascot).not_to_have_attribute('data-greeting', 'true')
    assert mascot.evaluate('el => el.getAnimations({subtree:true}).length') == 0
    close_drawer.click()
    expect(drawer).to_have_count(0)
    pending_toggle.click()
    page.keyboard.press('Escape')
    expect(pending).to_have_count(0)
    assert page.evaluate('exits') == []
    assert not errors, errors
    print('PASS right-panel exits, rapid reopen, focus, mascot gesture, matching surfaces and reduced motion')
    browser.close()
