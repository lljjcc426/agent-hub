import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {runInNewContext} from 'node:vm'
import {Ajv} from 'ajv'
import {expect,it} from 'vitest'
import {reportSchema} from '../src/schemas.ts'

async function request(input:unknown){
 let handler:any,type='',body=''
 // Execute the actual deterministic fixture without opening a port or writing its log.
 const source=readFileSync(new URL('../examples/container-provider-fixture.mjs',import.meta.url),'utf8').replace(/^import .*$/gm,'')
 runInNewContext(source,{Buffer,createHash,createServer:(fn:any)=>{handler=fn;return {listen(){}}},appendFileSync(){},readFileSync:()=> '1'})
 await handler({async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(input))}},{
  writeHead(_status:number,headers:Record<string,string>){type=headers['content-type']!},
  write(chunk:string){body+=chunk},end(chunk:string){body+=chunk},
 })
 return {type,body}
}

it('emits a production-schema-valid ready report after the managed shell result',async()=>{
 const {type,body}=await request({model:'container-worker',messages:[{role:'tool',tool_call_id:'shell-read',content:'2\n'}]})
 expect(type).toBe('application/json')
 const response=JSON.parse(body)
 const result=JSON.parse(response.choices[0].message.content),validate=new Ajv({strict:false}).compile(reportSchema)
 expect(validate(result),JSON.stringify(validate.errors)).toBe(true)
 expect(result).toMatchObject({state:'ready',reply:'2',question:null,askedBy:null,decision:null,handbacks:[]})
})

it.each([['container-router','roppo_worker_manage'],['container-worker','roppo_superagent_shell']])('streams the advertised tool to %s',async(model,name)=>{
 const {type,body}=await request({model,stream:true,messages:[{role:'user',content:'Verify the file'}],tools:[{function:{name}}]})
 expect(type).toBe('text/event-stream')
 const frames=body.trim().split('\n\n').map(line=>line.slice('data: '.length))
 expect(frames.pop()).toBe('[DONE]')
 const [call,end]=frames.map(line=>JSON.parse(line).choices[0])
 expect(call.delta.tool_calls[0]).toMatchObject({index:0,function:{name}})
 expect(end.finish_reason).toBe('tool_calls')
})
