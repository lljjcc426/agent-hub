"""Check optimistic sends against a fresh examples/chat-acceptance.ts workflow host."""

import asyncio
import json
import re
import sys
from pathlib import Path

from playwright.async_api import async_playwright, expect


async def main():
    info = json.loads((Path(sys.argv[1]) / 'browser.json').read_text())
    base = info['base']
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        context = await browser.new_context(viewport={'width': 1280, 'height': 820})
        name, value = info['cookie'].split('=', 1)
        await context.add_cookies([{'name': name, 'value': value, 'url': base}])
        await context.add_init_script("localStorage.setItem('agenthub.configuration.language','zh-CN')")
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        transcript = page.locator('.transcript')
        composer = page.locator('.composer-input')
        pending = transcript.locator('[data-outgoing]')
        status = pending.get_by_role('status')
        retry = pending.get_by_role('button', name='重试', exact=True)
        space_posts = []
        open_space, requested_space, allow_first_send, first_send = (asyncio.Event() for _ in range(4))

        async def gate_space(route):
            if route.request.method == 'POST':
                space_posts.append(route.request.url)
                requested_space.set()
                await open_space.wait()
            await route.continue_()

        async def gate_first_send(route):
            first_send.set()
            await allow_first_send.wait()
            await route.continue_()

        async def send(text):
            await composer.fill(text)
            await composer.press('Enter')
            await expect(pending.get_by_text(text, exact=True)).to_be_visible(timeout=1500)
            await expect(status).to_have_count(0)

        async def accepted(text):
            await expect(pending).to_have_count(0)
            await expect(transcript.locator('.user-bubble').get_by_text(text, exact=True)).to_have_count(1)

        await page.route('**/api/chat/space', gate_space)
        await page.route('**/conversations/*/messages', gate_first_send)
        await page.goto(info['url'])
        await expect(page.locator('.thread')).to_have_attribute('data-welcome', 'true')
        await send('Keep going')
        await expect(page.get_by_role('heading', name='今天想做什么？')).to_have_count(0)
        await asyncio.wait_for(requested_space.wait(), 3)
        assert len(space_posts) == 1 and not first_send.is_set()
        await expect(status).to_have_text('发送中…')
        await expect(retry).to_have_count(0)
        await composer.fill('Separate draft while the conversation opens')
        open_space.set()
        await asyncio.wait_for(first_send.wait(), 5)
        await expect(status).to_have_text('发送中…')
        await expect(composer).to_have_value('Separate draft while the conversation opens')
        allow_first_send.set()
        await accepted('Keep going')
        await page.unroute('**/conversations/*/messages', gate_first_send)
        space = await context.request.get(base + '/api/chat/space')
        conversation = (await space.json())['conversation']['id']

        allow_admission, committed, allow_echo = (asyncio.Event() for _ in range(3))
        attempt_ids, duplicates = [], []

        async def hide_echo(route):
            await allow_echo.wait()
            await route.continue_()

        async def lose_first_receipt(route):
            attempt_ids.append(route.request.post_data_json['clientMessageId'])
            if len(attempt_ids) == 1:
                await allow_admission.wait()
                response = await route.fetch()
                assert response.status == 202
                committed.set()
                await allow_echo.wait()
                return
            response = await route.fetch()
            duplicates.append((await response.json())['duplicate'])
            await route.fulfill(response=response)
            allow_echo.set()

        view_route = re.compile(r'/api/chat/conversations/' + conversation + r'\?')
        await page.route(view_route, hide_echo)
        await page.route('**/conversations/*/messages', lose_first_receipt)
        await send('Check the same conversation')
        await expect(status).to_have_text('发送中…')
        await expect(status).to_have_text('还未确认送达。', timeout=11000)
        allow_admission.set()
        await asyncio.wait_for(committed.wait(), 5)
        await retry.press('Enter')
        await accepted('Check the same conversation')
        assert len(attempt_ids) == 2 and attempt_ids[0] == attempt_ids[1] and duplicates == [True]
        assert len(space_posts) == 1
        await page.unroute('**/conversations/*/messages', lose_first_receipt)
        await page.unroute(view_route, hide_echo)

        allow_late = asyncio.Event()

        async def delay_send(route):
            await allow_late.wait()
            await route.continue_()

        await page.route('**/conversations/*/messages', delay_send)
        await page.set_viewport_size({'width': 390, 'height': 780})
        await page.emulate_media(reduced_motion='reduce')
        await page.evaluate("""window.dispatchEvent(new StorageEvent('storage', {
            key: 'agenthub.configuration.theme', newValue: 'dark'
        }))""")
        await expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        await send('The receipt may be late')
        await expect(status).to_have_text('还未确认送达。', timeout=12000)
        assert await pending.evaluate('row => row.scrollWidth <= row.clientWidth')
        allow_late.set()
        await accepted('The receipt may be late')
        await page.unroute('**/conversations/*/messages', delay_send)

        async def reject(route):
            await route.fulfill(status=409, json={'code': 'request_not_admitted'})

        await page.route('**/conversations/*/messages', reject)
        await composer.evaluate("""input => {
            const clipboardData = new DataTransfer();
            clipboardData.items.add(new File(['draft attachment'], 'send-proof.txt', {type:'text/plain'}));
            input.dispatchEvent(new ClipboardEvent('paste', {clipboardData, bubbles:true, cancelable:true}));
        }""")
        attachment = page.locator('.draft-attachment').get_by_text('send-proof.txt', exact=True)
        await expect(attachment).to_be_visible()
        await composer.fill('Keep the rejected draft')
        await expect(page.get_by_role('button',name='发送消息',exact=True)).to_be_enabled()
        await composer.press('Enter')
        await expect(status).to_have_text('发送失败，草稿已保留。')
        await expect(pending.get_by_text('send-proof.txt',exact=True)).to_be_visible()
        await pending.get_by_role('button', name='编辑消息').click()
        await expect(composer).to_have_value('Keep the rejected draft')
        await expect(composer).to_be_focused()
        await expect(attachment).to_be_visible()
        await expect(pending).to_have_count(0)
        await page.unroute('**/conversations/*/messages', reject)
        await composer.fill('')
        await composer.press('Enter')
        await expect(transcript.locator('.user-message a[download="send-proof.txt"]')).to_have_count(1)
        assert not errors, errors
        await browser.close()
        print('PASS immediate first send, 2s and 10s feedback, idempotent retry, late receipt, rejected draft recovery and file-only send')


asyncio.run(main())
