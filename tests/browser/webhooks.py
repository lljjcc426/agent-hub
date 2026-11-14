"""Real browser against the isolated host fixture. No production account or state."""
import json,sys,hmac,hashlib,base64,time,uuid
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
root=Path(sys.argv[1]); info=json.loads((root/'browser-info.json').read_text()); keys=json.loads((root/'test-keys.json').read_text()); base=info['url']; errors=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True); context=browser.new_context(viewport={'width':1440,'height':1000},reduced_motion='reduce'); context.add_init_script("localStorage.setItem('agenthub.configuration.language','zh-CN')");page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 status=context.request.get(base+'/account/status',headers={'authorization':'Bearer '+info['token']}).json()
 if not status.get('configured'):
  setup=context.request.post(base+'/account/setup',headers={'authorization':'Bearer '+info['token'],'origin':base},data={'username':'webhook-test','displayName':'Webhook 验证','password':'isolated-browser-test-only-2026'});assert setup.ok,setup.status
 else:
  login=context.request.post(base+'/account/login',headers={'origin':base},data={'username':'webhook-test','password':'isolated-browser-test-only-2026'});assert login.ok,login.status
 page.goto(base+'/webhook-workbench');page.wait_for_load_state('networkidle');page.screenshot(path=str(root/'desktop-before.png'),full_page=True)
 (root/'initial-dom.txt').write_text(page.locator('main').inner_text())
 expect(page.get_by_role('button',name='Compute',exact=False)).to_be_visible();page.get_by_role('button',name='Compute',exact=False).click();expect(page.get_by_role('heading',name='Compute',exact=True)).to_be_visible()
 before=context.request.get(base+'/webhooks').json();page.get_by_role('button',name='接入设置',exact=True).click();page.get_by_text('预演事件',exact=True).click();page.get_by_role('button',name='验证事件').click();expect(page.locator('.automation-message[role=status]')).to_contain_text('事件匹配通过');after=context.request.get(base+'/webhooks').json();assert before['receipts']==after['receipts'] and before['deliveries']==after['deliveries']
 page.get_by_role('button',name='停止接收',exact=True).click();expect(page.get_by_role('button',name='恢复接收',exact=True)).to_be_visible();page.reload();page.wait_for_load_state('networkidle');page.get_by_role('button',name='Compute',exact=False).click();expect(page.get_by_role('button',name='恢复接收',exact=True)).to_be_visible();page.get_by_role('button',name='恢复接收',exact=True).click();expect(page.get_by_role('button',name='停止接收',exact=True)).to_be_visible()
 page.get_by_role('button',name='接入设置',exact=True).click();page.get_by_text('高级设置',exact=True).click();page.get_by_text('轮换签名密钥',exact=True).click();page.get_by_label('新输入密钥变量',exact=True).fill('WEBHOOK_UI_IN_NEXT');page.get_by_label('新回调密钥变量',exact=True).fill('WEBHOOK_UI_OUT_NEXT');page.get_by_role('button',name='更新密钥',exact=True).click();expect(page.locator('.automation-message[role=status]')).to_contain_text('签名密钥已更新')
 # Signed HTTP events exercise the actual inbox, task engine, waits and callback ledger.
 def event(kind,identifier):
  body=json.dumps({'specversion':'1.0','id':identifier,'source':'https://producer.example/events','type':kind,'data':{'batch':'browser-batch'}},separators=(',',':')).encode();timestamp=str(int(time.time()));delivery='browser_'+uuid.uuid4().hex;secret=base64.b64decode(keys['WEBHOOK_UI_IN_NEXT'][6:]);sig=base64.b64encode(hmac.new(secret,delivery.encode()+b'.'+timestamp.encode()+b'.'+body,hashlib.sha256).digest()).decode();response=context.request.post(info['webhookUrl']+'/webhooks/'+info['grantId'],headers={'content-type':'application/json','webhook-id':delivery,'webhook-timestamp':timestamp,'webhook-signature':'v1,'+sig},data=body);assert response.status==202,response.text();return response.json()
 first=event('test.request','browser-start');assert event('test.request','browser-start')['duplicate']
 for _ in range(80):
  snap=context.request.get(base+'/webhooks').json()
  if snap['waits'] and snap['waits'][0]['state']=='waiting':break
  time.sleep(.1)
 else:raise AssertionError('No durable wait')
 page.get_by_role('button',name='刷新',exact=True).click();page.get_by_role('button',name='任务',exact=True).click();expect(page.get_by_role('button',name='暂停任务',exact=True)).to_be_visible();page.get_by_role('button',name='暂停任务',exact=True).click();expect(page.get_by_role('button',name='继续推进',exact=True)).to_be_visible();event('test.release','browser-release');page.get_by_role('button',name='继续推进',exact=True).click()
 for _ in range(120):
  snap=context.request.get(base+'/webhooks').json()
  if snap['deliveries'] and snap['deliveries'][0]['state']=='sent':break
  time.sleep(.1)
 else:raise AssertionError('No delivered callback')
 page.get_by_role('button',name='刷新',exact=True).click();page.get_by_role('button',name='事件记录',exact=True).click();expect(page.locator('.automation-detail')).to_contain_text('已送达');assert snap['deliveries'][0]['attempts']==2
 page.get_by_role('button',name='自动化列表',exact=True).click();page.get_by_role('button',name='新建自动化',exact=True).click();expect(page.get_by_role('heading',name='新建自动化',exact=True)).to_be_visible();f=page.locator('.automation-editor')
 f.get_by_role('combobox',name='授权消息',exact=True).select_option('local:approval');f.get_by_role('textbox',name='名称',exact=True).fill('Browser created automation');f.get_by_role('textbox',name='要完成的任务',exact=True).fill('Write result.json whose total is 42. Never deploy.');f.get_by_role('textbox',name='验收要求',exact=True).fill('Total is 42');f.get_by_role('button',name='下一步',exact=True).click()
 f.get_by_role('textbox',name='事件来源地址',exact=True).fill('https://producer.example/events');f.get_by_role('textbox',name='事件类型',exact=True).fill('test.request');f.get_by_role('textbox',name='事件签名密钥变量',exact=True).fill('WEBHOOK_UI_IN');f.get_by_role('textbox',name='回传签名密钥变量',exact=True).fill('WEBHOOK_UI_OUT');f.get_by_role('textbox',name='结果回传地址',exact=True).fill('http://127.0.0.1:'+str(info['callbackPort'])+'/callback');f.get_by_role('checkbox',name='回传服务已按 webhook-id 去重',exact=True).check();f.get_by_role('button',name='创建自动化',exact=True).click();expect(page.locator('.automation-message[role=status]')).to_contain_text('自动化已创建');expect(page.get_by_role('heading',name='Browser created automation',exact=True)).to_be_visible();page.get_by_role('button',name='自动化列表',exact=True).click()
 page.get_by_label('搜索自动化',exact=True).fill('no-match');expect(page.locator('.automation-list')).to_contain_text('没有匹配');page.get_by_label('搜索自动化',exact=True).fill('');page.screenshot(path=str(root/'desktop-after.png'),full_page=True)
 page.keyboard.press('Tab');assert page.evaluate('document.activeElement !== document.body');page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(root/'mobile.png'),full_page=True);assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
 assert not errors,errors; (root/'browser-evidence.json').write_text(json.dumps({'ok':True,'checks':['authenticated UI','dry-run no effects','receive stop resume persisted on reload','key rotation','HTTP duplicate','durable event wait','goal pause resume','callback retry','create grant through form','search empty state','keyboard focus','390px no overflow'],'consoleErrors':errors,'model':'fixture stub; native model evidence separate'},ensure_ascii=False,indent=2));browser.close()
