"""Run against a fresh examples/chat-space-browser.ts host with CHAT_CREW_WAIT=1."""
import json
import os
import time
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

root = Path(os.environ['CHAT_BROWSER_DIR'])
fixture = json.loads((root / 'fixture.json').read_text())
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    context = browser.new_context(viewport={'width': 1512, 'height': 940}, device_scale_factor=2)
    name, value = fixture['cookie'].split('=', 1)
    context.add_cookies([{'name': name, 'value': value, 'url': fixture['url']}])
    context.add_init_script("""localStorage.setItem('agenthub.configuration.language','zh-CN');
      localStorage.setItem('agenthub.configuration.theme','light');
      window.shots={};
      function sample(){
        const cap=document.querySelector('.chat-float-center [data-handoff]');
        if(cap){
          const lens=cap.querySelector('.companion-lens').getBoundingClientRect();
          const pos=actor=>{const b=actor.getBoundingClientRect();return b.x+b.width/2-lens.x-lens.width/2};
          const giver=cap.querySelector('[data-place=giver]'), taker=cap.querySelector('[data-place=taker]');
          (window.shots[cap.dataset.handoff]??=[]).push({
            g:pos(giver),r:pos(taker),opacity:+getComputedStyle(giver).opacity,
            width:cap.getBoundingClientRect().width, top:lens.top,
            file:+getComputedStyle(cap.querySelector('.companion-document')).opacity});
          window.lastTaker=taker;
        }
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);""")
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(fixture['url']+'/chat')
    cap = page.locator('.chat-float-center .chat-companion')
    solo = cap.locator('[data-place=solo]')
    chat = page.locator('.composer-input')
    panel = page.get_by_role('button', name='会话面板', exact=True)
    panel.click()
    page.get_by_role('tab',name='Agents').click()
    expect(page.locator('.session-panel .team-row')).to_have_count(3)
    expect(page.locator('.session-panel')).not_to_contain_text('上下文窗口')
    panel.click()
    def send(text):
        chat.fill(text)
        chat.press('Enter')
    send('你好')
    expect(page.locator('.assistant-body').filter(has_text='你好！')).to_be_visible(timeout=20000)
    assert page.evaluate('Object.keys(window.shots).length') == 0
    initial_width=cap.bounding_box()['width']
    center=cap.bounding_box()['x']+initial_width/2
    send('请处理摘要截断')
    expect(cap.locator('[data-place=giver]')).to_be_visible(timeout=20000)
    if os.environ.get('CAPTURE_HANDOFF'):
        frames=root/'frames'
        frames.mkdir(exist_ok=True)
        start=time.monotonic()
        for i in range(83):
            delay=start+i/20-time.monotonic()
            if delay>0:time.sleep(delay)
            page.screenshot(path=str(frames/('%03d.png'%i)),clip={'x':round(center)-155,'y':0,'width':310,'height':90},timeout=5000)
    expect(solo).to_have_attribute('data-member','developer',timeout=10000)
    assert page.evaluate("window.lastTaker===document.querySelector('.companion-actor[data-place=solo]')")
    expect(solo.locator('.roppo-character')).not_to_have_attribute('data-phase','idle',timeout=5000)
    expect(cap.locator('.companion-document')).to_have_count(0)
    expect(page.locator('.live-handoff,.handoff-replay,.crew-window')).to_have_count(0)
    shots=page.evaluate('Object.values(window.shots)[0]')
    assert max(s['width'] for s in shots)>initial_width+30
    assert max(s['top'] for s in shots)<80
    assert any(abs(s['g'])<1 and s['r']>115 and s['file']>.7 for s in shots)
    assert any(abs(s['g'])<1 and 43<s['r']<57 for s in shots)
    assert any(abs(s['g']+s['r'])<2 and 39<s['r']-s['g']<45 and s['file']>.95 for s in shots)
    assert any(s['g']<-80 and s['opacity']<.2 and abs(s['r'])<8 for s in shots)
    page.reload()
    expect(solo).to_have_attribute('data-member','developer',timeout=5000)
    assert page.evaluate('Object.keys(window.shots).length') == 0
    (root/'complete-worker').touch()
    expect(cap.locator('[data-place=giver]')).to_have_attribute('data-member','developer',timeout=20000)
    expect(solo).to_be_visible(timeout=9000)
    page.reload()
    expect(solo).to_be_visible()
    assert page.evaluate('Object.keys(window.shots).length')==0
    page.set_viewport_size({'width':390,'height':844})
    page.emulate_media(reduced_motion='reduce')
    send('请交付复核文件')
    expect(page.locator('.assistant-body').filter(has_text='review.md').first.or_(page.get_by_role('button',name='打开文件 review.md')).first).to_be_visible(timeout=20000)
    expect(solo).to_be_visible(timeout=5000)
    api=fixture['url']+'/api/chat/conversations/'+fixture['chat']+'?withPending=1'
    events=page.request.get(api).json()['handoffs']
    assert [e['kind'] for e in events]==['assignment','result','assignment','files']
    remaining=page.evaluate('window.shots')
    assert list(remaining)==[e['id'] for e in events[-2:]]
    assert all(abs(s['g'])<1 and abs(s['r'])<1 and s['file']==0 for frames in remaining.values() for s in frames)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    assert not errors,errors
    print('PASS: top capsule only; tracking, meeting, transfer and left exit; same recipient continues; original sidebar; real file delivery, history and reduced motion.')
    browser.close()
