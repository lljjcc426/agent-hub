import {existsSync} from 'node:fs'
import {mkdir,rename,rm,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {chromium,type Browser,type BrowserContext,type CDPSession,type Download,type Locator,type Page,type Screencast} from 'playwright-core'
import {getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js'
import type {z} from 'zod'
import {BrowserError,type BrowserFrame,type browserConfigSchema} from './browser-contract.ts'
import {browserFilename} from './browser-files.ts'
import type {BrowserDriver,DriverSession} from './browser-driver.ts'
import {inputMessages,type BrowserInput} from './browser-input.ts'
import {prepareChromium,prepareScreencastEncoder} from './browser-runtime.ts'

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>
type View = {
  context: BrowserContext
  close: () => Promise<void>
  tabs: Map<string,Page>
  active?: string
  nextTab: number
  changed: Set<()=>void>
  cdps: Map<Page,Promise<CDPSession>>
  downloads: WeakMap<Download,Promise<{name:string}>>
  buttons: number
}
const viewport={width:1200,height:800}
const previousChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browserProfileMarker='.roppo-browser-runtime'
const asTab=(index:number)=>'t'+index
const detailDelayMs=180
const detailPixels={width:2880,height:1800}

async function actionPoint(view:View,page:Page,control:Locator,signal?:AbortSignal){
  if(!view.changed.size)return
  try{
    await control.scrollIntoViewIfNeeded({timeout:160,signal})
    const box=await control.boundingBox({timeout:160,signal})
    if(!box)return
    const {width,height}=page.viewportSize()??await page.evaluate(()=>({width:innerWidth,height:innerHeight}))
    const left=Math.max(0,box.x),top=Math.max(0,box.y)
    const right=Math.min(width,box.x+box.width),bottom=Math.min(height,box.y+box.height)
    if(left<right&&top<bottom)return {x:(left+right)/(2*width),y:(top+bottom)/(2*height)}
  }catch{
    signal?.throwIfAborted()
    // Feedback is optional. Playwright still performs its normal action checks.
  }
}

/** One warm Chromium process for Worker contexts. Personal profiles keep their user-data directory. */
export class ManagedBrowserDriver implements BrowserDriver {
  readonly provider='roppo'
  private shared?:Promise<Browser>
  private readonly sessions=new Map<string,Promise<View>>()
  private stopping=false

  constructor(private settings:z.infer<typeof browserConfigSchema>){}

  async version(){return 'Roppo Chromium'}

  private async launchOptions(session?: DriverSession) {
    // Existing macOS Chrome profiles may use the Chrome Safe Storage key. Open
    // them with the same executable when available rather than migrating them.
    const legacy=process.platform==='darwin'&&session?.persistent&&!existsSync(join(session.directory,browserProfileMarker))&&
      existsSync(join(session.directory,'Local State'))&&existsSync(previousChrome)
    const executablePath=await prepareChromium(this.settings.executablePath??(legacy?previousChrome:undefined))
    return {executablePath,headless:true,env:getDefaultEnvironment(),timeout:this.settings.timeoutMs}
  }

  private browser() {
    this.shared ??= this.launchOptions().then(opts=>chromium.launch(opts)).then(browser=>{
      browser.once('disconnected',()=>{this.shared=undefined})
      return browser
    }).catch(error=>{this.shared=undefined;throw error})
    return this.shared
  }

  private async openContext(session: DriverSession) {
    if(session.cdpPort){
      const browser=await chromium.connectOverCDP('http://127.0.0.1:'+session.cdpPort,{
        noDefaults:true, timeout:this.settings.timeoutMs,
      }).catch(()=>{throw new BrowserError('browser_unavailable','The workspace Chromium is reconnecting.',503)})
      const context=browser.contexts()[0]
      if(context)return {context,close:()=>browser.close()}
      await browser.close()
      throw new BrowserError('browser_unavailable','The workspace Chromium has no browser context.',503)
    }
    const preferences={viewport,acceptDownloads:true}
    const context=session.persistent
      ?await chromium.launchPersistentContext(session.directory,{...await this.launchOptions(session),...preferences})
      :await (await this.browser()).newContext(preferences)
    return {context,close:()=>context.close()}
  }

  private async create(session:DriverSession):Promise<View> {
    if(this.stopping)throw new BrowserError('browser_cancelled','Roppo browser is stopping.')
    await mkdir(join(session.directory,'downloads'),{recursive:true,mode:0o700})
    const persistent=session.persistent===true
    const legacyProfile=persistent&&existsSync(join(session.directory,'Local State'))&&!existsSync(join(session.directory,browserProfileMarker))
    const {context,close}=await this.openContext(session)
    try{
      if(persistent&&!legacyProfile)await writeFile(join(session.directory,browserProfileMarker),'roppo\n',{mode:0o600})
      context.setDefaultTimeout(this.settings.timeoutMs)
      context.setDefaultNavigationTimeout(this.settings.timeoutMs)
      const view:View={context,close,tabs:new Map(),nextTab:0,changed:new Set(),cdps:new Map(),downloads:new WeakMap(),buttons:0}
      const add=(page:Page)=>{
        const id=asTab(++view.nextTab)
        view.tabs.set(id,page)
        page.on('download',download=>{void this.saveDownload(view,session,download).catch(()=>{})})
        page.once('close',()=>{
          view.tabs.delete(id)
          view.cdps.delete(page)
          if(view.active===id){view.active=view.tabs.keys().next().value;for(const changed of view.changed)changed()}
        })
        if(!view.active){view.active=id;for(const changed of view.changed)changed()}
      }
      for(const page of context.pages())add(page)
      context.on('page',add)
      if(!view.active)await context.newPage()
      return view
    }catch(error){await close().catch(()=>{});throw error}
  }

  private ready(session:DriverSession,create=false) {
    let pending=this.sessions.get(session.id)
    if(!pending&&(create||session.cdpPort)){
      const clear=()=>{if(this.sessions.get(session.id)===pending)this.sessions.delete(session.id)}
      pending=this.create(session).then(view=>{view.context.once('close',clear);return view}).catch(error=>{clear();throw error})
      this.sessions.set(session.id,pending)
    }
    if(!pending)throw new BrowserError('browser_missing','This browser session is closed.',404)
    return pending
  }

  private page(view:View,tab?:string){
    const page=view.tabs.get(tab??view.active??'')
    if(!page||page.isClosed())throw new BrowserError('browser_tab_missing','This tab has closed. Read the tab list again.',404)
    return page
  }

  private select(view:View,id:string){
    this.page(view,id)
    if(view.active===id)return
    view.active=id
    view.buttons=0
    for(const changed of view.changed)changed()
  }

  private saveDownload(view:View,session:DriverSession,download:Download){
    const active=view.downloads.get(download)
    if(active)return active
    const saved=(async()=>{
      const suggested=browserFilename.safeParse(download.suggestedFilename())
      const name=randomUUID().slice(0,8)+'-'+(suggested.success?suggested.data.slice(0,120):'download')
      const path=join(session.directory,'downloads',name)
      const temporary=path+'.crdownload'
      try{
        await download.saveAs(temporary)
        await rename(temporary,path)
        return {name}
      }catch(error){await rm(temporary,{force:true});throw error}
      finally{await download.delete().catch(()=>{})}
    })()
    view.downloads.set(download,saved)
    return saved
  }

  async run(session:DriverSession,[command,arg,value,extra]:string[],signal?:AbortSignal):Promise<any>{
    signal?.throwIfAborted()
    const view=await this.ready(session,command==='open')
    signal?.throwIfAborted()
    if(command==='tab'){
      if(arg==='list'){
        return {tabs:await Promise.all([...view.tabs].map(async([id,page],index)=>({
          tabId:id,index,url:page.url(),title:await page.title().catch(()=>''),active:id===view.active,
        })))}
      }
      if(arg==='new'){
        const page=await view.context.newPage()
        const id=[...view.tabs].find(([,item])=>item===page)?.[0]
        if(id)this.select(view,id)
        if(value&&value!=='about:blank')await page.goto(value,{waitUntil:'domcontentloaded',signal})
      }else if(arg==='close'){
        if(view.tabs.size===1)await view.context.newPage()
        await this.page(view,value).close()
      }else this.select(view,arg!)
      return {}
    }
    const page=this.page(view)
    switch(command){
      case 'open':
        if(page.url()!==arg||arg!=='about:blank')await page.goto(arg!,{waitUntil:'domcontentloaded',signal})
        return {}
      case 'snapshot':return {snapshot:await page.ariaSnapshot({mode:'ai',signal})}
      case 'get':return {title:await page.title()}
      case 'click':{
        const control=page.getByRef(arg!.replace(/^@/,''))
        const point=await actionPoint(view,page,control,signal)
        if(value!=='--download'){await control.click({signal});return {point}}
        const pending=page.waitForEvent('download',{signal})
        // An invalid ref must not leave a dangling rejected event promise.
        void pending.catch(()=>{})
        await control.click({signal})
        return {point,download:await this.saveDownload(view,session,await pending)}
      }
      case 'scrollintoview':await page.getByRef(arg!.replace(/^@/,'')).scrollIntoViewIfNeeded({signal});return {}
      case 'fill':{
        const control=page.getByRef(arg!.replace(/^@/,''))
        const point=await actionPoint(view,page,control,signal)
        await control.fill(value!,{signal})
        return {point}
      }
      case 'press':await page.keyboard.press(arg!);return {}
      case 'scroll':{
        const distance=Number(value)
        await page.mouse.wheel(arg==='right'?distance:arg==='left'?-distance:0,arg==='down'?distance:arg==='up'?-distance:0)
        return {}
      }
      case 'back':await page.goBack({waitUntil:'domcontentloaded',signal});return {}
      case 'forward':await page.goForward({waitUntil:'domcontentloaded',signal});return {}
      case 'reload':await page.reload({waitUntil:'domcontentloaded',signal});return {}
      case 'screenshot':await page.screenshot({path:arg,type:'png',fullPage:value==='--full',signal});return {}
      case 'set':await page.setViewportSize({width:Number(value),height:Number(extra)});return {}
      case 'upload':await page.locator(arg!).setInputFiles(value!,{signal});return {}
      default:throw new BrowserError('browser_action','Unsupported managed browser operation.',400)
    }
  }

  async evaluate(session:DriverSession,expression:string,signal?:AbortSignal){
    signal?.throwIfAborted()
    return this.page(await this.ready(session)).evaluate(expression)
  }

  async state(session:DriverSession,signal?:AbortSignal){
    signal?.throwIfAborted()
    return (await this.ready(session)).context.storageState({indexedDB:true})
  }

  async load(session:DriverSession,state:StorageState,signal?:AbortSignal){
    signal?.throwIfAborted()
    await (await this.ready(session)).context.setStorageState(state)
  }

  private channel(view:View,page:Page){
    let channel=view.cdps.get(page)
    if(!channel){
      channel=view.context.newCDPSession(page).catch(error=>{
        view.cdps.delete(page)
        throw error
      })
      view.cdps.set(page,channel)
    }
    return channel
  }

  private async detailedFrame(view:View,page:Page) {
    const channel=await this.channel(view,page)
    const {width,height,x,y,dpr,pinch}=await page.evaluate(()=>({
      width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,dpr:devicePixelRatio,pinch:visualViewport?.scale??1,
    }))
    if(![width,height,dpr].every(value=>Number.isFinite(value)&&value>0)||pinch!==1)return
    const scale=Math.min(2/dpr,detailPixels.width/(width*dpr),detailPixels.height/(height*dpr))
    if(scale<=0||scale*dpr<=1.05)return
    const {data}=await channel.send('Page.captureScreenshot',{
      format:'jpeg',quality:93,captureBeyondViewport:false,clip:{x,y,width,height,scale},
    })
    return {data,width,height}
  }

  async frames(session:DriverSession,callback:(frame:BrowserFrame)=>void,status?:(connected:boolean)=>void){
    const view=await this.ready(session)
    let sequence=0, generation=0
    let stop:Awaited<ReturnType<Screencast['start']>>|undefined
    let clearDetail: (()=>void)|undefined
    let queue=Promise.resolve()
    const switchPage=()=>{
      const target=++generation
      clearDetail?.()
      queue=queue.catch(()=>{}).then(async()=>{
        await stop?.dispose().catch(()=>{})
        stop=undefined
        if(target!==generation||!view.active)return
        const tab=view.active,page=this.page(view,tab)
        let timer:ReturnType<typeof setTimeout>|undefined
        let preview:{bytes:Buffer;width:number;height:number}|undefined
        let capturing=false
        clearDetail=()=>clearTimeout(timer)
        const scheduleDetail=()=>{
          clearTimeout(timer)
          timer=setTimeout(async()=>{
            timer=undefined
            if(target!==generation||capturing)return
            capturing=true
            const basedOn=preview
            try{
              const frame=await this.detailedFrame(view,page)
              if(target===generation&&basedOn===preview&&frame)
                callback({...frame,tab,detail:true,seq:++sequence,at:Date.now()})
            }catch{/* A transient capture failure leaves the live stream available. */}
            finally{
              capturing=false
              if(target===generation&&basedOn!==preview&&!timer)scheduleDetail()
            }
          },detailDelayMs)
          timer.unref()
        }
        const emit=(bytes:Buffer,width:number,height:number)=>{
          if(target!==generation)return
          if(preview?.width===width&&preview.height===height&&preview.bytes.equals(bytes))return
          preview={bytes,width,height}
          callback({data:bytes.toString('base64'),width,height,tab,seq:++sequence,at:Date.now()})
          scheduleDetail()
        }
        // A blank or static tab may not produce a damage frame immediately.
        const size=page.viewportSize()??await page.evaluate(()=>({width:innerWidth,height:innerHeight}))
        emit(await page.screenshot({type:'jpeg',quality:75,scale:'css'}),size.width,size.height)
        if(target!==generation)return
        stop=await page.screencast.start({quality:80,size:{width:1920,height:1200},onFrame:frame=>{
          emit(frame.data,frame.viewportWidth,frame.viewportHeight)
        }})
        if(target===generation)status?.(true)
      })
      return queue
    }
    const refresh=()=>{void switchPage().catch(()=>status?.(false))}
    view.changed.add(refresh)
    try {await switchPage()}
    catch(error){view.changed.delete(refresh);throw error}
    return ()=>{
      view.changed.delete(refresh)
      generation++
      clearDetail?.()
      void queue.catch(()=>{}).then(()=>stop?.dispose()).catch(()=>{})
      status?.(false)
    }
  }

  async record(session:DriverSession,tab:string,path:string,signal:AbortSignal){
    const view=await this.ready(session)
    await prepareScreencastEncoder()
    signal.throwIfAborted()
    const cast=await this.page(view,tab).screencast.start({path, fps:25, size:{width:1280,height:800}})
    return ()=>cast.dispose()
  }

  async input(session:DriverSession,event:BrowserInput){
    const view=await this.ready(session), page=this.page(view)
    if(event.type==='text'){await page.keyboard.insertText(event.text);return}
    const channel=await this.channel(view,page)
    for(const message of inputMessages(event)){
      if(message.type==='input_keyboard'){
        const {type,eventType,...params}=message
        await channel.send('Input.dispatchKeyEvent',{...params,type:eventType})
        continue
      }
      const {type,eventType,...params}=message
      const bit=params.button==='left'?1:params.button==='right'?2:params.button==='middle'?4:0
      if(eventType==='mousePressed')view.buttons|=bit
      if(eventType==='mouseReleased')view.buttons&=~bit
      await channel.send('Input.dispatchMouseEvent',{...params,type:eventType,buttons:view.buttons})
    }
  }

  async close(session:DriverSession){
    const view=this.sessions.get(session.id)
    this.sessions.delete(session.id)
    if(view)await (await view).close()
  }

  async shutdown(){
    this.stopping=true
    await Promise.allSettled([...this.sessions.values()].map(async view=>(await view).close()))
    this.sessions.clear()
    await (await this.shared?.catch(()=>undefined))?.close()
  }
}
