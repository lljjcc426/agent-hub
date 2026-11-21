/** Runs in Ego's Node runtime. Requests are serialized data, never model-supplied Node programs. */
export const egoBrowserScript = String.raw`
const reply = value => console.log('ROPPO_EGO_RESULT ' + JSON.stringify(value));
try {
  const {space, profile, otherProfiles, create, operation, args, active, page: pinnedPage} = request;
  const matches = (await listTaskSpaces()).filter(item => item.name === space);
  if (matches.length > 1) throw new Error('ROPPO_EGO_SPACE_AMBIGUOUS');
  const existing = matches[0];
  if (operation === 'close' && !existing) {
    reply({ok: true});
  } else {
    if (!existing && !create) throw new Error('ROPPO_EGO_SPACE_MISSING');
    let options;
    if (!existing) {
      const available = (await profiles()).filter(item => item.id === profile || item.name === profile);
      if (available.length !== 1) throw new Error('ROPPO_EGO_PROFILE_REQUIRED');
      if (otherProfiles.some(alias => alias === available[0].id || alias === available[0].name))
        throw new Error('ROPPO_EGO_PROFILE_SHARED');
      options = {profileId: available[0].id};
    }
    const task = existing ? await taskSpace(existing.id) : await taskSpace(space, options);
    if (operation === 'close') {
      await task.finish({keep: []});
      reply({ok: true});
    } else {
      const tabs = await task.tabs();
      const managed = tabs.filter(tab => tab.label);
      if (pinnedPage && !managed.some(tab => tab.label === pinnedPage)) throw new Error('ROPPO_EGO_TAB_MISSING');
      let selected = managed.find(tab => tab.label === active) ?? managed.find(tab => tab.active) ?? managed[0];
      if (!selected) {
        const page = await task.newPage();
        selected = {label: page.label, page};
      }
      let page = selected.page;
      let value;
      switch (operation) {
        case 'open':
          if (args[0] !== 'about:blank' || selected.url && selected.url !== 'about:blank') {
            await page.goto(args[0], {waitUntil: 'domcontentloaded'});
          }
          break;
        case 'list':
          value = {tabs: managed.map((tab, index) => ({
            tabId: 't' + tab.label.slice(1), index, url: tab.url, title: tab.title, active: tab.label === page.label
          }))};
          break;
        case 'new':
          page = await task.newPage();
          if (args[0] !== 'about:blank') await page.goto(args[0], {waitUntil: 'domcontentloaded'});
          break;
        case 'select':
        case 'close_tab': {
          const tab = managed.find(tab => tab.label === 'p' + args[0].slice(1));
          if (!tab) throw new Error('ROPPO_EGO_TAB_MISSING');
          if (operation === 'select') page = tab.page;
          else {
            if (managed.length <= 1) throw new Error('ROPPO_EGO_LAST_TAB');
            await tab.page.close();
            if (tab.label === page.label) page = managed.find(item => item !== tab).page;
          }
          break;
        }
        case 'snapshot':
          value = {snapshot: await page.snapshot({scope: 'full_page'})};
          break;
        case 'title':
          value = {title: await page.title()};
          break;
        case 'click':
        case 'fill': {
          if (args[2]) {
            // The bundled app can invalidate refs between CLI invocations.
            // Refresh them inside this action, and only act if the page still
            // matches the caller's snapshot.
            const {createHash} = await import('node:crypto');
            const observed = await page.snapshot({scope: 'full_page'});
            if (createHash('sha256').update(observed).digest('hex') !== args[2])
              throw new Error('ROPPO_EGO_STALE_SNAPSHOT');
          }
          if (operation === 'click' && args[3]) {
            const {join} = await import('node:path');
            const {randomUUID} = await import('node:crypto');
            const received = page.waitForEvent('download', {timeout: 25000});
            void received.catch(() => {});
            await page.click(args[0]);
            const download = await received;
            const original = download.suggestedFilename().replace(/[/\\:*?"<>|\x00-\x1f]/g,'-').slice(0,150);
            const name = randomUUID().slice(0,8) + '-' + (original || 'download');
            await download.saveAs(join(args[3],name));
            value = {download: {name}};
          } else if (operation === 'click') await page.click(args[0]);
          else await page.fill(args[0], args[1]);
          break;
        }
        case 'press':
          await page.keyboard.press(args[0]);
          break;
        case 'scroll': {
          const amount = Number(args[1]);
          const delta = {up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0]}[args[0]];
          await page.evaluate(([x, y]) => { window.scrollBy(x, y); }, delta);
          break;
        }
        case 'back':
        case 'forward': {
          const history = await page.cdp('Page.getNavigationHistory');
          const entry = history.entries[history.currentIndex + (operation === 'back' ? -1 : 1)];
          if (entry) {
            await page.cdp('Page.navigateToHistoryEntry', {entryId: entry.id});
            await page.waitForLoadState('domcontentloaded').catch(() => {});
          }
          break;
        }
        case 'reload':
          await page.reload({waitUntil: 'domcontentloaded'});
          break;
        case 'evaluate':
          value = await page.evaluate(args[0]);
          break;
        case 'screenshot':
          await page.screenshot({path: args[0], fullPage: args[1]});
          break;
        case 'frame': {
          const viewport = (await page.cdp('Page.getLayoutMetrics')).cssVisualViewport;
          const {data} = await page.cdp('Page.captureScreenshot', {
            format: 'jpeg', quality: 76, captureBeyondViewport: false
          });
          value = {data, width: viewport.clientWidth, height: viewport.clientHeight};
          break;
        }
        case 'viewport':
          await page.cdp('Emulation.setDeviceMetricsOverride', {
            width: args[0], height: args[1], deviceScaleFactor: 1, mobile: false
          });
          break;
        case 'upload':
          await page.setInputFiles(args[0], [args[1]]);
          break;
        case 'input':
          for (const {method, params} of args[0]) await page.cdp(method, params);
          break;
        case 'load': {
          const [state, url] = args;
          const cookies = state.cookies.map(({name, value, domain, path, expires, ...flags}) => ({
            name, value, domain, path, secure: flags.secure, httpOnly: flags.httpOnly,
            ...(expires > 0 ? {expires} : {}),
            ...(['Strict', 'Lax', 'None'].includes(flags.sameSite) ? {sameSite: flags.sameSite} : {})
          }));
          if (cookies.length) await page.cdp('Network.setCookies', {cookies});
          const origin = new URL(url).origin;
          const storage = state.origins.find(item => item.origin === origin)?.localStorage;
          if (Array.isArray(storage) && storage.length) {
            const source = 'if(location.origin===' + JSON.stringify(origin) + ') for(const item of ' +
              JSON.stringify(storage) + ') localStorage.setItem(item.name,item.value);';
            const {identifier} = await page.cdp('Page.addScriptToEvaluateOnNewDocument', {source});
            try { await page.goto(url, {waitUntil: 'domcontentloaded'}); }
            finally { await page.cdp('Page.removeScriptToEvaluateOnNewDocument', {identifier}); }
          } else {
            await page.goto(url, {waitUntil: 'domcontentloaded'});
          }
          break;
        }
        default: throw new Error('ROPPO_EGO_UNSUPPORTED');
      }
      reply({ok: true, active: page.label, value});
    }
  }
} catch (error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  reply({ok: false, code: /^(?:EGO|ROPPO_EGO)_[A-Z0-9_]+$/.test(code) ? code :
    /^(?:EGO|ROPPO_EGO)_[A-Z0-9_]+$/.test(message) ? message : 'ROPPO_EGO_ACTION_FAILED'});
}
`
