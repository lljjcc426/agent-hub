"""Exercise the live team through the desktop Chat, using examples/chat-space-browser.ts."""
import json
import os
import time
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

root = Path(os.environ['CHAT_BROWSER_DIR'])
fixture = json.loads((root / 'fixture.json').read_text())
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    context = browser.new_context(viewport={'width': 1512, 'height': 940}, device_scale_factor=1)
    name, value = fixture['cookie'].split('=', 1)
    context.add_cookies([{'name': name, 'value': value, 'url': fixture['url']}])
    context.add_init_script("""localStorage.setItem('agenthub.configuration.language','zh-CN');
        localStorage.setItem('agenthub.configuration.theme','light');
        window.seen=[];
        new MutationObserver(()=>{
            const e=document.querySelector('.live-handoff');
            if(e && window.seen.at(-1)!==e.dataset.event) window.seen.push(e.dataset.event);
        }).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['data-event']});""")
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    api = fixture['url'] + '/api/chat/conversations/' + fixture['chat']
    def until(expression, timeout=20000):
        end = time.monotonic()+timeout/1000
        while time.monotonic()<end:
            if page.evaluate(expression):
                return
            page.wait_for_timeout(40)
        raise AssertionError(expression)
    def history():
        return page.request.get(api+'?withPending=1').json()['handoffs']
    page.goto(fixture['url']+'/chat')
    panel_button = page.get_by_role('button', name='会话面板', exact=True)
    panel_button.click()
    page.get_by_role('tab', name='Agents', exact=True).click()
    nodes = page.locator('.rp-crew-node')
    detail = page.locator('.crew-window')
    expect(nodes).to_have_count(3)
    developer = nodes.filter(has_text='开发 Worker')
    reviewer = nodes.filter(has_text='复核 Worker')
    developer.click()
    expect(detail).to_contain_text('暂无读数')
    box = page.locator('.composer-input')
    def send(text):
        box.fill(text)
        box.press('Enter')
    send('你好')
    expect(page.locator('.assistant-body').filter(has_text='你好！')).to_be_visible(timeout=20000)
    assert history() == [] and page.evaluate('window.seen') == []
    send('请处理摘要截断')
    stage = page.locator('.live-handoff')
    expect(stage).to_be_visible(timeout=20000)
    expect(stage).to_contain_text('任务单')
    stage.get_by_role('button', name='暂停', exact=True).click()
    expect(detail).to_contain_text('87,040 / 128,000 tokens', timeout=20000)
    expect(developer).to_contain_text('68%')
    expect(reviewer).to_contain_text('暂无读数')
    stage.get_by_role('button', name='重播交接').click()
    until("""()=>{
        const a=document.querySelector('.handoff-agent'),scene=a?.parentElement;
        return a && parseFloat(a.style.getPropertyValue('--position')) > scene.clientWidth*.38
    }""")
    page.screenshot(path=str(root/'agents-handoff.png'))
    if os.environ.get('CHAT_CREW_WAIT')=='1':
        assert [e['kind'] for e in history()]==['assignment']
        (root/'complete-worker').touch()
    until("window.seen.length===2",timeout=20000)
    expect(stage).to_contain_text('任务结果')
    expect(stage).to_have_count(0,timeout=12000)
    send('请交付复核文件')
    until("window.seen.length===4",timeout=30000)
    expect(stage).to_contain_text('review.md')
    reviewer.click()
    expect(detail).to_contain_text('6,400 tokens')
    expect(detail).to_contain_text('容量未上报')
    expect(detail.locator('meter')).to_have_count(0)
    expect(developer).to_contain_text('68%')
    events=history()
    assert [e['kind'] for e in events] == ['assignment','result','assignment','files'], [e['kind'] for e in events]
    assert page.evaluate('window.seen') == [e['id'] for e in events]
    assert len({e['ticketId'] for e in events})==2
    page.reload()
    expect(box).to_be_visible()
    page.wait_for_timeout(800)
    expect(stage).to_have_count(0)
    assert page.evaluate('window.seen') == []
    if not page.get_by_role('tab',name='概览').is_visible():
        panel_button.click()
    page.get_by_role('tab',name='概览').click()
    activity=page.locator('.task-activity').filter(has_text='请交付复核文件').first
    activity.locator('summary').click()
    page.emulate_media(reduced_motion='reduce')
    activity.get_by_role('button',name='回放任务交接').click()
    expect(stage).to_contain_text('复核 Worker')
    actor=stage.locator('.handoff-agent').first
    def position():
        return actor.evaluate("node=>node.style.getPropertyValue('--position')")
    start=position()
    page.wait_for_timeout(550)
    assert position()==start
    until("document.querySelector('.handoff-scene')?.dataset.received==='true'")
    stage.get_by_role('button',name='关闭交接').click()
    expect(stage).to_have_count(0)
    page.get_by_role('tab',name='Agents').click()
    developer.click()
    send('请处理第二项任务')
    expect(detail).to_contain_text('64,000 / 128,000 tokens', timeout=20000)
    tasks=detail.get_by_role('combobox',name='上下文任务')
    expect(tasks.locator('option')).to_have_count(2)
    tasks.select_option(label='请修复摘要遇到 emoji 被截断的问题，并运行回归验证。')
    expect(detail).to_contain_text('87,040 / 128,000 tokens')
    reviewer.click()
    detail.get_by_role('button',name='查看对话').click()
    expect(page.get_by_role('textbox',name='请与 Roppo 对话')).to_be_disabled()
    page.set_viewport_size({'width':390,'height':844})
    if not page.get_by_role('tab',name='Agents').is_visible():
        panel_button.click()
    page.get_by_role('tab',name='Agents').click()
    expect(nodes).to_have_count(3)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    assert not errors, errors
    print('PASS: real HTTP and SQLite, ordinary chat, ordered assignment/result/file events, two Worker windows, replay, reduced motion, mobile, no browser errors')
    browser.close()
