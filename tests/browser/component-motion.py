"""Check real transition frames, interaction and reduced motion in a running component gallery."""

import sys

from playwright.sync_api import expect, sync_playwright


def radio(page, name):
    return page.get_by_role("radio", name=name, exact=True).locator("..")


def frames(page, element):
    page.evaluate(
        """selector => {
      window.rpFrames = [];
      let start;
      function frame(now) {
        const node = document.querySelector(selector);
        const box = node?.getBoundingClientRect();
        const style = node && getComputedStyle(node);
        const effects = document.getAnimations().map(a => [
          a.animationName || a.transitionProperty || '', a.effect.getComputedTiming().progress
        ]);
        window.rpFrames.push({t:now-start,x:box?.x,y:box?.y,w:box?.width,h:box?.height,
            opacity:style?.opacity,bg:style?.backgroundColor,display:style?.display,effects});
        if (now-start<800) requestAnimationFrame(frame);
      }
      const begin = () => {
        window.removeEventListener('click',begin,true);
        window.removeEventListener('keydown',begin,true);
        start = performance.now();
        frame(start);
      };
      window.addEventListener('click',begin,true);
      window.addEventListener('keydown',begin,true);
    }""",
        element,
    )


def result(page):
    page.wait_for_function("window.rpFrames.at(-1)?.t >= 800")
    return page.evaluate("window.rpFrames")


def intermediate(samples, key):
    return {round(row[key], 1) for row in samples if row.get(key) is not None}


def visible_effect(samples, effect):
    return any(
        name == effect and pct is not None and 0 < pct < 1
        for row in samples
        for name, pct in row["effects"]
    )


def check_switches(page, base):
    page.goto(base + "/#feedback")
    page.get_by_role("heading", name="浮层与反馈").wait_for()
    segment = ".rp-choices .rp-selection-indicator"
    frames(page, segment)
    radio(page, "错误").click()
    sampled = result(page)
    assert len(intermediate(sampled, "x")) > 3, "segment jumped between endpoints"
    assert visible_effect(sampled, "rp-panel-in") and visible_effect(sampled, "rp-content-out"), (
        "missing content crossfade"
    )
    src = radio(page, "错误").bounding_box()
    dst = radio(page, "加载").bounding_box()
    page.mouse.move(src["x"] + src["width"] / 2, src["y"] + src["height"] / 2)
    page.mouse.down()
    page.mouse.move(dst["x"] + dst["width"] / 2, dst["y"] + dst["height"] / 2, steps=8)
    page.mouse.up()
    expect(page.get_by_role("radio", name="加载")).to_be_checked()
    # Reverse using actual keyboard input before the previous slide can settle.
    for key in ("ArrowRight", "ArrowRight", "ArrowLeft", "ArrowLeft", "ArrowLeft"):
        page.keyboard.press(key)
    expect(page.get_by_role("radio", name="内容", exact=True)).to_be_checked()
    expect(page.get_by_role("button", name="查看", exact=True)).to_be_visible()
    frames(page, ".gallery-rail .rp-selection-indicator")
    page.get_by_role("navigation", name="组件分类", exact=True).get_by_role(
        "link", name="对话", exact=True
    ).click()
    sampled = result(page)
    assert len(intermediate(sampled, "y")) > 3 and visible_effect(sampled, "rp-page-in")
    frames(page, ".gallery")
    page.get_by_role("button", name="切换为深色").click()
    assert len({r["bg"] for r in result(page)}) > 3, "theme did not interpolate"
    frames(page, ".page-chat .rp-choices .rp-selection-indicator")
    radio(page, "Agents 列表").click()
    assert visible_effect(result(page), "rp-panel-in")
    page.get_by_role("button", name="文档助手 发布清单已经核对，可以交付。").click()
    expect(page.get_by_role("textbox", name="请和 Router 对话")).to_be_visible()
    page.get_by_role("button", name="切换为浅色").click()


def check_layers(page, base):
    page.goto(base + "/#work")
    row = page.get_by_role("button", name="整理发布清单", exact=False)
    expect(row).to_be_visible()
    row.focus()
    sel = 'dialog[data-placement="side"]'
    frames(page, sel)
    row.press("Enter")
    enter = result(page)
    assert len(intermediate(enter, "x") - {0}) > 3, "drawer open snapped"
    dialog = page.get_by_role("dialog", name="任务详情")
    openfile = dialog.get_by_role("button", name="发布清单.xlsx", exact=False)
    openfile.focus()
    openfile.press("Enter")
    expect(page.get_by_role("table", name="发布清单内容")).to_be_visible()
    page.keyboard.press("Escape")
    expect(openfile).to_be_focused()
    frames(page, sel)
    page.keyboard.press("Escape")
    exit_frames = result(page)
    faded = [
        r for r in exit_frames if r.get("opacity") is not None and r.get("display") != "none" and 0.02 < float(r["opacity"]) < 0.98
    ]
    assert len(faded) > 1 and len(intermediate(faded, "x")) > 1, "drawer close snapped"
    expect(row).to_be_focused()
    page.goto(base + "/#chat")
    radio(page, "群聊").click()
    trigger = page.locator('.sample-composer').get_by_role('button', name='模型连接 · gpt-6.1-terra')
    sel = ".composer-palette"
    trigger.click()
    popup = page.get_by_role("dialog", name="对话模型")
    popup.get_by_role("slider").press("ArrowRight")
    expect(popup.get_by_role("slider")).to_have_attribute("aria-valuetext", "高")
    page.wait_for_timeout(350)
    frames(page, sel)
    page.keyboard.press("Escape")
    faded = [
        r for r in result(page) if r.get("opacity") is not None and r.get("display") != "none" and 0.02 < float(r["opacity"]) < 0.98
    ]
    assert len(faded) > 1, "popover close snapped"
    trigger.click()
    trigger.press("Escape")
    trigger.press("Enter")
    page.wait_for_timeout(330)
    expect(popup.get_by_role("slider")).to_have_attribute("aria-valuetext", "高")
    page.get_by_role("textbox", name="向 Router 发送消息").click()
    expect(popup).to_have_count(0)
    sample = page.locator(".sample-worker-note details")
    summary = sample.locator("summary")
    frames(page, ".sample-worker-note details")
    summary.click()
    heights = intermediate(result(page), "h")
    assert len(heights) > 3, "disclosure open snapped"
    frames(page, ".sample-worker-note details")
    summary.click()
    assert len(intermediate(result(page), "h")) > 3, "disclosure close snapped"


def main(base, engine):
    with sync_playwright() as pw:
        b = pw[engine].launch()
        p = b.new_page(viewport={"width": 1440, "height": 900}, reduced_motion="no-preference")
        check_switches(p, base)
        check_layers(p, base)
        r = b.new_page(viewport={"width": 390, "height": 844}, reduced_motion="reduce")
        r.goto(base + "/#feedback")
        r.get_by_role("heading", name="浮层与反馈").wait_for()
        frames(r, ".rp-choices .rp-selection-indicator")
        radio(r, "错误").click()
        samples = result(r)
        assert not visible_effect(samples, "rp-panel-in")
        assert len(intermediate(samples, "x")) <= 2
        b.close()


if __name__ == "__main__":
    main(sys.argv[1].rstrip("/"), sys.argv[2] if len(sys.argv) > 2 else "chromium")
