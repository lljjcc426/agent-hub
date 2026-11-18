"""Exercise the eleven Agent gallery specimens against the same local release example."""

import sys

from playwright.sync_api import expect, sync_playwright


def check_page(page, base):
    page.goto(base + "/#agents")

    def card(key):
        return page.locator(f'[data-example="{key}"]')

    def choose(area, name):
        area.get_by_role("radio", name=name, exact=True).locator("..").click()

    expect(page.locator(".agent-example:visible")).to_have_count(11)
    sources = page.locator(".agent-example > header a").evaluate_all(
        "(xs)=>xs.map(x=>new URL(x.href).pathname)"
    )
    assert len(set(sources)) == 11 and all(s.startswith("/components/") for s in sources)

    crew = card("agent-crew")
    crew.get_by_role("button", name="研究助手", exact=True).click()
    expect(crew.locator(".rp-node-detail")).to_contain_text("检索")
    tools = card("tool-access-map")
    choose(tools, "Router")
    tools.get_by_role("button", name="查询进度", exact=False).click()
    expect(tools.locator(".rp-map-receipt")).to_contain_text("等待调用")
    tools.get_by_role("button", name="试运行", exact=True).click()
    expect(tools.locator(".rp-travelling")).to_have_count(1)
    expect(tools.locator(".rp-map-receipt")).to_contain_text("清单已归类")
    choose(tools, "文档助手")
    tools.get_by_text("调用详情", exact=True).click()
    args = tools.get_by_role("textbox", name="工具参数")
    args.fill("{")
    tools.get_by_role("button", name="用新参数重放").click()
    expect(tools.get_by_role("alert")).to_be_visible()
    args.fill('{"path":"清单副本.csv"}')
    tools.get_by_role("button", name="用新参数重放").click()
    tc = card("tool-call-card")
    tc.locator("summary").filter(has_text="read_file").click()
    expect(tc.locator("pre").first).to_contain_text("清单副本.csv")
    tc.locator("summary").filter(has_text="check_links").click()
    tc.get_by_role("button", name="重试调用").click()
    expect(tc.get_by_text("3 条链接检查通过", exact=True)).to_be_visible()

    relay = card("agent-handoff")
    choose(relay, "交付")
    expect(relay.locator(".rp-handoff-receipt")).to_contain_text("发布清单.xlsx")
    expect(relay.locator(".rp-handoff-receipt")).to_contain_text("未传递")
    choose(page.get_by_role("group", name="Agent 组件分类"), "执行")
    expect(page.locator(".agent-example:visible")).to_have_count(4)
    plan = card("agent-plan")
    plan.get_by_role("button", name="编辑读取发布清单").click()
    plan.get_by_role("textbox", name="步骤名称").fill("读取三项检查")
    plan.get_by_role("button", name="保存步骤").click()
    grip = plan.get_by_role("button", name="调整顺序：读取三项检查")
    grip.focus()
    grip.press("Alt+ArrowDown")
    expect(plan.locator("ol li").nth(1)).to_contain_text("读取三项检查")
    grip.drag_to(plan.locator("ol li").first)
    expect(plan.locator("ol li").first).to_contain_text("读取三项检查")
    plan.get_by_role("button", name="添加步骤").click()
    plan.get_by_role("textbox", name="步骤名称").fill("核对负责人")
    plan.get_by_role("textbox", name="步骤名称").press("Enter")
    plan.get_by_role("button", name="删除核对负责人").click()
    expect(plan.locator("ol li")).to_have_count(3)
    choose(page.get_by_role("group", name="Agent 组件分类"), "全部 11")
    page.get_by_role("button", name="播放演示").click()
    expect(crew.locator('.rp-live-dot[data-working="true"]')).to_have_count(1)
    expect(tools.locator(".rp-travelling")).to_have_count(1)
    mon = card("agent-monitor")
    mon.get_by_role("button", name="暂停运行").click()
    expect(page.get_by_role("button", name="继续演示")).to_be_visible()
    elapsed = mon.locator(".rp-monitor-now time").inner_text()
    page.wait_for_timeout(220)
    assert mon.locator(".rp-monitor-now time").inner_text() == elapsed
    mon.get_by_role("button", name="折叠运行监视器").click()
    expect(mon.get_by_role("button", name="展开运行监视器")).to_have_attribute(
        "aria-expanded", "false"
    )
    mon.get_by_role("button", name="展开运行监视器").click()
    mon.get_by_role("button", name="继续运行").click()
    expect(plan.get_by_role("button", name="重新运行")).to_be_enabled(timeout=8000)
    expect(mon.locator(".rp-card-foot")).to_contain_text("3/3")
    mon.get_by_text("运行日志", exact=True).click()
    expect(mon.locator(".rp-run-log li")).to_have_count(3)

    cp = card("agent-checkpoints")
    cp.get_by_role("button", name="从初次运行的按负责人归类重试").click()
    expect(cp.locator(".rp-branch-lines path")).to_have_count(1)
    expect(cp.locator("section")).to_have_count(2)
    expect(cp.locator('section[data-active="true"]')).to_contain_text("尝试 2")
    cp.get_by_role("button", name="初次运行 3 个检查点").click()
    expect(cp.locator('section[data-active="true"]')).to_contain_text("检查链接")
    choose(page.get_by_role("group", name="Agent 组件分类"), "上下文与决策")
    expect(page.locator(".agent-example:visible")).to_have_count(4)
    context = card("context-window")
    def context_colors():
        return context.evaluate("""el => Object.fromEntries([...el.querySelectorAll('.rp-context-legend i')].map(swatch => {
          const id = swatch.dataset.category;
          const cell = el.querySelector('.rp-cells [data-category="'+id+'"]');
          return [id, [getComputedStyle(swatch).backgroundColor, cell && getComputedStyle(cell).backgroundColor]];
        }))""")
    light = context_colors()
    assert set(light) == {'system','tools','attachments','conversation','memory'}
    assert len({swatch for swatch, cell in light.values()}) == 5
    for swatch, cell in light.values():
        assert swatch == cell
        rgb = [int(x) for x in swatch[4:-1].split(',')]
        assert max(rgb)-min(rgb) >= 40
    page.get_by_role("button",name="切换为深色").click()
    # Grid cells animate their fill. Wait for the theme transition to reach the new swatch.
    page.wait_for_function("""() => [...document.querySelectorAll('[data-example="context-window"] .rp-context-legend i')]
      .every(s => getComputedStyle(s).backgroundColor === getComputedStyle(document.querySelector(
        '[data-example="context-window"] .rp-cells [data-category="'+s.dataset.category+'"]')).backgroundColor)""")
    dark = context_colors()
    assert all(dark[key][0] != light[key][0] and dark[key][0] == dark[key][1] for key in light)
    page.get_by_role("button",name="切换为浅色").click()
    filled = context.locator('.rp-cells i:not([data-band="free"])')
    count = filled.count()
    context.get_by_role("button", name="突出显示系统提示").focus()
    expect(context.locator('.rp-cells [data-dim="true"]').first).to_be_attached()
    context.get_by_text("附件 · 2", exact=True).click()
    context.get_by_role("button", name="移除发布说明.md").click()
    assert filled.count() < count
    before = filled.count()
    context.get_by_role("button", name="压缩对话").click()
    expect(context.get_by_role("button", name="已压缩")).to_be_disabled()
    assert filled.count() < before

    approval = card("approval-card")
    group = approval.get_by_role("group", name="授权请求")
    group.focus()
    group.press("Control+Enter")
    expect(approval.get_by_role("status")).to_have_text("已批准")
    expect(group).to_be_focused()
    approval.get_by_role("button", name="重新查看").click()
    group.focus()
    group.press("Escape")
    expect(approval.get_by_role("status")).to_have_text("已拒绝")
    decision = card("decision-card")
    decision.get_by_role("button", name="稍后").click()
    expect(decision.get_by_role("button", name="展开问题")).to_be_visible()
    decision.get_by_role("button", name="展开问题").click()
    decision.get_by_role("group").focus()
    page.keyboard.press("2")
    expect(decision.get_by_role("status")).to_have_text("按截止时间")
    decision.get_by_role("button", name="重新选择").click()
    decision.get_by_role("button", name="自己填写").click()
    decision.get_by_role("textbox", name="自定义答复").fill("按检查类型")
    decision.get_by_role("textbox", name="自定义答复").press("Enter")
    expect(decision.get_by_role("status")).to_have_text("按检查类型")

    memory = card("memory-panel")
    choose(memory, "项目")
    memory.get_by_role("button", name="修改记忆：发布前需要核对文档链接。").click()
    memory.get_by_role("textbox", name="记忆内容").fill("交付前检查下载。")
    memory.get_by_role("textbox", name="记忆内容").press("Enter")
    memory.get_by_role("button", name="删除记忆：交付前检查下载。").click()
    expect(memory.get_by_text("暂无记忆")).to_be_visible()
    memory.get_by_role("button", name="撤销").click()
    expect(memory.get_by_text("交付前检查下载。", exact=True)).to_be_visible()
    choose(page.get_by_role("group", name="Agent 组件分类"), "全部 11")
    expect(plan.locator("ol li").first).to_contain_text("读取三项检查")


if __name__ == "__main__":
    base = sys.argv[1].rstrip("/")
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        p = b.new_page(viewport={"width": 1440, "height": 960})
        errors = []
        p.on("pageerror", lambda err: errors.append(str(err)))
        check_page(p, base)
        for width in (320, 390, 768):
            p.set_viewport_size({"width": width, "height": 844})
            p.goto(base + "/#agents")
            expect(p.locator(".agent-example:visible")).to_have_count(11)
            for section in p.locator(".agent-example").all():
                assert section.evaluate("el=>el.scrollWidth<=el.clientWidth+1"), (
                    width,
                    section.get_attribute("data-example"),
                )
            assert p.evaluate("document.documentElement.scrollWidth<=innerWidth")
        assert not errors, errors
        b.close()
