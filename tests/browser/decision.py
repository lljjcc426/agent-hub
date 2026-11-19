"""Real settings and probe acceptance on the isolated examples/decision-acceptance.ts host."""
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

info = json.loads(Path(sys.argv[1]).read_text())
output = Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
base = info['base']
url = base + '/configure#advanced/configuration'
checks = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='chrome')
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    context.add_init_script("localStorage.setItem('agenthub.configuration.language','zh-CN')")
    def sign_in(target):
        response = target.request.post(base + '/account/login', headers={'origin': base},
                                       data={'username': info['username'], 'password': info['password'], 'remember': True})
        assert response.ok, response.status

    sign_in(context)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(url)
    decision = page.get_by_role('region', name='消息前置判断')
    expect(decision).to_be_visible()

    def method(name):
        decision.get_by_text(name, exact=True).click()
        expect(decision.get_by_role('radio', name=name, exact=True)).to_be_checked()

    def save():
        page.locator('#savebar .primary').click()
        expect(page.locator('#savebar')).to_be_hidden()

    def saved_decision():
        response = context.request.get(base + '/settings')
        assert response.ok, response.status
        return response.json()['current']['config']['decision']

    expect(decision.get_by_role('radio', name='规则')).to_be_checked()
    decision.get_by_role('link', name='跟进规则').click()
    expect(page.get_by_role('heading', name='跟进条件', exact=True)).to_be_visible()
    page.go_back(wait_until='domcontentloaded')
    method('外接')
    expect(page.locator('#savebar .primary')).to_be_disabled()
    connection = decision.get_by_role('combobox', name='模型连接')
    connection.select_option('cpu')
    decision.get_by_text('给 Router 建议', exact=True).click()
    decision.get_by_text('试一条消息', exact=True).click()
    sample = decision.get_by_role('textbox', name='测试消息')
    run = decision.get_by_role('button', name='运行测试')
    sample.fill('请继续处理刚才的任务。')
    run.click()
    result = decision.locator('.run-config-probe [role="status"]')
    expect(result).to_contain_text(' ms', timeout=15000)
    if not info['realModel']:
        expect(result).to_contain_text('输入 42')
    save()
    assert saved_decision()['provider'] == {'kind': 'backend', 'id': 'cpu'}
    assert saved_decision()['mode'] == 'advisory'
    checks.append('Real probe HTTP request, reported usage and persisted shared model connection')

    page.reload()
    expect(connection).to_have_value('cpu')
    expect(decision.get_by_role('radio', name='给 Router 建议')).to_be_checked()
    method('Jev')
    expect(decision.get_by_role('textbox', name='密钥变量名')).to_have_value('TYPESAFE_API_KEY')
    expect(decision.get_by_role('textbox', name='服务地址')).to_have_count(0)
    decision.get_by_text('服务地址和模型', exact=True).click()
    expect(decision.get_by_role('textbox', name='服务地址')).to_have_value('https://api.typesafe.ai/v1')
    expect(decision.get_by_role('textbox', name='模型名称')).to_have_value('jev-latest')
    save()
    assert saved_decision()['provider']['kind'] == 'jev'
    page.reload()
    expect(decision.get_by_role('radio', name='Jev', exact=True)).to_be_checked()
    method('本地')
    address = decision.get_by_role('textbox', name='服务地址')
    name = decision.get_by_role('textbox', name='模型名称')
    expect(address).to_have_value('http://127.0.0.1:8080/v1')
    expect(page.locator('#savebar .primary')).to_be_disabled()
    address.fill('http://remote.example.com/v1')
    name.fill('cpu-judge')
    expect(address).to_have_attribute('aria-invalid', 'true')
    address.fill(info['provider'])
    expect(page.locator('#savebar .primary')).to_be_enabled()
    save()
    assert saved_decision()['provider']['kind'] == 'openai-chat'
    assert saved_decision()['provider']['baseUrl'] == info['provider']
    checks.append('Jev presets, local endpoint save and address validation')

    decision.get_by_text('试一条消息', exact=True).click()
    sample.fill('请停止旧任务。')
    held = []
    page.route('**/decision/probe', lambda route: held.append(route))
    run.click()
    expect(run).to_be_disabled()
    sample.fill('改成另一条消息。')
    assert held
    held.pop().fulfill(status=200, json={'status': 'ok', 'decisions': [{'id': 'sample', 'action': 'STOP'}], 'latencyMs': 3})
    expect(run).to_be_enabled()
    expect(result).not_to_contain_text('停止')
    page.unroute('**/decision/probe')
    page.route('**/decision/probe', lambda route: route.fulfill(status=200, json={'status': 'unavailable', 'code': 'timeout'}))
    run.click()
    expect(result).to_contain_text('timeout')
    page.unroute('**/decision/probe')
    run.click()
    expect(result).to_contain_text(' ms', timeout=15000)
    checks.append('Stale probe results are hidden and another test can recover after timeout')

    method('外接')
    connection.select_option(':manual')
    protocols = decision.get_by_role('combobox', name='接口类型')
    protocols.select_option('anthropic')
    address.fill('https://example.invalid/v1')
    name.fill('fixture-test')
    save()
    external = saved_decision()['provider']
    assert external['kind'] == 'anthropic' and external['model'] == 'fixture-test'
    method('本地')
    expect(page.locator('#savebar .primary')).to_be_disabled()
    method('规则')
    save()
    assert saved_decision()['mode'] == 'off'
    assert saved_decision()['provider'] == external
    checks.append('External custom protocol and preserved provider when returning to Rules')

    page.get_by_role('button', name='配置维护').click()
    page.get_by_role('link', name='编辑原始 JSON').click()
    expect(page.get_by_text('JSON 编辑', exact=True)).to_be_visible()
    page.go_back(wait_until='domcontentloaded')
    expect(decision.get_by_role('radio', name='规则')).to_be_checked()
    method('外接')
    expect(protocols).to_have_value('anthropic')
    decision.scroll_into_view_if_needed()
    page.screenshot(path=str(output / 'decision-light.png'), animations='disabled')
    assert not errors, errors
    context.close()

    narrow = browser.new_context(viewport={'width': 390, 'height': 820}, reduced_motion='reduce')
    narrow.add_init_script("""localStorage.setItem('agenthub.configuration.language','zh-CN');
    localStorage.setItem('agenthub.configuration.theme','dark');""")
    sign_in(narrow)
    page = narrow.new_page()
    page.goto(url)
    decision = page.get_by_role('region', name='消息前置判断')
    expect(decision).to_be_visible()
    method('Jev')
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    assert page.locator('html').evaluate('el => el.scrollWidth <= el.clientWidth')
    assert decision.locator('.run-config-decision-options').evaluate(
        "el => el.getAnimations().every(a => a.effect.getTiming().duration < 1)")
    decision.scroll_into_view_if_needed()
    page.screenshot(path=str(output / 'decision-mobile.png'), animations='disabled')
    browser.close()
    checks.append('Raw editor remains available, and controls fit dark narrow mode')

(output / 'browser-result.json').write_text(json.dumps({'checks': checks, 'errors': errors, 'realModel': info['realModel']},
                                                       ensure_ascii=False, indent=2))
print(json.dumps(checks, ensure_ascii=False))
