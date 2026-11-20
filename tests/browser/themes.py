"""React appearance acceptance on a fresh studio-preview host; build:chat first."""
import json
import os
import re
import socket
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

output = Path('.local/theme-browser-evidence'); output.mkdir(parents=True, exist_ok=True)
checks = []; errors = []; writes = []; screenshots = []
with tempfile.TemporaryDirectory(prefix='agenthub-themes-') as root:
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    server=subprocess.Popen(['node','--import','tsx','examples/studio-preview.ts',root],env={**os.environ,'ROPPO_PREVIEW_PORT':str(port)},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        ready=server.stdout.readline().strip()
        assert ready.startswith('Workspace preview ready on '), ready
        entry=(Path(root)/'url.txt').read_text().strip()
        url=urlsplit(entry);base=url.scheme+'://'+url.netloc
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True)
            context=browser.new_context(viewport={'width':1440,'height':1000},color_scheme='dark')
            context.add_init_script("if(!localStorage.getItem('agenthub.configuration.language'))localStorage.setItem('agenthub.configuration.language','zh-CN')")
            context.on('request',lambda r:writes.append(r.url) if r.method=='POST' and urlsplit(r.url).path.endswith('/settings') else None)
            page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(entry,wait_until='networkidle')
            def navigate(route='appearance'):
                page.goto(base+'/configure#'+route,wait_until='networkidle')
                expect(page.locator('.chat-shell')).to_be_visible()
            def capture(name):
                page.locator('.appearance-settings h1').scroll_into_view_if_needed()
                assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'),name
                page.screenshot(path=str(output/(name+'.png')),animations='disabled')
                screenshots.append(name)
            navigate('general')
            page.locator('.studio-settings-links').get_by_role('link',name='外观',exact=True).click()
            expect(page.locator('.appearance-settings h1')).to_have_text('外观')
            expect(page.locator('html')).to_have_attribute('data-theme','light')
            expect(page.locator('body')).to_have_css('background-color','rgb(255, 255, 255)')
            capture('appearance-zh-light')
            checks.append('Settings navigation opens the React appearance page; initial mode stays light on a dark OS')
            dark=page.get_by_role('radio',name='深色',exact=True)
            dark.focus();page.keyboard.press('Space')
            expect(dark).to_be_checked();expect(dark).to_be_focused()
            expect(page.locator('html')).to_have_attribute('data-theme','dark')
            page.get_by_role('radio',name='跟随系统',exact=True).check()
            page.emulate_media(color_scheme='light')
            expect(page.locator('html')).to_have_attribute('data-theme','light')
            page.emulate_media(color_scheme='dark')
            expect(page.locator('html')).to_have_attribute('data-theme','dark')
            dark.check()
            checks.append('Keyboard selection and system color-scheme changes use the new mode controls')
            profile=page.locator('.appearance-profile[data-profile="dark"]')
            profile.get_by_role('button',name='深色主题',exact=True).click()
            page.get_by_role('menuitem',name=re.compile('主题预设')).click()
            page.get_by_role('menuitemradio',name=re.compile('GitHub')).click()
            page.locator('.appearance-settings h1').click()
            expect(profile.get_by_role('button',name='深色主题',exact=True)).to_contain_text('GitHub')
            expect(page.get_by_test_id('hex-dark-background')).to_have_value('#0D1117')
            expect(page.locator('body')).to_have_css('background-color','rgb(13, 17, 23)')
            page.get_by_test_id('hex-dark-background').fill('#182332')
            page.get_by_test_id('hex-dark-foreground').fill('#F1F5F9')
            profile.get_by_role('button',name='深色主题强调色',exact=True).click()
            page.get_by_role('menuitemradio',name=re.compile('自定义')).click()
            page.get_by_test_id('hex-dark-accent').fill('#8BA8FF')
            expect(page.locator('body')).to_have_css('background-color','rgb(24, 35, 50)')
            capture('appearance-zh-custom-dark')
            checks.append('Preset selection and custom background, foreground and accent HEX fields update the real page')
            page.reload();page.wait_for_load_state('networkidle')
            expect(page.locator('html')).to_have_attribute('data-theme','dark')
            expect(page.get_by_test_id('hex-dark-background')).to_have_value('#182332')
            expect(page.get_by_test_id('hex-dark-foreground')).to_have_value('#F1F5F9')
            expect(page.get_by_test_id('hex-dark-accent')).to_have_value('#8BA8FF')
            checks.append('Mode and all three custom colors survive reload')
            second=context.new_page();second.on('pageerror',lambda e:errors.append(str(e)))
            second.goto(base+'/configure#appearance',wait_until='networkidle')
            second.get_by_role('radio',name='浅色',exact=True).check()
            expect(page.locator('html')).to_have_attribute('data-theme','light')
            second.get_by_role('radio',name='深色',exact=True).check()
            expect(page.locator('html')).to_have_attribute('data-theme','dark')
            second.get_by_test_id('hex-dark-accent').fill('#99AAFF')
            expect(page.get_by_test_id('hex-dark-accent')).to_have_value('#99AAFF')
            second.close()
            checks.append('Mode and custom colors synchronize between two open React tabs')
            page.set_viewport_size({'width':390,'height':844})
            capture('appearance-zh-mobile-dark')
            page.get_by_role('radio',name='浅色',exact=True).check()
            capture('appearance-zh-mobile-light')
            navigate('general')
            page.get_by_role('radio',name='English',exact=True).check()
            navigate()
            expect(page.locator('.appearance-settings h1')).to_have_text('Appearance')
            expect(page.locator('html')).to_have_attribute('lang','en')
            capture('appearance-en-mobile-light')
            page.get_by_role('radio',name='Dark',exact=True).check()
            capture('appearance-en-mobile-dark')
            page.get_by_test_id('advanced').locator('summary').click()
            expect(page.get_by_test_id('code-size')).to_be_visible()
            checks.append('Chinese and English appearance controls remain usable at 390px in both modes without horizontal overflow')
            context.close()
            browser.close()
        (output/'report.json').write_text(json.dumps({'fixture':'studio-preview React shell','checks':checks,'errors':errors,'settingsWrites':writes,'screenshots':screenshots},ensure_ascii=False,indent=2)+'\n')
        assert not errors, errors
        assert not writes, writes
        print(json.dumps({'passed':len(checks),'screenshots':len(screenshots),'errors':errors}))
    finally:
        server.terminate();server.wait(timeout=10)
