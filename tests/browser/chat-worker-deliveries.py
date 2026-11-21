"""Check plan and Worker delivery visibility in both Chat layouts."""
import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


info = json.loads((Path(os.environ['CHAT_BROWSER_DIR']) / 'fixture.json').read_text())
base = info['url']

with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    context = browser.new_context(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
    name, value = info['cookie'].split('=', 1)
    context.add_cookies([{'name': name, 'value': value, 'url': base}])
    context.add_init_script("localStorage.setItem('agenthub.configuration.language','zh-CN')")
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base + '/chat')
    page.wait_for_load_state('networkidle')
    composer = page.locator('.composer-input')
    composer.fill('请交付复核文件')
    page.get_by_role('button', name='发送消息', exact=True).click()
    transcript = page.locator('.transcript')
    delivery = transcript.get_by_role('button', name='打开文件 review.md', exact=True)
    router_plan = transcript.get_by_text('发布复核总计划', exact=True)
    worker_plan = transcript.get_by_text('复核文件执行计划', exact=True)
    expect(delivery).to_be_visible(timeout=20000)
    expect(router_plan).to_be_visible()
    expect(worker_plan).to_be_visible()
    delivery_message = transcript.locator('.assistant-message').filter(
        has=page.get_by_role('button', name='打开文件 review.md', exact=True))
    expect(delivery_message.get_by_role('button', name='@Roppo', exact=True)).to_be_visible()

    page.goto(base + '/configure#general')
    layout = page.get_by_role('group', name='对话布局')
    layout.get_by_text('Agent 列表', exact=True).click()
    expect(layout.get_by_role('radio', name='Agent 列表', exact=True)).to_be_checked()
    page.get_by_role('link', name='返回对话', exact=True).click()
    picker = page.get_by_role('button', name='切换对话', exact=True)
    expect(picker).to_be_visible()
    expect(composer).to_be_visible()
    expect(transcript.get_by_text('复核工作已安排。', exact=True)).to_be_visible()
    expect(router_plan).to_be_visible()
    expect(worker_plan).to_have_count(0)
    expect(delivery).to_have_count(0)

    picker.click()
    page.get_by_role('button', name='开发 Worker', exact=True).click()
    expect(transcript.get_by_role('heading', name='暂无协作消息')).to_be_visible()
    expect(router_plan).to_have_count(0)
    expect(worker_plan).to_have_count(0)
    expect(delivery).to_have_count(0)

    picker.click()
    page.get_by_role('button', name='复核 Worker', exact=True).click()
    expect(delivery).to_be_visible()
    expect(worker_plan).to_be_visible()
    expect(router_plan).to_have_count(0)
    delivery.click()
    expect(page.get_by_role('dialog', name='review.md')).to_contain_text('检查完成。')
    assert not errors, errors
    browser.close()
    print('PASS plans and deliveries are scoped to the selected Agent, and the group shows the full conversation')
