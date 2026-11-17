import {afterEach,expect,it} from 'vitest'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {Runtime} from '../src/runtime.ts'
import {configSchema} from '../src/config.ts'
import {serve} from '../src/server.ts'
import {isReaction,messageText} from '../src/chat-interactions.ts'
import type {ModelRequest} from '../src/model.ts'
const roots:string[]=[],hosts:Runtime[]=[],servers:Awaited<ReturnType<typeof serve>>[]=[]
afterEach(async()=>{for(const s of servers.splice(0)){s.server.closeAllConnections();await new Promise<void>(resolve=>s.server.close(()=>resolve()))}for(const h of hosts.splice(0))await h.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})})
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'chat-interactions-'));roots.push(root)
 const config=configSchema.parse({stateDir:join(root,'state'),port:0,work:{sandboxDriver:'disabled'},execution:{router:{mode:'host',label:'Roppo'},management:{enabled:true},workers:[{id:'reader',label:'Reader',backend:'codex'}]},sources:[{id:'local',kind:'local',cwd:root,allowedActors:['operator']}]})
 const calls:ModelRequest[]=[],model={async run(r:ModelRequest){calls.push(r);return {threadId:randomUUID(),turnId:randomUUID(),text:JSON.stringify({reply:'The **boundary** is `A😀B`.\n\nKeep the emoji intact.'})}}}
 const h=new Runtime(config,{model});hosts.push(h)
 h.scopes.command({action:'scope.put',operationId:'external',expectedRevision:0,scope:{id:'external',tenantId:'external',name:'External',managers:[JSON.stringify(['local','operator'])],workerIds:['reader'],backendIds:['codex'],sourceIds:['local']}})
 return {h,config,model,calls}
}
async function settle(h:Runtime){for(let i=0;i<500;i++){await h.tick();await new Promise(resolve=>setTimeout(resolve,2));if(h.store.db.prepare("SELECT 1 FROM jobs WHERE state IN ('pending','running')").get())continue;return}throw Error('Did not settle')}
it('delivers a selected quote as attributed background, preserves it on model restart, and keeps the new mandate separate',async()=>{
 const f=fixture(),c=f.h.chat.space('owner',true).conversation!
 f.h.chat.send(c.id,'owner',{text:'Check the Unicode boundary',clientMessageId:randomUUID()});await settle(f.h)
 const source=f.h.chat.view(c.id,'owner').messages.at(-1)!
 const input={text:'Explain this part',clientMessageId:randomUUID(),quote:{messageId:source.id,excerpt:'boundary is A😀B.'}}
 const sent=f.h.chat.send(c.id,'owner',input)
 expect(f.h.chat.send(c.id,'owner',input).duplicate).toBe(true)
 expect(()=>f.h.chat.send(c.id,'owner',{...input,quote:{messageId:source.id}})).toThrow('different content')
 await settle(f.h)
 const request=JSON.parse(f.calls.at(-1)!.input)
 expect(request.trigger.text).toBe(input.text)
 expect(request.quotedMessage).toMatchObject({messageId:source.id,role:'assistant',label:'Roppo',text:'boundary is A😀B.'})
 expect(request.continuity.history.find((item:any)=>item.triggerIds.includes(sent.runId)).quotedMessages[0].messageId).toBe(source.id)
 expect(f.h.chat.history(sent.runId).find(m=>m.text===input.text)?.quotedMessage?.text).toBe('boundary is A😀B.')
 await f.h.close();hosts.splice(hosts.indexOf(f.h),1)
 const h=new Runtime(f.config,{model:f.model});hosts.push(h)
 h.updateSettings(h.settings.current().revision,{execution:{...h.config.execution,router:{...h.config.execution.router,model:'another-model',label:'New name'}}})
 h.chat.send(c.id,'owner',{text:'Continue from my quote',clientMessageId:randomUUID()});await settle(h)
 const rebuilt=JSON.parse(f.calls.at(-1)!.input)
 expect(rebuilt.continuity.mode).toBe('rebuild')
 expect(rebuilt.continuity.history.find((item:any)=>item.triggerIds.includes(sent.runId)).quotedMessages[0]).toMatchObject({label:'New name',text:'boundary is A😀B.'})
})
it('checks quote ownership and exact selected content, while resolving old messages outside the latest page',async()=>{
 const {h}=fixture(),c=h.chat.create('owner'),other=h.chat.create('another-owner')
 const seed=h.chat.send(c.id,'owner',{text:'Seed',clientMessageId:randomUUID()});h.chat.reply('source',seed.runId,'**Relevant** code: `A😀B`.')
 const source=h.chat.view(c.id,'owner').messages.at(-1)!,send=(quote:any)=>h.chat.send(c.id,'owner',{text:'Explain',clientMessageId:randomUUID(),quote})
 expect(()=>send({messageId:source.id,excerpt:'Invented authorization'})).toThrow('selected text')
 expect(()=>h.chat.send(other.id,'another-owner',{text:'Explain',clientMessageId:randomUUID(),quote:{messageId:source.id}})).toThrow('no longer available')
 const sent=send({messageId:source.id,excerpt:'Relevant code: A😀B.'})
 const large='Long message. '.repeat(900);h.chat.reply('large',seed.runId,large)
 const full=send({messageId:'reply:large'});expect(h.chat.quoteForTrigger(full.runId)?.text).toBe(large.trim())
 for(let i=0;i<130;i++)h.chat.reply('history-'+i,seed.runId,'Reply '+i)
 expect(h.chat.view(c.id,'owner').messages.some(m=>m.id===source.id)).toBe(false)
 const around=h.chat.view(c.id,'owner',undefined,undefined,source.id)
 expect(around.messages.some(m=>m.id===source.id)).toBe(true);expect(around.hasLater).toBe(true)
 expect(()=>h.chat.view(c.id,'another-owner',undefined,undefined,source.id)).toThrow('not found')
 h.store.db.prepare("DELETE FROM records WHERE kind='chat-message' AND id=?").run(source.id)
 expect(h.chat.quoteForTrigger(sent.runId)).toMatchObject({text:'',unavailable:true})
})
it('persists idempotent reactions across streaming and restart, never enqueues work, and clears them with Chat reset',async()=>{
 const f=fixture(),c=f.h.chat.space('owner',true).conversation!,sent=f.h.chat.send(c.id,'owner',{text:'Hello',clientMessageId:randomUUID()})
 const messageId='user:'+sent.runId,before=f.h.store.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n
 const input={messageId,emoji:'👩🏽‍💻',active:true}
 expect(f.h.chat.react(c.id,'owner',input).reactions).toEqual(['👩🏽‍💻'])
 expect(f.h.chat.react(c.id,'owner',input).reactions).toEqual(['👩🏽‍💻'])
 expect(f.h.store.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n).toBe(before)
 expect(()=>f.h.chat.react(c.id,'other',input)).toThrow('not found')
 expect(()=>f.h.chat.react(c.id,'owner',{...input,emoji:'execute ✅'})).toThrow('single emoji')
 f.h.chat.output('stream',sent.runId,{id:'s',phase:'answer',type:'delta',text:'{"reply":"Partial'})
 await new Promise(resolve=>setTimeout(resolve,90))
 f.h.chat.react(c.id,'owner',{messageId:'reply:stream',emoji:'👍',active:true});f.h.chat.reply('stream',sent.runId,'Final')
 expect(f.h.chat.view(c.id,'owner').messages.find(m=>m.id==='reply:stream')?.reactions).toEqual(['👍'])
 await f.h.close();hosts.splice(hosts.indexOf(f.h),1)
 const h=new Runtime(f.config,{model:f.model});hosts.push(h)
 expect(h.chat.view(c.id,'owner').messages.find(m=>m.id===messageId)?.reactions).toEqual(['👩🏽‍💻'])
 expect(h.chat.react(c.id,'owner',{...input,active:false}).reactions).toEqual([])
 h.chat.reset('owner',randomUUID());expect(()=>h.chat.react(c.id,'owner',input)).toThrow()
})
it('exposes the mutations through the authenticated same-origin Chat API',async()=>{
 const {h}=fixture(),server=await serve(h);servers.push(server)
 const headers={authorization:'Bearer '+readFileSync(server.tokenPath,'utf8').trim(),'content-type':'application/json'},c=h.chat.create('local-operator'),sent=h.chat.send(c.id,'local-operator',{text:'Original',clientMessageId:randomUUID()}),url=server.url+'/api/chat/conversations/'+c.id
 const reaction={messageId:'user:'+sent.runId,emoji:'👍',active:true}
 expect((await fetch(url+'/reactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(reaction)})).status).toBe(401)
 expect((await fetch(url+'/reactions',{method:'POST',headers:{...headers,origin:'https://elsewhere.example'},body:JSON.stringify(reaction)})).status).toBe(403)
 expect((await fetch(url+'/reactions',{method:'POST',headers,body:JSON.stringify(reaction)})).status).toBe(200)
 const quote={messageId:reaction.messageId,excerpt:'Original'}
 const response=await fetch(url+'/messages',{method:'POST',headers,body:JSON.stringify({text:'Reply',clientMessageId:randomUUID(),quote})})
 expect(response.status).toBe(202)
 const snapshot=await (await fetch(url,{headers})).json() as any
 expect(snapshot.messages.find((m:any)=>m.text==='Reply').quote).toMatchObject({messageId:reaction.messageId,role:'user',text:'Original'})
})
it('matches rendered Markdown selection including code, links, lists, tables and joined emoji',()=>{
 expect(messageText('**Bold** and [link](https://example.com)\n\n- `A😀B`\n- second\n\n| A | B |\n| - | - |\n| 1 | 2 |')).toContain('Bold and link')
 for(const emoji of ['👍','❤️','👩🏽‍💻','🇨🇳','1️⃣'])expect(isReaction(emoji)).toBe(true)
 for(const value of ['hello','👍👍','', '✅ approved'])expect(isReaction(value)).toBe(false)
})
