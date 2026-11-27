import {existsSync} from 'node:fs'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {chromium} from 'playwright-core'
import {expect,it} from 'vitest'
import {browserConfigSchema} from '../src/browser-contract.ts'
import {ManagedBrowserDriver} from '../src/managed-browser-driver.ts'

const executablePath=chromium.executablePath()

it.skipIf(!existsSync(executablePath))('keeps the CSS viewport when capturing detail frames and opening or switching pages',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'roppo-page-fit-'))
  const driver=new ManagedBrowserDriver(browserConfigSchema.parse({executablePath}))
  const session={id:'viewport-test',directory,persistent:true}
  const documentUrl='data:text/html,<meta name="viewport" content="width=device-width"><h1>Responsive page</h1>'
  const measure=()=>driver.evaluate(session,'[innerWidth,innerHeight,matchMedia("(min-width:800px)").matches]')
  let stop:(()=>void)|undefined
  try{
    await driver.run(session,['open',documentUrl])
    let detail:unknown
    stop=await driver.frames(session,frame=>{if(frame.detail)detail=[frame.tab,frame.width,frame.height]})
    await driver.run(session,['set','viewport','410','731'])
    await expect.poll(()=>detail,{timeout:6000}).toEqual(['t1',410,731])
    expect(await measure()).toEqual([410,731,false])

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
    await rm(directory,{recursive:true,force:true})
  }
},25000)
