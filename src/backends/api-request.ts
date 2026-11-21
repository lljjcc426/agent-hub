import type {ApiDefinition} from '../backend-config.ts'

export function apiHeaders(d:Pick<ApiDefinition,'kind'|'apiKeyEnv'|'headers'|'headerEnv'>,token?:string){
 const credential=token??(d.apiKeyEnv?process.env[d.apiKeyEnv]:undefined)
 if(d.apiKeyEnv&&!credential?.trim())throw Error('API credential unavailable')
 const headers:Record<string,string>={...d.headers}
 for(const [key,ref] of Object.entries(d.headerEnv??{})){
  if(!process.env[ref])throw Error('Missing header environment variable '+ref)
  headers[key]=process.env[ref]!
 }
 headers['content-type']='application/json'
 if(d.kind==='anthropic'){headers['anthropic-version']='2023-06-01';if(credential)headers['x-api-key']=credential}
 else if(credential)headers.authorization='Bearer '+credential
 return headers
}

/** Preserve the connection's output mode across direct and harness execution. */
export function apiOutputFormat(d:ApiDefinition,schema:Record<string,unknown>){
 if(d.outputFormat==='prompt')return {}
 const object=d.outputFormat==='json-object'
 if(d.kind==='anthropic')return object?{}:{output_config:{...d.parameters.output_config as object,format:{type:'json_schema',schema}}}
 if(d.kind==='openai-responses')return {text:{...d.parameters.text as object,format:object?{type:'json_object'}:{type:'json_schema',name:'agent_result',strict:true,schema}}}
 return {response_format:object?{type:'json_object'}:{type:'json_schema',json_schema:{name:'agent_result',strict:true,schema}}}
}
