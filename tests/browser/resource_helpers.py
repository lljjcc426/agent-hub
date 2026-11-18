"""Open a tool through the real workspace launcher when it has no tab yet."""
def open_resource(page, name):
    if not page.locator('#session-panel').count():
        page.get_by_role('button',name='Session panel',exact=True).click()
    page.locator('#session-panel').wait_for()
    if page.locator('.team-drawer').count():
        if name != 'Team activity':
            page.locator('.team-drawer-foot').get_by_role('button',name=name,exact=True).click()
        return
    if name == 'Team activity':
        page.get_by_role('button',name='Back to conversation overview').click()
        return
    tab=page.locator('.resource-tabs').get_by_role('tab',name=name,exact=True)
    if tab.count():tab.click()
    else:
        page.get_by_role('button',name='New workspace tab',exact=True).click()
        if name == 'Browser' and page.locator('.resource-tab[data-webpage]').count():
            page.locator('.resource-recent button').filter(has_text='Browser').click()
        else:
            page.locator('.resource-tool-grid').get_by_role('button',name=name,exact=True).click()

async def open_resource_async(page, name):
    if not await page.locator('#session-panel').count():
        await page.get_by_role('button',name='Session panel',exact=True).click()
    await page.locator('#session-panel').wait_for()
    if await page.locator('.team-drawer').count():
        if name != 'Team activity':
            await page.locator('.team-drawer-foot').get_by_role('button',name=name,exact=True).click()
        return
    if name == 'Team activity':
        await page.get_by_role('button',name='Back to conversation overview').click()
        return
    tab=page.locator('.resource-tabs').get_by_role('tab',name=name,exact=True)
    if await tab.count():await tab.click()
    else:
        await page.get_by_role('button',name='New workspace tab',exact=True).click()
        if name == 'Browser' and await page.locator('.resource-tab[data-webpage]').count():
            await page.locator('.resource-recent button').filter(has_text='Browser').click()
        else:
            await page.locator('.resource-tool-grid').get_by_role('button',name=name,exact=True).click()

async def open_workspace_async(page):
    await page.get_by_role('link',name='Current workspace',exact=True).click()
    await page.get_by_role('dialog',name='Switch workspace').get_by_role('button',name='Close',exact=True).click()
