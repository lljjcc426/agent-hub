"""Run against an open component gallery: python tests/browser/component-library.py <base-url>."""
import sys

from playwright.sync_api import expect, sync_playwright


def check_composer(page):
    draft = page.get_by_role("textbox", name="输入示例消息…")
    transcript = page.get_by_role("region", name="示例对话记录")
    draft.fill("待发送的草稿")
    page.get_by_role("button", name="示例模型和思考强度").press("Enter")
    picker = page.get_by_role("dialog", name="示例模型和思考强度")
    effort = picker.get_by_role("radio", name="中", exact=True)
    effort.focus()
    effort.press("ArrowRight")
    picker.get_by_role("radio", name="高", exact=True).press("Enter")
    expect(draft).to_have_value("待发送的草稿")
    expect(transcript.get_by_text("待发送的草稿")).to_have_count(0)
    page.keyboard.press("Escape")

    draft.dispatch_event("keydown", {"key": "Enter", "isComposing": True})
    expect(draft).to_have_value("待发送的草稿")
    draft.press("Enter")
    expect(transcript.get_by_text("待发送的草稿", exact=True)).to_have_count(1)
    expect(draft).to_have_value("")


def check_dialogs(page):
    row = page.get_by_role("button", name="整理发布清单", exact=False)
    row.click()
    task = page.get_by_role("dialog", name="任务详情")
    open_file = task.get_by_role("button", name="发布清单.xlsx", exact=False)
    open_file.click()
    expect(page.get_by_role("table", name="发布清单内容")).to_be_visible()
    page.keyboard.press("Escape")
    expect(open_file).to_be_focused()
    page.keyboard.press("Escape")
    expect(row).to_be_focused()


if __name__ == "__main__":
    base = sys.argv[1].rstrip("/")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page()
        page.goto(base + "/#chat")
        check_composer(page)
        page.goto(base + "/#work")
        check_dialogs(page)
        browser.close()
