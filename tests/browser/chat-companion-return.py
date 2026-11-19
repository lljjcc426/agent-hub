"""Pass url.txt from an isolated examples/studio-preview.ts host."""
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


def go_back(page, language):
    names = {
        'zh-CN': ('返回对话', '打开导航'),
        'en': ('Back to chat', 'Open navigation'),
    }
    back, menu = names[language]
    expect(page.locator('.studio-breadcrumb')).to_be_visible()
    toggle = page.get_by_role('button', name=menu, exact=True)
    if toggle.is_visible():
        toggle.click()
    page.get_by_role('link', name=back, exact=True).click(timeout=8000)
    expect(page.locator('.companion-label')).to_be_visible()
    page.wait_for_function('() => window.companionReturnFrames?.done')
    frames = page.evaluate('window.companionReturnFrames.samples')
    assert len(frames) >= 4, frames
    assert all(frame['height'] <= frame['line'] + 1 for frame in frames), frames
    assert all(frame['text'] for frame in frames), frames
    return frames


entry = Path(sys.argv[1]).read_text().strip()
assert urlsplit(entry).hostname in ('localhost', '127.0.0.1')
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    results = []
    for width, language, motion in (
        (1440, 'zh-CN', 'no-preference'),
        (758, 'zh-CN', 'no-preference'),
        (390, 'zh-CN', 'reduce'),
        (320, 'en', 'no-preference'),
    ):
        context = browser.new_context(viewport={'width': width, 'height': 900}, reduced_motion=motion)
        context.add_init_script('localStorage.setItem("agenthub.configuration.language",' + json.dumps(language) + ')')
        context.add_init_script("""document.addEventListener('click', event => {
            if (!event.target.closest?.('.return-chat')) return;
            const result = window.companionReturnFrames = {samples: [], done: false};
            let first;
            function readFrame(time) {
                const caption = document.querySelector('.chat-float-center .companion-label');
                const rect = caption?.getBoundingClientRect();
                if (rect?.height) {
                    first ??= time;
                    result.samples.push({
                        height: rect.height,
                        line: parseFloat(getComputedStyle(caption).lineHeight),
                        width: rect.width,
                        content: caption.scrollWidth,
                        text: caption.textContent
                    });
                    if (time - first >= 500) {
                        result.done = true;
                        return;
                    }
                }
                requestAnimationFrame(readFrame);
            }
            requestAnimationFrame(readFrame);
        }, true);""")
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(entry + '?receipts', wait_until='domcontentloaded')
        first = go_back(page, language)
        if width >= 758:
            assert first[0]['content'] <= first[0]['width'] + 1, first[0]

        shell = page.locator('.chat-float-center')
        setting = '设置' if language == 'zh-CN' else 'Settings'
        page.get_by_role('link', name=setting, exact=True).click()
        expect(page.locator('.conversation-body')).to_be_hidden()
        kept_width = shell.evaluate("""async el => {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return parseFloat(el.style.getPropertyValue('--resting-caption'));
        }""")
        assert kept_width > 0, kept_width
        returned = go_back(page, language)
        if width >= 758:
            assert returned[0]['content'] <= returned[0]['width'] + 1, returned[0]
        if width == 320:
            expect(shell.locator('.companion-label')).to_have_css('text-overflow', 'ellipsis')
            expect(shell.locator('.companion-label')).to_have_css('white-space', 'nowrap')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')

        results.append((width, len(first) + len(returned)))
        assert not errors, errors
        context.close()
    browser.close()
    print('PASS: single-line caption on the first frame and throughout Settings return at', results)
