"""Pass url.txt from an isolated examples/studio-preview.ts host."""
import asyncio
import sys
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.async_api import Error, async_playwright, expect


def snapshot(period):
    def volume(count):
        return {
            'calls': count, 'incompleteCalls': 0,
            'tokens': {'total': 100 * count, 'input': 80 * count, 'output': 20 * count, 'unsplit': 0},
        }

    days = []
    for offset in range(period - 1, -1, -1):
        day = date.today() - timedelta(days=offset)
        usage = volume(30 - offset)
        days.append({'date': day.isoformat(), **usage, 'models': [{'model': 'test-model', **usage}]})
    total = volume(sum(day['calls'] for day in days))
    return {'days': days, 'total': total, 'models': [{'model': 'test-model', **total}]}


async def verify(entry, origin):
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel='chrome', headless=True)
        context = await browser.new_context(viewport={'width': 1360, 'height': 900})
        await context.add_init_script("localStorage.setItem('agenthub.configuration.language','zh-CN')")
        page = await context.new_page()
        pending = asyncio.Queue()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        async def hold(route):
            period = int(parse_qs(urlsplit(route.request.url).query)['days'][0])
            await pending.put((period, route))

        async def take(period):
            requested, route = await asyncio.wait_for(pending.get(), timeout=7)
            assert requested == period
            return route

        async def change(period):
            await page.get_by_text(f'近 {period} 天', exact=True).click()
            return await take(period)

        await page.goto(entry, wait_until='domcontentloaded')
        await page.goto(origin + '/configure#tasks/history', wait_until='domcontentloaded')
        rail = page.locator('.studio-settings-links')
        stats = rail.get_by_role('link', name='使用统计', exact=True)
        activity = rail.get_by_role('link', name='运行记录', exact=True)
        await expect(activity).to_have_attribute('aria-current', 'page')
        await expect(page.locator('.workspace-page-stage').get_by_role('link', name='使用统计')).to_have_count(0)
        await page.route('**/api/usage-statistics?*', hold)
        await stats.click()
        await expect(stats).to_have_attribute('aria-current', 'page')
        await expect(activity).not_to_have_attribute('aria-current', 'page')
        await expect(page.locator('.studio-breadcrumb').get_by_role('link', name='运行记录')).to_have_count(0)
        await expect(page.locator('.usage-stats-placeholder')).to_be_visible()
        await (await take(7)).fulfill(json=snapshot(7))

        day_buttons = page.locator('.usage-chart-day')
        chart = page.locator('.usage-chart-frame')
        busy = page.locator('.usage-stats [aria-busy="true"]')
        retry = page.get_by_role('button', name='重试', exact=True)
        await expect(day_buttons).to_have_count(7)
        await day_buttons.last.click()
        await page.evaluate("""() => {
            window.usageBoard = document.querySelector('.usage-stats-board');
            window.usageSummary = document.querySelector('.usage-stats-summary');
            window.sharedUsageDay = [...document.querySelectorAll('.usage-chart-day')].at(-1);
        }""")

        async def stable(period):
            await expect(day_buttons).to_have_count(period)
            await expect(page.locator('.usage-stats-placeholder, .usage-stats-skeleton')).to_have_count(0)
            assert await page.evaluate("""() =>
                window.usageBoard === document.querySelector('.usage-stats-board') &&
                window.usageSummary === document.querySelector('.usage-stats-summary') &&
                window.sharedUsageDay === [...document.querySelectorAll('.usage-chart-day')].at(-1)
            """)

        async def switch_with_motion(route, period):
            previous = (await day_buttons.last.bounding_box())['width']
            await route.fulfill(json=snapshot(period))
            await stable(period)
            frames = await day_buttons.last.evaluate("""async day => {
                const widths = [];
                const start = performance.now();
                do {
                    await new Promise(requestAnimationFrame);
                    widths.push(day.getBoundingClientRect().width);
                } while (performance.now() - start < 520);
                return widths;
            }""")
            before, after = sorted([previous, frames[-1]])
            intermediate = {round(width, 1) for width in frames if before + 1 < width < after - 1}
            assert after - before > 5 and len(intermediate) >= 3, (period, previous, frames)

        longer = await change(30)
        await expect(busy).to_have_count(1)
        await stable(7)
        await expect(day_buttons.last).to_have_attribute('aria-pressed', 'true')
        await switch_with_motion(longer, 30)
        await expect(day_buttons.last).to_have_attribute('aria-pressed', 'false')
        await expect(busy).to_have_count(0)

        await (await change(7)).fulfill(status=503)
        await expect(retry).to_be_visible()
        await expect(page.get_by_role('radio', name='近 30 天')).to_be_checked()
        await stable(30)
        await retry.click()
        await switch_with_motion(await take(7), 7)

        late = await change(30)
        earlier = await change(7)
        await earlier.fulfill(json=snapshot(7))
        await expect(busy).to_have_count(0)
        try:
            await late.fulfill(json=snapshot(30))
        except Error:
            assert late.request.failure
        await stable(7)
        await expect(page.get_by_role('radio', name='近 7 天')).to_be_checked()
        await expect(page.locator('.usage-chart-day[tabindex="0"]')).to_have_count(1)

        await page.emulate_media(reduced_motion='reduce')
        await (await change(30)).fulfill(json=snapshot(30))
        await stable(30)
        await expect(chart).to_have_css('transition-property', 'none')
        assert await chart.evaluate("el => !el.getAnimations({subtree: true}).length")
        assert not errors, errors
        await browser.close()
        print('PASS: stable chart and totals, motion in both directions, reduced motion, range retry and stale response.')


if __name__ == '__main__':
    url = Path(sys.argv[1]).read_text().strip()
    parts = urlsplit(url)
    assert parts.hostname in ('localhost', '127.0.0.1')
    asyncio.run(verify(url, f'{parts.scheme}://{parts.netloc}'))
