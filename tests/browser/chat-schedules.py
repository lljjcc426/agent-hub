"""Run against examples/chat-acceptance.ts schedule-fixture with a fresh state directory."""
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from playwright.sync_api import expect, sync_playwright

info = json.loads(Path(sys.argv[1]).read_text())
cookie_name, cookie_value = info['cookie'].split('=', 1)
with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1360, 'height': 900}, timezone_id='America/Los_Angeles', locale='en-US')
    ctx.add_cookies([{'name': cookie_name, 'value': cookie_value, 'url': info['base']}])
    ctx.add_init_script("localStorage.setItem('agenthub.configuration.language','en')")
    page = ctx.new_page()
    failures = []
    page.on('pageerror', lambda error: failures.append(str(error)))
    page.goto(info['url'])
    composer = page.locator('textarea.composer-input')
    composer.fill('Please send me a release digest every morning in Paris and attach the notes here.')
    with page.expect_response(lambda r: r.url.endswith('/messages') and r.request.method == 'POST') as sent:
        composer.press('Enter')
    assert sent.value.status == 202
    conversation = sent.value.url.rsplit('/', 1)[0]
    page.goto(info['url'] + '#schedules')
    card = page.locator('article[data-schedule-id="release-digest"]')
    expect(card).to_contain_text('Europe/Paris', timeout=35000)
    expect(card).to_contain_text('No delivery yet')
    def plan():
        return ctx.request.get(conversation).json()['schedules'][0]
    def edit(tab):
        tab.get_by_role('button', name='Release digest', exact=True).click()
        dialog = tab.get_by_role('dialog', name='Release digest')
        expect(dialog).to_be_visible()
        return dialog
    def save(dialog):
        dialog.get_by_role('button', name='Save schedule').click()
        expect(dialog).not_to_be_visible()
    def toggle(label):
        card.get_by_role('button', name=label+' Release digest').click()

    toggle('Pause')
    expect(card).to_contain_text('Paused')
    dialog = edit(page)
    expect(dialog.get_by_text('Deliver the release digest file and report in Chat.')).to_be_visible()
    dialog.get_by_role('combobox', name='Frequency', exact=True).select_option('workdays')
    dialog.get_by_label('Local time', exact=True).fill('08:35')
    save(dialog)
    assert plan()['timing']['weekdays'] == [1, 2, 3, 4, 5] and not plan()['active']
    toggle('Resume')
    expect(card.get_by_role('button', name='Pause Release digest')).to_be_visible()
    first = plan()
    paris = datetime.fromtimestamp(first['nextAt']/1000, ZoneInfo('Europe/Paris'))
    assert paris.weekday() < 5 and paris.strftime('%H:%M') == '08:35'

    # Keep an edited form open while a second tab saves a different frequency.
    other = ctx.new_page()
    other.goto(info['url']+'#schedules')
    dialog = edit(page)
    dialog.get_by_label('Local time', exact=True).fill('17:00')
    second = edit(other)
    second.get_by_role('combobox', name='Frequency', exact=True).select_option('weekend')
    save(second)
    expect(dialog.get_by_role('button', name='Reload schedule')).to_be_visible(timeout=14000)
    dialog.get_by_role('button', name='Reload schedule').click()
    expect(dialog.get_by_role('combobox', name='Frequency', exact=True)).to_have_value('weekend')
    dialog.get_by_role('combobox', name='Frequency', exact=True).select_option('weekly')
    dialog.get_by_role('button', name='Sat', exact=True).click()
    dialog.get_by_role('button', name='Sun', exact=True).click()
    expect(dialog.get_by_role('button', name='Save schedule')).to_be_disabled()
    for day in ['Mon', 'Thu']:
        dialog.get_by_role('button', name=day, exact=True).click()
    save(dialog)
    assert plan()['timing']['weekdays'] == [1,4]
    other.close()

    dialog = edit(page)
    dialog.get_by_role('combobox', name='Frequency', exact=True).select_option('interval')
    dialog.get_by_role('combobox', name='Unit', exact=True).select_option('1')
    dialog.get_by_label('Repeat every').fill('59')
    expect(dialog.get_by_role('button', name='Save schedule')).to_be_disabled()
    dialog.get_by_label('Repeat every').fill('91')
    save(dialog)
    assert plan()['timing']['intervalSeconds'] == 91
    dialog = edit(page)
    dialog.get_by_role('combobox', name='Frequency', exact=True).select_option('once')
    dialog.get_by_role('combobox', name='Time zone', exact=True).fill('Europe/Paris')
    when = datetime.now(ZoneInfo('Europe/Paris')).replace(microsecond=0) + timedelta(seconds=8)
    dialog.get_by_label('Run at').fill(when.strftime('%Y-%m-%dT%H:%M:%S'))
    save(dialog)
    assert plan()['nextAt'] == int(when.timestamp()*1000)
    receipt = card.get_by_role('button', name='The scheduled release digest is ready.')
    expect(receipt).to_be_visible(timeout=45000)
    file = card.get_by_role('button', name='release-digest.md', exact=True)
    expect(file).to_be_visible()
    record = plan()
    dialog = edit(page)
    expect(dialog).to_contain_text('Completed', timeout=12000)
    dialog.get_by_role('button', name='release-digest.md', exact=True).click()
    viewer = page.get_by_role('dialog', name='release-digest.md')
    expect(viewer.get_by_role('heading', name='Release digest', exact=True)).to_be_visible()
    with page.expect_download() as downloaded:
        viewer.get_by_role('link', name='Download').click()
    assert downloaded.value.path().read_text() == '# Release digest\n\nThe scheduled delivery ran.'
    page.keyboard.press('Escape')
    expect(viewer).not_to_be_visible()
    receipt.click()
    target = page.locator('[data-message-id="'+record['lastResult']['messageId']+'"]')
    expect(target).to_be_in_viewport()
    expect(target).to_contain_text('The scheduled release digest is ready.')
    assert record['lastResult']['messageId'] != sent.value.json().get('messageId')

    # A one-shot occurrence stays delivered after a reload. The modal must fit the mobile viewport.
    page.set_viewport_size({'width': 360,'height': 740})
    page.reload()
    dialog = edit(page)
    bounds = dialog.bounding_box()
    assert 0 <= bounds['x'] <= 22 and bounds['x']+bounds['width'] <= 360
    dialog.get_by_role('button', name='The scheduled release digest is ready.').click()
    expect(page.locator('#session-panel')).not_to_be_visible()
    expect(target).to_be_in_viewport()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert not failures, failures
    browser.close()
    print('PASS – pause, resume, weekdays, weekends, custom days, interval, stale draft, timed message and downloadable file, mobile.')
