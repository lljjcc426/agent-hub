import {expect,it} from 'vitest'
import {withCodeMode} from '../src/code-mode.ts'
import type {ModelRequest} from '../src/model.ts'

const spec=(name:string)=>({type:'function' as const,name,description:name,inputSchema:{
  type:'object',additionalProperties:false,required:['n'],properties:{n:{type:'integer'}},
}})
const reply=(text:string)=>({success:true,contentItems:[{type:'inputText' as const,text}]})
const request=(extra:Partial<ModelRequest>={}):ModelRequest=>({
  cwd:process.cwd(),input:'fixture',instructions:'',schema:{},role:'router',managed:true,allowNativeTools:true,
  tools:[spec('router_read'),spec('write_marker'),spec('chat_opening')],
  onTool:async(_name,args)=>reply(JSON.stringify(args)),
  ...extra,
})
const execute=(source:string,extra?:Partial<ModelRequest>)=>withCodeMode(request(extra)).onTool!('code_mode',{source},'fixture')

it('composes host tools with a 32-read window, an exclusive write, and stable call IDs',async()=>{
  const started:{name:string;id:string}[]=[],completed:string[]=[]
  let release!:()=>void,full!:()=>void
  const barrier=new Promise<void>(resolve=>{release=resolve}),atLimit=new Promise<void>(resolve=>{full=resolve})
  const run=execute(`
    const calls = Array.from({length:33}, (_, n) => tools.router_read({n}));
    calls.push(tools.write_marker({n:100}));
    calls.push(tools.router_read({n:101}));
    return (await Promise.all(calls)).map(r => JSON.parse(r.contentItems[0].text).n);
  `,{onTool:async(name,args,id)=>{
    started.push({name,id})
    if(started.length===32)full()
    if(name==='router_read'&&(args as {n:number}).n<33)await barrier
    if(name==='write_marker')expect(completed).toHaveLength(33)
    if((args as {n:number}).n===101)expect(completed.at(-1)).toBe('write_marker')
    completed.push(name)
    return reply(JSON.stringify(args))
  }})
  try{
    await Promise.race([run,atLimit])
    expect(started).toHaveLength(32)
    expect(started.every(call=>call.name==='router_read')).toBe(true)
  }finally{release()}
  expect(await run).toEqual(reply(JSON.stringify([...Array.from({length:33},(_,i)=>i),100,101])))
  expect(new Set(started.map(call=>call.id)).size).toBe(35)
})

it('limits nested calls to the granted tool set, validated arguments, and the host call budget',async()=>{
  const seen:unknown[]=[]
  const result=await execute(`
    const invalid = await tools.router_read({n:"invalid"});
    const good = await tools.router_read({n:1});
    const over = await tools.router_read({n:2});
    return [Object.keys(tools), [invalid.success, good.success, over.success],
      [typeof process, typeof require, typeof fetch, typeof WebSocket]];
  `,{options:{tools:['router_read','code_mode'],maxToolCalls:2},tools:[spec('router_read'),spec('chat_opening')],
    onTool:async(_name,args)=>{seen.push(args);return reply('ok')}})
  expect(result).toEqual(reply(JSON.stringify([['router_read'],[false,true,false],['undefined','undefined','undefined','undefined']])))
  expect(seen).toEqual([{n:1}])
  for(const extra of [{options:{tools:['router_read']}},{role:'subagent' as const},{ephemeral:true}]){
    expect(withCodeMode(request(extra)).tools?.map(tool=>tool.name)).not.toContain('code_mode')
  }
})

it('interrupts an unbounded calculation and rejects unawaited tool work before effects',async()=>{
  expect(await execute('while (true) {}')).toMatchObject({success:false})
  let effects=0
  expect(await execute('tools.write_marker({n:1}); return 42',{onTool:async()=>{effects++;return reply('effect')}})).toMatchObject({success:false})
  expect(effects).toBe(0)
})

it('stops queued mutations when the request is cancelled and drains admitted reads',async()=>{
  const signal=new AbortController(),names:string[]=[]
  let entered!:()=>void,finish!:()=>void
  const started=new Promise<void>(resolve=>{entered=resolve}),read=new Promise<void>(resolve=>{finish=resolve})
  const run=execute('return Promise.all([tools.router_read({n:1}),tools.write_marker({n:2})])',{
    signal:signal.signal,onTool:async(name)=>{
      names.push(name)
      entered()
      await read
      return reply('read')
    },
  })
  await started
  signal.abort(Error('Turn cancelled'))
  finish()
  await expect(run).rejects.toThrow('Turn cancelled')
  expect(names).toEqual(['router_read'])
})
