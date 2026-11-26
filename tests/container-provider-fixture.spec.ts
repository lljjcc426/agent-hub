import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {runInNewContext} from 'node:vm'
import {Ajv} from 'ajv'
import {expect,it} from 'vitest'
import {reportSchema} from '../src/schemas.ts'
import {ApiModel,type ThreadStore} from '../src/backends/api.ts'
import {backendDefinition,type ApiDefinition} from '../src/backend-config.ts'

function fixtureHandler(){
 let handler:any
 const source=readFileSync(new URL('../examples/container-provider-fixture.mjs',import.meta.url),'utf8').replace(/^import .*$/gm,'')
 runInNewContext(source,{Buffer,createHash,createServer:(fn:any)=>{handler=fn;return {listen(){}}},appendFileSync(){},readFileSync(){return '0'}})
 return handler
}

it('emits a production-schema-valid ready report after the managed shell result',async()=>{
 let response:any
 // Execute the actual deterministic fixture without opening a port or writing its log.
 const handler=fixtureHandler()
 const body=JSON.stringify({model:'container-worker',messages:[{role:'tool',tool_call_id:'shell-read',content:'2\n'}]})
 await handler({async *[Symbol.asyncIterator](){yield Buffer.from(body)}},{writeHead(){},end(value:string){response=JSON.parse(value)}})
 const result=JSON.parse(response.choices[0].message.content),validate=new Ajv({strict:false}).compile(reportSchema)
 expect(validate(result),JSON.stringify(validate.errors)).toBe(true)
 expect(result).toMatchObject({state:'ready',reply:'2',question:null,askedBy:null,decision:null,handbacks:[]})
})

it.each(['router','worker'])('streams the %s tool call and final reply through the real API parser',async role=>{
 const server=createServer(fixtureHandler())
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{
  const records=new Map<string,any>(),store:ThreadStore={get:(kind,id)=>records.get(kind+':'+id),put:(kind,id,value)=>{records.set(kind+':'+id,value)}}
  const definition=backendDefinition.parse({kind:'openai-chat',baseUrl:'http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1',model:'container-'+role}) as ApiDefinition
  const model=new ApiModel('container-fixture',definition,store,3000)
  const name=role==='worker'?'roppo_superagent_shell':'roppo_worker_manage',calls:string[]=[]
  const result=await model.run({cwd:tmpdir(),instructions:'Exercise the container protocol fixture',input:'Read input.txt',managed:true,
   schema:role==='worker'?reportSchema:{type:'object',properties:{reply:{type:'string'}},required:['reply']},
   tools:[{type:'function',name,description:'Container acceptance tool',inputSchema:{type:'object',properties:{}}}],
   onTool:async tool=>{calls.push(tool);return {success:true,contentItems:[{type:'inputText',text:'2\n'}]}}
  })
  expect(calls).toEqual([name])
  expect(JSON.parse(result.text)).toMatchObject(role==='worker'?{state:'ready',reply:'2'}:{reply:''})
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
