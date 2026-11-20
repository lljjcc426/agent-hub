import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it} from 'vitest'
import {configSchema} from '../src/config.ts'
import {FeishuSource} from '../src/connectors/feishu.ts'
import {Runtime} from '../src/runtime.ts'
import type {SourceContext} from '../src/sources.ts'
import type {Trigger} from '../src/vendor/dsh-core/index.ts'

const cleanups:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup()})

async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'roppo-feishu-inbox-'))
  const config=configSchema.parse({stateDir:join(root,'state'),acceptMode:'off',work:{sandboxDriver:'disabled',network:false},
    execution:{router:{mode:'host'}},sources:[
      {id:'feishu',kind:'feishu',cwd:root,allowedActors:['ou_alice'],
        feishu:{cli:'fixture',chats:['oc_one','oc_two'],mentionId:'ou_bot',directMessages:true}},
    ]})
  const model={async run(){return {threadId:'local-test',turnId:'one',text:'{"reply":""}'}}}
  let now=Date.now()
  const native=new Map<string,Record<string,unknown>>()
  let polled:string[]=[]
  let host:Runtime,source:FeishuSource,context:SourceContext
  async function connect(){
    source=new FeishuSource(config.sources[0]!,async(_method,path)=>{
      if(path==='bot/v3/info')return {bot:{open_id:'ou_bot'}}
      if(path.startsWith('im/v1/messages/'))return {items:[native.get(path.split('/').at(-1)!)]}
      const chat=new URLSearchParams(path.split('?')[1]).get('container_id')
      return {items:polled.map(id=>native.get(id)!).filter(item=>item.chat_id===chat),has_more:false}
    })
    const ready=new Promise<SourceContext>(resolve=>{source.start=resolve})
    host=new Runtime(config,{model,sources:[source],clock:()=>now})
    await host.pollSources()
    context=await ready
    await new Promise<void>(resolve=>setImmediate(resolve))
  }
  cleanups.push(async()=>{await host?.close();rmSync(root,{recursive:true,force:true})})
  await connect()
  async function live(id:string,chat='oc_one',fields:Record<string,unknown>={}){
    native.set(id,{message_id:id,chat_id:chat,chat_type:'group',create_time:String(now),
      sender:{id:'ou_alice',sender_type:'user'},body:{content:JSON.stringify({text:id})},...fields})
    await source.receiveEvent({type:'im.message.receive_v1',chat_id:chat,message_id:id,
      chat_type:fields.chat_type??'group'},context)
  }
  return {get host(){return host},live,advance:(ms:number)=>{now+=ms},
    async poll(...ids:string[]){polled=ids;try{await source.poll(context)}finally{polled=[]}},
    async restart(){await host.close();await connect()},
    received:()=>host.store.list<Trigger>('trigger').map(trigger=>trigger.meta.messageId),
    pending:()=>host.store.list('feishu-group-inbox'),
  }
}

it('submits five messages from one group immediately, sharing the live and polling inbox',async()=>{
  const f=await fixture()
  await f.live('om_other','oc_two')
  for(let n=1;n<=4;n++)await f.live('om_'+n)
  await f.poll('om_1','om_2')
  expect(f.received()).toEqual([])
  expect(f.pending()).toHaveLength(2)
  await f.live('om_5','oc_one',{sender:{id:'ou_bob',sender_type:'user'}})
  expect(f.received()).toEqual(['om_1','om_2','om_3','om_4','om_5'])
  expect(f.pending()).toHaveLength(1)
  await f.poll('om_4','om_5')
  expect(f.pending()).toHaveLength(1)
  expect(f.received()).toHaveLength(5)
  expect(f.host.store.deliveries()).toEqual([])
})

it('waits two minutes from the first message across a restart and leaves an empty inbox idle',async()=>{
  const f=await fixture()
  await f.host.tick()
  expect(f.pending()).toEqual([])
  expect(f.received()).toEqual([])
  await f.live('om_first')
  f.advance(95_000)
  await f.live('om_next')
  await f.restart()
  f.advance(24_999)
  await f.host.tick()
  expect(f.received()).toEqual([])
  f.advance(1)
  await f.host.tick()
  expect(f.received()).toEqual(['om_first','om_next'])
  expect(f.pending()).toEqual([])
  f.advance(240_000)
  await f.host.tick()
  expect(f.received()).toHaveLength(2)
  expect(f.host.store.deliveries()).toEqual([])
})

it('keeps addressed requests and topic replies immediate and drops recalled pending messages',async()=>{
  const f=await fixture()
  await f.live('om_pending')
  await f.live('om_pending','oc_one',{deleted:true,update_time:String(Date.now()+2000)})
  await f.live('om_direct','oc_one',{mentions:[{id:'ou_bot'}]})
  await f.live('om_topic','oc_one',{root_id:'om_root'})
  expect(f.received()).toEqual(['om_direct','om_topic'])
  f.advance(120_000)
  await f.host.tick()
  expect(f.received()).toEqual(['om_direct','om_topic'])
  expect(f.pending()).toEqual([])
})
