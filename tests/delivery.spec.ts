import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect} from 'vitest'
import {configSchema} from '../src/config.ts'
import {GithubSource} from '../src/connectors/github.ts'
import {Store} from '../src/store.ts'
import {execFileSync} from 'node:child_process'
import {deliverDraft,prepareDraft} from '../src/delivery.ts'
it('rejects a hidden alternate push URL before staging, committing or pushing anything',async()=>{
 const root=mkdtempSync(join(tmpdir(),'delivery-fence-')),bin=join(root,'bin'),log=join(root,'git-log'),path=process.env.PATH;mkdirSync(bin)
 writeFileSync(join(bin,'git'),'#!'+process.execPath+'\nconst fs=require("node:fs"),args=process.argv.slice(2);fs.appendFileSync('+JSON.stringify(log)+',JSON.stringify(args)+"\\n");if(args.includes("--push"))console.log("https://github.com/other/repo.git");else if(args.includes("get-url"))console.log("https://github.com/owner/repo.git");else process.exit(3)\n',{mode:0o700})
 process.env.PATH=bin+':'+path
 const config=configSchema.parse({stateDir:join(root,'state'),sources:[{id:'github',kind:'github',repository:'owner/repo',cwd:root}]}),store=new Store(join(root,'state.sqlite')),source=new GithubSource(config.sources[0]!)
 store.tickets.save({id:'task',mandate:{actor:{source:'github'}}} as any);store.put('run','task',{ticketId:'task',assignmentId:'a',cwd:root,phase:'idle'})
 try{
  await expect(deliverDraft({store,sources:new Map([['github',source]])} as any,'task','github','Test','Test')).rejects.toThrow('Push destination')
  const calls=readFileSync(log,'utf8').trim().split('\n').map(x=>JSON.parse(x));expect(calls).toHaveLength(2);expect(calls.every(a=>a.includes('get-url'))).toBe(true)
  expect(store.get<any>('run','task').phase).toBe('idle')
 }finally{process.env.PATH=path;store.close();rmSync(root,{recursive:true,force:true})}
})

it('freezes a dirty draft locally, rejects later edits and pushes only the reviewed commit',async()=>{
 const root=mkdtempSync(join(tmpdir(),'reviewed-draft-')),cwd=join(root,'work'),remote=join(root,'remote.git')
 mkdirSync(cwd)
 const git=(...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
 git('init','--bare',remote);git('init','-b','superagent/reviewed')
 git('config','user.email','fixture@example.test');git('config','user.name','Test')
 git('remote','add','origin',remote);git('commit','--allow-empty','-m','Initial')
 const config=configSchema.parse({stateDir:join(root,'state'),sources:[{id:'repo',kind:'github',repository:'owner/repo',cwd}]})
 const store=new Store(join(root,'state.sqlite')),base=new GithubSource(config.sources[0]!)
 const source=Object.create(base)
 Object.defineProperty(source,'code',{value:{id:'local-repo',remotes:[remote],threadPrefix:'pull/',pushCredential:{kind:'helper',command:'true',args:[]}}})
 let opened=0,fenced=0
 source.draft=async()=>{opened++;return {number:1,html_url:'https://example.test/pull/1',draft:true}}
 source.validThread=()=>true
 store.tickets.save({id:'task',mandate:{actor:{source:'repo'}},assignments:[{id:'a'}]} as any)
 store.put('run','task',{ticketId:'task',assignmentId:'a',cwd,phase:'starting'})
 const host={store,sources:new Map([['repo',source]]),config,validWork:()=>true,canWrite:()=>true,merger:{beforePush:async()=>{fenced++}},engine:{bindThread(){}}} as any
 try{
   writeFileSync(join(cwd,'notes.md'),'Ready\n')
   const reviewed=await prepareDraft(host,'task','repo','Update release notes','a')
   expect(git('show',reviewed.sha+':notes.md')).toBe('Ready')
   expect(git('ls-remote','origin')).toBe('')
   expect([fenced,opened]).toEqual([0,0])
   writeFileSync(join(cwd,'notes.md'),'Another change\n')
   await expect(deliverDraft(host,'task','repo','Update release notes','Notes','a',reviewed)).rejects.toThrow('changed')
   expect(git('ls-remote','origin')).toBe('')
   git('restore','notes.md')
   const receipt=await deliverDraft(host,'task','repo','Update release notes','Notes','a',reviewed)
   expect(receipt.sha).toBe(reviewed.sha)
   expect(git('ls-remote','origin','refs/heads/superagent/reviewed').split(/\s+/)[0]).toBe(reviewed.sha)
   await deliverDraft(host,'task','repo','Update release notes','Notes','a',reviewed)
   expect([fenced,opened]).toEqual([1,1])
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
