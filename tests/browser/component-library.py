"""Run against an open component gallery: python tests/browser/component-library.py <base-url>."""
import sys

from playwright.sync_api import expect, sync_playwright


def check_composer(page):
    draft = page.get_by_role("textbox", name="向 Router 发送消息")
    transcript = page.get_by_role("region", name="示例对话记录")
    draft.fill("待发送的草稿")
    page.get_by_role("button", name="模型连接 · gpt-6.1-terra").press("Enter")
    picker = page.get_by_role("dialog", name="对话模型")
    effort = picker.get_by_role("slider", name="思考强度")
    expect(effort).to_have_attribute("aria-valuetext", "中等")
    effort.press("ArrowRight")
    expect(effort).to_have_attribute("aria-valuetext", "高")
    picker.get_by_role("button", name="模型连接 · gpt-6.1-terra").click()
    picker.get_by_role("menuitemradio", name="DeepSeek").click()
    expect(picker.get_by_role("button", name="模型连接 · deepseek-flash")).to_be_visible()
    page.keyboard.press("Escape")
    expect(draft).to_have_value("待发送的草稿")
    expect(transcript.get_by_text("待发送的草稿")).to_have_count(0)

    draft.dispatch_event("keydown", {"key": "Enter", "isComposing": True})
    expect(draft).to_have_value("待发送的草稿")
    draft.press("Enter")
    expect(transcript.get_by_text("待发送的草稿", exact=True)).to_have_count(1)
    expect(draft).to_have_value("")

    draft.fill("/permissions")
    page.get_by_role("option", name="审批策略").click()
    page.get_by_role("menuitemradio", name="无需审批").click()
    expect(page.get_by_role("button", name="审批策略 · 无需审批")).to_be_visible()
    plus = page.get_by_role("button", name="对话操作")
    plus.click()
    page.get_by_role("menuitem", name="上下文用量").click()
    expect(page.get_by_role("dialog", name="上下文用量").get_by_text("已用 20%")).to_be_visible()
    page.get_by_role("button", name="查看用量明细").click()
    page.get_by_role("button", name="关闭上下文用量").click()
    plus.click()
    with page.expect_file_chooser() as chooser:
        page.get_by_role("menuitem", name="添加文件").click()
    chooser.value.set_files({"name": "preview.txt", "mimeType": "text/plain", "buffer": b"sample"})
    page.get_by_role("button", name="发送消息", exact=True).click()
    expect(transcript.get_by_role("link", name="preview.txt")).to_be_visible()

    row = transcript.locator('[data-message-id="reply"]')
    row.locator(".message-line").hover()
    row.get_by_role("button", name="表情回应", exact=True).click()
    page.get_by_role("button", name="🎉", exact=True).click()
    expect(row.get_by_role("button", name="移除 🎉", exact=False)).to_be_visible()
    row.locator(".message-line").hover()
    row.get_by_role("button", name="引用回复").click()
    expect(page.get_by_role("button", name="取消引用")).to_be_visible()
    page.get_by_role("button", name="取消引用").click()
    tray_button = page.get_by_role("button", name="待处理事项", exact=True)
    tray_button.click()
    tray = page.get_by_role("complementary", name="待处理事项")
    tray.get_by_role("button", name="定位到原消息").click()
    expect(page.locator(".sample-question")).to_be_focused()
    tray_button.click()
    tray.get_by_role("button", name="表格", exact=True).click()
    expect(tray.get_by_text("暂无待处理事项")).to_be_visible()
    tray.get_by_role("button", name="隐藏待处理事项").click()
    expect(page.locator(".sample-question").get_by_text("表格", exact=True)).to_be_visible()


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
