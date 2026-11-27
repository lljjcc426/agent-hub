import {existsSync} from 'node:fs'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {chromium} from 'playwright-core'
import {expect,it} from 'vitest'
import {browserConfigSchema,type BrowserFrame} from '../src/browser-contract.ts'
import {ManagedBrowserDriver} from '../src/managed-browser-driver.ts'

const executablePath=chromium.executablePath()

it.skipIf(!existsSync(executablePath)).each(['managed','attached'] as const)('streams live repaints at a stable density across viewport and tab changes (%s)',async mode=>{
  const directory=await mkdtemp(join(tmpdir(),'roppo-page-fit-'))
  const driver=new ManagedBrowserDriver(browserConfigSchema.parse({executablePath}))
  const profile=join(directory,'external')
  const external=mode==='attached'?await chromium.launchPersistentContext(profile,{executablePath,args:['--remote-debugging-port=0']}):undefined
  const cdpPort=external?Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]):undefined
  const session={id:'viewport-test',directory:join(directory,'managed'),persistent:true,cdpPort}
  const documentUrl='data:text/html,<meta name="viewport" content="width=device-width"><h1>Responsive page</h1>'
  const measure=()=>driver.evaluate(session,'[innerWidth,innerHeight,matchMedia("(min-width:800px)").matches]')
  let stop:(()=>void)|undefined
  try{
    await driver.run(session,['open',documentUrl])
    let detail:unknown
    const samples:BrowserFrame[]=[]
    stop=await driver.frames(session,frame=>{
      if(frame.detail)detail=[frame.tab,frame.width,frame.height]
      if(frame.width===410&&frame.height===731)samples.push(frame)
    })
    await driver.run(session,['set','viewport','410','731'])
    await expect.poll(()=>detail,{timeout:6000}).toEqual(['t1',410,731])
    expect(await measure()).toEqual([410,731,false])
    samples.length=0
    // A caret-sized repaint used to replace the whole page with a 1x JPEG on every blink.
    await driver.evaluate(session,`new Promise(resolve=>{
      const mark=document.createElement('i')
      mark.style.cssText='position:fixed;left:10px;top:10px;width:12px;height:12px;background:black;opacity:0'
      document.body.append(mark)
      let ticks=0
      const timer=setInterval(()=>{
        mark.style.opacity=String(++ticks%2)
        if(ticks===6){clearInterval(timer);resolve(true)}
      },350)
    })`)
    await expect.poll(()=>samples.length,{timeout:2000}).toBeGreaterThanOrEqual(4)
    // Read actual JPEG pixels, independently of the stream's CSS coordinate metadata.
    const rendered=await driver.evaluate(session,`Promise.all(${JSON.stringify(samples.map(f=>f.data))}.map(async data=>{
      const img=new Image()
      img.src='data:image/jpeg;base64,'+data
      await img.decode()
      const canvas=document.createElement('canvas')
      canvas.width=canvas.height=1
      const ctx=canvas.getContext('2d')
      ctx.drawImage(img,15*img.naturalWidth/410,15*img.naturalHeight/731,1,1,0,0,1,1)
      return {width:img.naturalWidth,height:img.naturalHeight,light:ctx.getImageData(0,0,1,1).data[0]}
    }))`) as {width:number;height:number;light:number}[]
    expect(rendered.every(f=>f.width===820&&f.height===1462)).toBe(true)
    expect(rendered.some(f=>f.light<20)).toBe(true)
    expect(rendered.some(f=>f.light>235)).toBe(true)

    await driver.run(session,['tab','new',documentUrl])
    expect(await measure()).toEqual([410,731,false])
    await driver.run(session,['set','viewport','1030','614'])
    await expect.poll(()=>detail,{timeout:6000}).toEqual(['t2',1030,614])
    expect(await measure()).toEqual([1030,614,true])
    await driver.run(session,['tab','t1'])
    await expect.poll(()=>detail,{timeout:6000}).toEqual(['t1',1030,614])
    expect(await measure()).toEqual([1030,614,true])
  }finally{
    stop?.()
    await driver.shutdown()
    await external?.close()
    await rm(directory,{recursive:true,force:true})
  }
},25000)
