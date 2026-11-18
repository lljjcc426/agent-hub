"""Regression for duplicate save feedback. Runs against a fresh local Studio fixture."""
import asyncio
import os
from pathlib import Path
import socket
from tempfile import TemporaryDirectory

from playwright.async_api import async_playwright, expect


async def verify(base, root):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        context = await browser.new_context(viewport={'width': 1160, 'height': 830}, reduced_motion='reduce')
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto((root / 'url.txt').read_text().strip())
        await page.locator('.studio-rail').wait_for()
        url = base + '/configure#advanced/intake'
        await page.goto(url)
        rule_name = page.get_by_role('textbox', name='条件名称')
        rule_text = page.get_by_role('textbox', name='什么情况下需要跟进？')
        dock = page.locator('.settings-action-dock')
        toast = page.locator('.settings-feedback .rp-toast[data-visible=true]')
        save = dock.get_by_role('button', name='保存更改', exact=True)
        await expect(dock).to_have_count(0)
        title = await page.get_by_role('heading', level=1, name='从消息中发现任务').bounding_box()
        first_row = await page.locator('.intake-mode').bounding_box()
        assert 0 <= first_row['y'] - title['y'] - title['height'] < 80
        await page.get_by_role('button', name='添加条件').click()
        await expect(rule_name).to_be_focused()
        await rule_name.fill('构建失败')
        await rule_text.fill('群里有人报告构建失败时跟进')
        await page.get_by_role('radio', name='自动开始任务').check()

        # Hold a single real POST until its in-flight UI has been inspected.
        pending, release = asyncio.Event(), asyncio.Event()

        async def delay(route):
            pending.set()
            await release.wait()
            await route.continue_()

        await page.route('**/settings', delay, times=1)
        await dock.get_by_role('button', name='保存全部更改').click()
        await asyncio.wait_for(pending.wait(), timeout=8)
        try:
            await expect(dock.locator('.rp-button[aria-busy=true]')).to_have_text('保存中…')
            await expect(dock.get_by_text('有未保存的更改')).to_have_count(0)
            await expect(page.locator('.management-content #notice, .management-content #savebar')).to_have_count(0)
            await expect(rule_text).to_be_disabled()
        finally:
            release.set()
        await expect(toast).to_contain_text('已保存版本', timeout=20000)
        await expect(dock).to_have_count(0)
        await page.reload()
        await expect(rule_name).to_have_value('构建失败')
        await expect(page.get_by_role('radio', name='自动开始任务')).to_be_checked()

        # Cancel once, then discard the same edit. The host revision stays intact.
        await rule_name.fill('草稿')
        await dock.get_by_role('button', name='放弃更改').click()
        await page.keyboard.press('Escape')
        await expect(rule_name).to_have_value('草稿')
        await dock.get_by_role('button', name='放弃更改').click()
        await page.get_by_role('dialog').get_by_role('button', name='放弃更改').click()
        await expect(rule_name).to_have_value('构建失败')
        await expect(toast).to_contain_text('已放弃')
        await page.get_by_role('button', name='移除条件').click()
        await page.get_by_role('dialog').get_by_role('button', name='移除条件').click()
        await expect(page.locator('.intake-form .rp-empty')).to_be_visible()

        # A failed POST must keep the draft editable and allow a real retry.
        await page.route('**/settings', lambda r: r.fulfill(status=503, json={'error': 'Fixture offline'}), times=1)
        await save.click()
        await expect(dock.get_by_role('alert')).to_contain_text('请求失败')
        await dock.get_by_role('button', name='详情').click()
        await expect(page.get_by_role('dialog')).to_contain_text('Fixture offline')
        await page.keyboard.press('Escape')
        await save.click()
        await expect(toast).to_contain_text('已保存版本', timeout=20000)
        await expect(toast).to_have_count(0, timeout=5500)

        # Competing edits from a second tab produce an actual revision conflict.
        other = await context.new_page()
        await other.goto(url)
        await other.get_by_role('radio', name='只记录').check()
        await page.get_by_role('radio', name='忽略').check()
        await save.click()
        await expect(toast).to_contain_text('已保存版本', timeout=20000)
        other_dock = other.locator('.settings-action-dock')
        await other_dock.get_by_role('button', name='保存更改').click()
        await expect(other_dock).to_contain_text('版本冲突')
        await other_dock.get_by_role('button', name='核对冲突').click()
        await expect(other.get_by_role('heading', name='核对较新版本')).to_be_focused()
        await expect(other.get_by_role('radio', name='只记录')).to_be_checked()
        await other_dock.get_by_role('button', name='放弃更改').click()
        await other.get_by_role('dialog').get_by_role('button', name='放弃更改').click()
        await expect(other.get_by_role('radio', name='忽略')).to_be_checked()

        # Saving only behavior rules must leave the intake change in the shared draft.
        await page.get_by_role('radio', name='自动开始任务').check()
        await page.get_by_role('link', name='行为规则', exact=True).click()
        await page.locator('#prompt-rule-personality').fill('开门见山')
        async with page.expect_response(lambda r: r.url.endswith('/settings') and r.request.method == 'POST') as write:
            await dock.get_by_role('button', name='仅保存行为规则').click()
        assert (await write.value).request.post_data_json['patch'].keys() == {'prompts'}
        await expect(toast).to_contain_text('已保存版本', timeout=20000)
        await expect(save).to_be_enabled()
        await page.go_back()
        await expect(page.get_by_role('radio', name='自动开始任务')).to_be_checked()

        await page.set_viewport_size({'width': 375, 'height': 740})
        await page.get_by_role('radio', name='自动开始任务').check()
        await expect(save).to_be_in_viewport()
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors, errors
        await browser.close()


async def main():
    with TemporaryDirectory(prefix='roppo-settings-ui-') as directory:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        base = f'http://127.0.0.1:{port}'
        host = await asyncio.create_subprocess_exec(
            'node', '--import', 'tsx', 'examples/studio-preview.ts', directory,
            env={**os.environ, 'ROPPO_PREVIEW_PORT': str(port)}, stdout=asyncio.subprocess.PIPE,
        )
        try:
            line = await asyncio.wait_for(host.stdout.readline(), timeout=30)
            assert base in line.decode(), 'Studio fixture failed to start'
            await verify(base, Path(directory))
        finally:
            if host.returncode is None:
                host.terminate()
                try:
                    await asyncio.wait_for(host.wait(), timeout=5)
                except TimeoutError:
                    host.kill()
                    await host.wait()


if __name__ == '__main__':
    asyncio.run(main())
