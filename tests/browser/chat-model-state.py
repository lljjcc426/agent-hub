"""Run after building Chat, against examples/chat-acceptance.ts in fixture mode."""
import json
import re
import sys
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright


info = json.loads((Path(sys.argv[1]) / 'browser.json').read_text())
base = info['base']
capabilities_url = re.compile(re.escape(base) + r'/model-connections/capabilities\?')


def refreshed(response, backend='codex'):
    query = parse_qs(urlsplit(response.url).query)
    return capabilities_url.search(response.url) and query.get('refresh') == ['1'] and query.get('backend') == [backend]


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    context = browser.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
    key, value = info['cookie'].split('=', 1)
    context.add_cookies([{'name': key, 'value': value, 'url': base}])
    context.add_init_script("localStorage.setItem('agenthub.configuration.language','zh-CN')")
    def post(path, data=None):
        response = context.request.post(base + path, headers={'Origin': base}, data=data)
        assert response.ok, (response.status, response.json().get('code'))
        return response.json()

    version = context.request.get(base + '/configuration').json()['current']
    version['config']['backends']['openai'] = {'kind': 'openai-responses', 'baseUrl': 'https://api.openai.com/v1',
        'model': 'gpt-6.2-sol', 'label': 'OpenAI', 'apiKeyEnv': 'ROPPO_TEST_MISSING_PROVIDER_KEY'}
    post('/settings', {'revision': version['revision'], 'patch': {'backends': version['config']['backends']}})
    conversation = post('/api/chat/space')['conversation']['id']
    endpoint = base + '/api/chat/conversations/' + conversation

    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base + '/chat#conversation/' + conversation)
    toolbar = page.locator('.composer-toolbar .composer-model')
    dialog = page.get_by_role('dialog', name='对话模型')
    model_button = dialog.locator('.model-name-button')
    effort = dialog.get_by_role('slider', name='思考强度')
    sol = dialog.get_by_role('menuitemradio', name='gpt-6.1-sol', exact=True)
    with page.expect_response(refreshed):
        toolbar.click()
    expect(effort).to_have_attribute('aria-valuetext', '中等')
    with page.expect_response(refreshed):
        model_button.click()
    expect(sol).to_be_visible()
    dialog.get_by_role('button', name='返回模型').click()

    held_catalogs = []
    page.route(capabilities_url, lambda route: held_catalogs.append(route))
    model_button.click()
    expect(sol).to_be_visible()
    expect(dialog.get_by_role('menu', name='模型')).to_have_attribute('aria-busy', 'true')
    assert len(held_catalogs) == 1
    held_catalogs.pop().fulfill(status=503, json={'code': 'fixture_offline'})
    expect(dialog.get_by_role('menu', name='模型')).to_have_attribute('aria-busy', 'false')
    expect(sol).to_be_visible()
    dialog.get_by_role('button', name='返回模型').click()

    held_settings = []
    page.route(base + '/configuration', lambda route: held_settings.append(route))
    page.reload(wait_until='domcontentloaded')
    toolbar.click()
    expect(effort).to_have_attribute('aria-valuetext', '中等')
    assert held_settings and held_catalogs
    expect(effort).to_be_disabled()
    page.unroute(base + '/configuration')
    for route in held_settings:
        route.continue_()
    expect(effort).to_be_enabled()
    held_catalogs.pop().fulfill(status=503, json={'code': 'fixture_offline'})
    expect(dialog.locator('.model-dial')).to_have_attribute('aria-busy', 'false')
    page.unroute(capabilities_url)
    fresh = {'model': 'gpt-6.1-terra', 'models': ['gpt-6.1-terra', 'new-catalog-model'],
             'reasoning': {'source': 'catalog', 'efforts': ['low', 'medium', 'high']}}
    page.route(capabilities_url, lambda route: route.fulfill(json=fresh), times=1)
    with page.expect_response(refreshed):
        model_button.click()
    expect(dialog.get_by_role('menuitemradio', name='new-catalog-model')).to_be_visible()
    expect(sol).to_have_count(0)

    dialog.get_by_role('combobox', name='模型连接').select_option('openai')
    official = dialog.get_by_role('menuitemradio', name='gpt-6.2-sol', exact=True)
    expect(official).to_be_visible()
    messages = '/api/chat/conversations/' + conversation + '/messages'
    first = post(messages, {'text': 'Review the existing plan.', 'clientMessageId': str(uuid.uuid4())})['runId']
    page.wait_for_function("""async endpoint => (await (await fetch(endpoint)).json()).reply?.state === 'running'""", arg=endpoint)
    expect(official).to_be_enabled()
    expect(dialog.get_by_text('本次任务结束后可切换。')).to_have_count(0)
    with page.expect_response(lambda response: response.url == base + '/settings' and response.request.method == 'POST') as saved:
        official.click()
    assert saved.value.ok
    expect(model_button).to_have_accessible_name('模型连接 · gpt-6.2-sol')
    expect(effort).to_have_attribute('max', '5')
    expect(effort).to_be_enabled()
    expect(effort).to_have_attribute('aria-valuetext', '模型默认')
    with page.expect_response(lambda response: response.url == base + '/settings' and response.request.method == 'POST') as effort_save:
        effort.press('End')
    assert effort_save.value.ok
    expect(effort).to_have_attribute('aria-valuetext', '极高')

    page.keyboard.press('Escape')
    page.locator('.composer-input').fill('Review the next plan.')
    with page.expect_response(lambda response: response.url == base + messages and response.request.method == 'POST') as sent:
        page.get_by_role('button', name='发送消息', exact=True).click()
    assert sent.value.status == 202
    next_run = sent.value.json()['runId']
    page.wait_for_function("""async ([endpoint, id]) => {
        const view = await (await fetch(endpoint)).json();
        return view.calls.some(call => call.runId === id && call.kind === 'router' && call.model === 'gpt-6.2-sol');
    }""", arg=[endpoint, next_run], timeout=30000)
    calls = context.request.get(endpoint).json()['calls']
    assert {call['model'] for call in calls if call['runId'] == first and call['kind'] == 'router'} == {'gpt-6.1-terra'}
    assert not errors, errors
    browser.close()
    print('PASS first open and repeated refresh, cached list and effort after reload, and model switch while a turn runs')
