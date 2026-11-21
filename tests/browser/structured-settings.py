"""Real-host settings acceptance. Pass url.txt from an isolated examples/studio-preview.ts host."""
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

entry = Path(sys.argv[1]).read_text().strip()
output = Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
url = urlsplit(entry)
assert url.hostname in ('localhost', '127.0.0.1')
base = f'{url.scheme}://{url.netloc}'

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 960})
    context.add_init_script("localStorage.setItem('agenthub.configuration.language','zh-CN')")
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(entry, wait_until='domcontentloaded')

    def navigate(route):
        page.goto(base + '/configure#' + route, wait_until='domcontentloaded')

    def settings():
        result = context.request.get(base + '/settings')
        assert result.ok, result.status
        return result.json()['current']

    def update(patch):
        reply = context.request.post(base + '/settings',
                                     data={'revision': settings()['revision'], 'patch': patch},
                                     headers={'origin': base})
        assert reply.ok, reply.status
        return reply.json()

    def save():
        page.locator('#savebar .primary').click()
        expect(page.locator('#savebar')).to_be_hidden()

    def check_browser_profile(screenshot):
        opener = page.get_by_role('button', name='本地验收资料', exact=True)
        opener.click()
        profile = page.get_by_role('dialog', name='浏览器资料')
        expect(profile.get_by_role('heading')).to_have_css('font-size', '18px')
        expect(profile.get_by_role('switch', name='允许工作区 Worker 使用')).to_be_checked()
        primary = profile.get_by_role('button', name='保存')
        expect(primary).to_have_attribute('data-tone', 'primary')
        expect(primary).not_to_have_css('background-color', 'rgba(0, 0, 0, 0)')
        assert profile.evaluate("""el => {
          const panel = el.getBoundingClientRect();
          const title = el.querySelector('h2').getBoundingClientRect();
          return title.left - panel.left >= 18 && el.offsetLeft >= 12 && el.offsetLeft + el.offsetWidth <= innerWidth - 12
            && panel.height < innerHeight && el.scrollWidth <= el.clientWidth;
        }""")
        page.screenshot(path=str(output / screenshot), animations='disabled')
        page.keyboard.press('Escape')
        expect(profile).to_be_hidden()
        expect(opener).to_be_focused()

    seed = settings()['config']['execution']
    seed['router'].update(effort='medium', timeoutMs=1234, prompt='原有协调规则',
                          persona={'identity': '原有身份', 'soul': '原有表达'}, maxSteps=13)
    seed['workers'][0].update(browser={'enabled': False, 'maxTabs': 4}, maxToolCalls=19,
                              prompt='原有文档执行规则', parameters={'temperature': 0.2})
    update({'execution': seed})
    navigate('team')
    team = page.locator('.team-config-page')
    expect(team.get_by_role('heading', name='Agent 团队')).to_be_visible()
    nav = page.locator('.studio-settings-links')
    expect(nav.get_by_role('link', name='部署', exact=True)).to_have_count(0)
    expect(nav.get_by_role('link', name='运行配置', exact=True)).to_be_visible()
    expect(nav.get_by_role('link', name='记忆', exact=True)).to_be_visible()
    page.screenshot(path=str(output / 'team.png'), animations='disabled')

    team.get_by_role('button', name='编辑Roppo').click()
    sheet = team.get_by_role('dialog')
    expect(sheet.get_by_role('textbox', name='名称')).to_have_value('Roppo')
    expect(sheet.get_by_role('textbox', name='职责与提示词')).to_have_count(0)
    sheet.get_by_role('textbox', name='名称').fill('协调助手')
    sheet.get_by_role('button', name='保存', exact=True).click()
    expect(sheet).to_be_hidden()
    expect(page.locator('#savebar')).to_be_hidden()
    assert settings()['config']['execution']['router'] == {**seed['router'], 'label': '协调助手'}

    navigate('advanced/configuration')
    runtime = page.locator('.run-config-page')
    expect(runtime.get_by_role('heading', name='运行配置')).to_be_visible()
    expect(runtime.get_by_role('combobox', name='思考强度')).to_have_value('medium')
    minutes = runtime.get_by_role('spinbutton', name='单轮运行时限 (分钟)')
    assert abs(float(minutes.input_value()) * 60000 - 1234) < 0.001
    minutes.fill('0')
    expect(page.locator('#savebar .primary')).to_be_disabled()
    minutes.fill('0.025')
    expect(page.locator('#savebar .primary')).to_be_enabled()
    page.screenshot(path=str(output / 'runtime.png'), animations='disabled')

    navigate('execution/configuration/editor')
    expect(sheet.get_by_role('heading', name='文档助手')).to_be_visible()
    sheet.get_by_text('接收新任务', exact=True).click()
    expect(sheet.get_by_role('switch', name='接收新任务')).not_to_be_checked()
    revision = settings()['revision']
    sheet.get_by_role('button', name='加入草稿').click()
    expect(sheet).to_be_hidden()
    assert settings()['revision'] == revision
    save()
    saved = settings()['config']['execution']
    assert saved['router']['timeoutMs'] == 1500
    assert saved['workers'][0] == {**seed['workers'][0], 'state': 'paused'}

    navigate('prompts/member/editor')
    expect(page.get_by_role('tab', name='成员专属')).to_have_attribute('aria-selected', 'true')
    expect(page.get_by_role('textbox', name='职责与提示词')).to_have_value('原有文档执行规则')
    page.get_by_role('textbox', name='职责与提示词').fill('核对文档和引用。')
    save()
    assert settings()['config']['execution']['workers'][0]['maxToolCalls'] == 19

    navigate('advanced/browser')
    permissions = page.get_by_role('region', name='执行者浏览器权限')
    expect(permissions.get_by_role('combobox', name='文档助手')).to_have_value('false')
    permissions.get_by_role('combobox', name='文档助手').select_option('inherit')
    save()
    assert settings()['config']['execution']['workers'][0]['browser'] == {'maxTabs': 4}
    created = context.request.post(base + '/api/browser/profiles', headers={'origin': base},
                                   data={'name': '本地验收资料', 'shareWithWorkers': True})
    assert created.ok, created.status
    page.reload(wait_until='domcontentloaded')
    check_browser_profile('browser-profile.png')

    navigate('integrations/tools')
    expect(page.get_by_role('heading', name='成员工具权限')).to_be_visible()
    page.locator('#integration-grant-member').select_option('editor')
    expect(page.locator('#team-tool-grant-mode')).to_have_value('inherit')

    navigate('team')
    team.get_by_role('button', name='添加执行者').click()
    sheet.get_by_role('textbox', name='名称').fill('正式验收执行者')
    sheet.get_by_role('button', name='添加', exact=True).click()
    expect(sheet).to_be_hidden()
    expect(page.locator('#savebar')).to_be_hidden()
    new = settings()['config']['execution']['workers'][-1]
    assert new['label'] == '正式验收执行者' and 'model' not in new and new['backend'] == 'studio'
    team.get_by_role('button', name='编辑正式验收执行者').click()
    sheet.get_by_role('button', name='执行者操作').click()
    sheet.get_by_role('button', name='移除执行者').click()
    expect(sheet.get_by_role('heading', name='移除这个执行者？')).to_be_visible()
    sheet.get_by_role('button', name='移除执行者').click()
    expect(sheet).to_be_hidden()
    expect(page.locator('#savebar')).to_be_hidden()
    assert all(worker['id'] != new['id'] for worker in settings()['config']['execution']['workers'])

    navigate('advanced/configuration')
    effort = runtime.get_by_role('combobox', name='思考强度')
    effort.select_option('high')
    update({'model': 'concurrent-setting'})
    page.locator('#savebar .primary').click()
    expect(page.locator('#savebar')).to_contain_text('版本冲突')
    expect(effort).to_have_value('high')
    page.locator('#savebar').get_by_role('button', name='放弃更改').click()
    page.get_by_role('dialog').get_by_role('button', name='放弃更改').click()
    expect(effort).to_have_value('medium')
    assert settings()['config']['model'] == 'concurrent-setting'
    page.get_by_role('textbox', name='查找设置').fill('配置编辑器')
    expect(nav.get_by_role('link', name='运行配置', exact=True)).to_be_visible()
    page.get_by_role('textbox', name='查找设置').clear()

    navigate('workspace')
    directory = page.locator('.settings-directory')
    expect(directory.get_by_role('link', name='部署', exact=True)).to_be_visible()
    directory.get_by_role('link', name='原始配置', exact=True).click()
    expect(page.get_by_text('JSON 编辑', exact=True)).to_be_visible()
    navigate('general')
    layout = page.get_by_role('group', name='对话布局')
    layout.get_by_text('群聊', exact=True).click()
    expect(layout.get_by_role('radio', name='群聊', exact=True)).to_be_checked()
    page.get_by_role('link', name='数据管理', exact=True).click()
    expect(page.get_by_role('heading', name='对话与上下文', exact=True)).to_be_visible()
    page.get_by_role('button', name='清空所有记忆和上下文').click()
    expect(page.get_by_role('button', name='确认清空')).to_be_visible()
    page.get_by_role('button', name='取消', exact=True).click()
    expect(page.get_by_role('button', name='确认清空')).to_have_count(0)
    assert context.request.get(base + '/api/chat/space').json()['display'] == 'group'
    expect(page.get_by_role('heading', name='聊天显示')).to_have_count(0)
    assert not errors, errors
    context.close()

    mobile = browser.new_context(viewport={'width': 390, 'height': 820}, reduced_motion='reduce')
    mobile.add_init_script("""localStorage.setItem('agenthub.configuration.language','zh-CN');
    localStorage.setItem('agenthub.configuration.theme','dark');""")
    page = mobile.new_page()
    page.goto(entry, wait_until='domcontentloaded')
    navigate('team')
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    page.get_by_role('button', name='编辑协调助手').click()
    sheet = page.get_by_role('dialog')
    expect(sheet).to_be_visible()
    assert sheet.evaluate("el => el.getAnimations().every(a => a.effect.getTiming().duration < 1)")
    assert page.locator('html').evaluate('el => el.scrollWidth <= el.clientWidth')
    page.screenshot(path=str(output / 'team-dark-mobile.png'), animations='disabled')
    sheet.get_by_role('button', name='关闭', exact=True).click()
    expect(sheet).to_be_hidden()
    navigate('advanced/browser')
    check_browser_profile('browser-profile-dark-mobile.png')
    browser.close()

print(json.dumps({'settings': 'saved and reread through the real API', 'conflicts': 'retained drafts',
                  'navigation': 'deep links, grouped settings and raw editor', 'mobile': 'dark and reduced motion'},
                 ensure_ascii=False))
