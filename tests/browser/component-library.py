"""Run against an open component gallery: python tests/browser/component-library.py <base-url>."""
import sys
from pathlib import Path

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
    expect(page.locator(".sample-question").get_by_role("status")).to_have_text("表格")


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
    activity = page.locator('[data-activity-id="release"]')
    activity.locator('summary').click()
    expect(activity).to_contain_text('按负责人分组')
    activity.get_by_role('button', name='文档助手', exact=False).click()
    expect(page.get_by_role('textbox', name='请和 Router 对话')).to_be_visible()


def check_delivery(page, base):
    page.goto(base + "/#agents")
    sample = page.get_by_role("group", name="文件交付验收")
    tile = sample.get_by_role("button", name="打开文件 发布说明.md")
    expect(tile).to_have_count(0)
    sample.get_by_role("button", name="拒绝交付").click()
    expect(sample.get_by_role("status")).to_have_text("已拒绝")
    page.locator('[data-example="file-delivery"]').get_by_role("link", name="任务与文件").click()
    expect(page.get_by_role("heading", name="任务与文件", exact=True)).to_be_visible()
    expect(sample.get_by_role("status")).to_have_text("已拒绝")
    expect(tile).to_have_count(0)

    sample.get_by_role("button", name="重新演示").click()
    sample.locator("summary").press("Enter")
    draft = sample.locator("pre")
    expect(draft).to_contain_text("陈舟")
    source = draft.text_content().encode()
    sample.get_by_role("button", name="确认交付").press("Enter")
    expect(sample.get_by_role("status")).to_have_text("已交付")
    tile.press("Enter")
    viewer = page.get_by_role("dialog", name="发布说明.md")
    expect(viewer.get_by_role("heading", name="发布说明", exact=True)).to_be_visible()
    expect(viewer.get_by_role("table").get_by_role("row")).to_have_count(4)
    preview_url = viewer.get_by_role("link", name="下载").evaluate("a => a.href")
    with page.expect_download() as downloaded:
        viewer.get_by_role("link", name="下载").click()
    assert downloaded.value.suggested_filename == "发布说明.md"
    assert downloaded.value.path().read_bytes() == source
    box = viewer.bounding_box()
    assert 0 <= box["x"] and box["x"] + box["width"] <= page.viewport_size["width"]
    page.keyboard.press("Escape")
    expect(viewer).to_have_count(0)
    expect(tile).to_be_focused()
    page.route(preview_url, lambda route: route.fulfill(status=503, body="Unavailable"))
    tile.click()
    expect(viewer.get_by_role("alert")).to_have_text("预览加载失败")
    expect(viewer.get_by_role("link", name="下载")).to_be_visible()
    page.keyboard.press("Escape")
    page.unroute(preview_url)
    tile.click()
    expect(viewer.get_by_role("table")).to_be_visible()
    viewer.get_by_role("button", name="关闭文件").click()

    page.get_by_role("button", name="打开文件 发布清单.xlsx").click()
    workbook = page.get_by_role("dialog", name="发布清单.xlsx")
    expect(workbook.get_by_text("下载后查看此文件")).to_be_visible()
    with page.expect_download() as binary:
        workbook.get_by_role("link", name="下载").click()
    expected = Path(__file__).resolve().parents[2] / "web/component-preview/release-checklist.xlsx"
    assert binary.value.suggested_filename == "发布清单.xlsx"
    assert binary.value.path().read_bytes() == expected.read_bytes()
    page.keyboard.press("Escape")


def check_mobile(page, base):
    page.add_init_script("localStorage.setItem('roppo-component-theme', 'dark')")
    page.goto(base + "/#chat")
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    form = page.locator(".sample-composer")
    form.scroll_into_view_if_needed()
    for source in ["model", "plus", "slash"]:
        if source == "model":
            form.get_by_role("button", name="模型连接 · gpt-6.1-terra").tap()
        elif source == "plus":
            form.get_by_role("button", name="对话操作").tap()
            page.get_by_role("menuitem", name="模型连接").tap()
        else:
            form.get_by_role("textbox").fill("/model")
            page.get_by_role("option", name="模型连接").tap()
        picker = page.get_by_role("dialog", name="对话模型")
        expect(picker.get_by_role("slider")).to_be_visible()
        expect(picker).to_have_css("opacity", "1")
        bounds, anchor = picker.bounding_box(), form.bounding_box()
        assert abs(bounds["x"] - anchor["x"]) < 2
        assert bounds["x"] + bounds["width"] <= page.viewport_size["width"]
        form.get_by_role("textbox").tap()
        expect(picker).to_have_count(0)
    form.get_by_role("textbox").fill("手机消息")
    form.get_by_role("button", name="发送消息").tap()
    expect(page.get_by_role("region", name="示例对话记录").get_by_text("手机消息")).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")


if __name__ == "__main__":
    base = sys.argv[1].rstrip("/")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page()
        page.goto(base + "/#chat")
        check_composer(page)
        page.goto(base + "/#work")
        check_dialogs(page)
        check_delivery(page, base)
        mobile = browser.new_page(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, color_scheme="dark")
        check_mobile(mobile, base)
        check_delivery(mobile, base)
        browser.close()
