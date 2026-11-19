"""Use a fresh, isolated examples/chat-acceptance.ts workflow host."""
import json
import sqlite3
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import expect, sync_playwright

root = Path(sys.argv[1])
info = json.loads((root / 'browser.json').read_text())
approval_count = 101
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    context = browser.new_context(viewport={'width': 1280, 'height': 820}, reduced_motion='no-preference')
    name, value = info['cookie'].split('=', 1)
    context.add_cookies([{'name': name, 'value': value, 'url': info['base']}])
    context.add_init_script("""localStorage.setItem('agenthub.configuration.language','zh-CN');
      window.previewMotion=[]; document.addEventListener('animationstart', e => {
        window.previewMotion.push(e.animationName);
        if (e.animationName === 'tray-sheet-in') document.documentElement.dataset.sheetEntered='true';
      });""")
    page = context.new_page()
    pages, errors = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda req: pages.append(parse_qs(urlparse(req.url).query)) if '/approval-history' in req.url else None)
    page.goto(info['url'])
    box = page.locator('.composer-input')
    box.fill('Keep going')
    box.press('Enter')
    expect(page.locator('.transcript')).to_contain_text('Still here.', timeout=25000)
    with sqlite3.connect(root / 'state' / 'state.sqlite') as db:
        created, conversation, run = db.execute("""select json_extract(body,'$.createdAt'),json_extract(body,'$.conversationId'),json_extract(body,'$.runId')
            from records where kind='chat-message' order by rowid desc limit 1""").fetchone()
        for n in range(approval_count):
            item = 'permission:' + format(n, '064x')
            action = {'id': item, 'actor': {'conversationId':conversation,'runId':run,'triggerId':run,'workerId':'router','mode':'ask'},
                      'tool':'superagent_shell','phase':'complete','approved':True,'automatic':False,'createdAt':created,
                      'args':{},'facts':{'command':f'printf history-detail-{n:02d}'},'notice':f'清理测试目录 {n:02d} 需要你的审批。'}
            db.execute('insert into records values(?,?,?)', ('chat-permission', item, json.dumps(action)))
    page.reload()
    transcript = page.locator('.transcript')
    origin = transcript.get_by_text('清理测试目录 00 需要你的审批。').get_by_role('link', name='审批')
    expect(origin).to_be_visible()
    assert not pages, pages
    expect(origin).to_have_css('text-decoration-line','underline')
    assert origin.evaluate("(el)=>getComputedStyle(el).color===getComputedStyle(el.parentElement).color")
    origin.click()
    tray = page.locator('#pending-tray')
    expect(tray.get_by_role('heading',name='审批记录')).to_be_visible()
    expect(tray.locator('.permission-result')).to_have_text('已批准 · 执行成功')
    assert len(pages)==1 and 'item' in pages[0]
    tray.get_by_text('查看命令').click()
    expect(tray.locator('pre')).to_contain_text('history-detail-00')
    expect(tray.get_by_role('button',name='允许一次')).to_have_count(0)
    tray.get_by_role('button',name='返回审批记录').click()
    rows=tray.locator('.history-row')
    for visible_count in range(20, approval_count, 20):
        expect(rows).to_have_count(visible_count)
        tray.get_by_role('button',name='加载更早的记录').click()
    expect(rows).to_have_count(approval_count)
    expect(tray.get_by_role('button',name='加载更早的记录')).to_have_count(0)
    rows.last.click()
    expect(tray.locator('.permission-reason')).to_contain_text('目录 00')
    tray.get_by_role('button',name='返回审批记录').click()
    expect(rows).to_have_count(approval_count)
    page.keyboard.press('Escape')
    expect(tray).to_have_count(0)
    expect(origin).to_be_focused()
    assert 'pending-tray-in' in page.evaluate('window.previewMotion')
    assert 'tray-leave' in page.evaluate('window.previewMotion')
    page.set_viewport_size({'width':390,'height':700})
    page.emulate_media(reduced_motion='reduce')
    origin.click()
    expect(tray).to_have_css('animation-name','none')
    expect(tray.locator('.permission-result')).to_be_visible()
    assert tray.evaluate("e=>e.getBoundingClientRect().bottom<=innerHeight && Math.abs(e.getBoundingClientRect().width-innerWidth)<2")
    page.keyboard.press('Escape')
    expect(tray).to_have_count(0)
    page.emulate_media(reduced_motion='no-preference')
    origin.click()
    expect(tray.locator('.permission-result')).to_be_visible()
    expect(tray).to_have_css('animation-name','tray-sheet-in')
    expect(page.locator('html')).to_have_attribute('data-sheet-entered', 'true')
    page.locator('.pending-backdrop').click(position={'x':4,'y':100})
    expect(tray).to_have_count(0)
    assert 'tray-sheet-in' in page.evaluate('window.previewMotion')
    assert 'tray-sheet-out' in page.evaluate('window.previewMotion')
    assert not errors,errors
    print('PASS oldest link with 101 approvals, read-only details, 20-record pages, focus restoration, desktop motion and reduced-motion mobile sheet')
    browser.close()
