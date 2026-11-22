import {z} from 'zod'
import {CallToolResultSchema,type Tool} from '@modelcontextprotocol/sdk/types.js'
import type {ToolConnection} from './connector-config.ts'
import {textPage} from './context-budget.ts'
import {GithubError,githubResult} from './github-errors.ts'

export const githubReadTools=[
 'actions_get','actions_list','get_commit','get_file_contents','get_job_logs','get_label','get_latest_release',
 'get_me','get_release_by_tag','get_tag','get_team_members','get_teams','issue_read','list_branches','list_commits',
 'list_issue_fields','list_issue_types','list_issues','list_pull_requests','list_releases','list_repository_collaborators',
 'list_tags','pull_request_read','search_code','search_commits','search_issues','search_orgs','search_pull_requests',
 'search_repositories','search_users',
]
export const githubWriteTools=[
 'actions_run_trigger','add_comment_to_pending_review','add_issue_comment','add_reply_to_pull_request_comment',
 'create_branch','create_or_update_file','create_pull_request','delete_file','issue_write','pull_request_review_write',
 'push_files','sub_issue_write','update_issue_comment','update_pull_request','update_pull_request_branch',
]

export function githubToolConnection(readOnly:boolean):ToolConnection{
 return {enabled:true,transport:{kind:'http',url:'https://api.githubcopilot.com/mcp/',headerEnv:{}},
  allowedTools:readOnly?githubReadTools:githubWriteTools,timeoutMs:18_000}
}

export function githubToolHeaders(token:string,readOnly:boolean){
 return {Authorization:'Bearer '+token,'X-MCP-Toolsets':'context,repos,issues,pull_requests,actions,users,orgs',
  ...(readOnly?{'X-MCP-Readonly':'true'}:{})}
}

export const githubToolName=z.string().regex(/^[a-z][a-z0-9_]{0,79}$/)
export const githubArguments=z.record(z.string(),z.unknown()).refine(value=>JSON.stringify(value).length<=64_000)
export const githubApiPath=z.string().min(1).max(1600).refine(value=>{
 if(!/^\/?[a-zA-Z\d]/.test(value)||/[\\#\x00-\x1f\x7f]/.test(value))return false
 const pathname=value.split('?')[0]!
 try{
  return pathname.replace(/^\//,'').split('/').every(segment=>{
   const decoded=decodeURIComponent(segment)
   return !!segment&&!['.','..'].includes(decoded)&&!/[\/\\%\x00-\x1f\x7f]/.test(decoded)
  })
 }catch{return false}
})

export function githubToolArguments(tool:Tool,repository:string,input:Record<string,unknown>){
 const args={...input},[owner,repo]=repository.split('/')
 for(const [key,value] of Object.entries({owner,repo})){
  if(!Object.hasOwn(tool.inputSchema.properties??{},key))continue
  if(args[key]!==undefined&&(typeof args[key]!=='string'||args[key].toLowerCase()!==value))throw new GithubError('invalid_request')
  args[key]=value
 }
 return args
}

export function githubToolOutput(value:unknown){
 const parsed=CallToolResultSchema.safeParse(value)
 if(!parsed.success)throw new GithubError('unavailable')
 const result=parsed.data
 if(result.isError){
  const detail=(Array.isArray(result.content)?result.content:[])
   .filter(item=>item.type==='text').map(item=>item.text).join('\n')
  const status=detail.match(/\bHTTP\s+(401|403|404|409|422|429)\b/i)?.[1]
  const text=detail.toLowerCase()
  if(status==='429'||text.includes('rate limit'))throw new GithubError('rate_limited',60,429)
  if(status==='401'||text.includes('bad credentials'))throw new GithubError('auth_required',undefined,401)
  if(status==='403'||/resource not accessible|write access to repository not granted|insufficient permission/.test(text))
   throw new GithubError('access_denied',undefined,403)
  if(status==='404')throw new GithubError('not_found',undefined,404)
  if(status==='409'||status==='422')throw new GithubError('conflict',undefined,Number(status))
  throw new GithubError('unavailable')
 }
 if(result.structuredContent!==undefined)return result.structuredContent
 const content=result.content.map(item=>{
  if(item.type!=='text')return {type:item.type}
  try{return JSON.parse(item.text)}catch{return item.text}
 })
 return content.length===1?content[0]:content
}

export function githubEvidence(metadata:object,data:unknown,offset=0){
 const serialized=typeof data==='string'?data:JSON.stringify(data??null)
 if(!offset&&serialized.length<=14_000)return githubResult({...metadata,data})
 return githubResult({...metadata,...textPage(serialized,offset,14_000),format:typeof data==='string'?'text':'json'})
}

const resourceId='[1-9]\\d*'
const issues='issues/'+resourceId
const pulls='pulls/'+resourceId
const comments='issues/comments/'+resourceId
const reviewComment='pulls/comments/'+resourceId
const reactionTarget='(?:'+issues+'|'+comments+'|'+reviewComment+')'
const restWrites:Record<string,RegExp[]>={
 POST:[
  /^(issues|pulls|git\/(?:blobs|trees|commits|refs))$/,
  new RegExp('^'+issues+'/(?:comments|assignees|labels)$'),
  new RegExp('^'+pulls+'/(?:reviews|comments|comments/'+resourceId+'/replies|requested_reviewers)$'),
  new RegExp('^'+reactionTarget+'/reactions$'),
  new RegExp('^actions/(?:runs/'+resourceId+'/(?:rerun|rerun-failed-jobs)|jobs/'+resourceId+'/rerun)$'),
 ],
 PATCH:[new RegExp('^(?:'+issues+'|'+pulls+'|'+comments+'|'+reviewComment+')$'),/^git\/refs\/heads\/.+$/],
 PUT:[/^contents\/.+$/,new RegExp('^(?:'+issues+'/lock|'+pulls+'/reviews/'+resourceId+'/dismissals)$')],
 DELETE:[
  /^contents\/.+$/,
  new RegExp('^(?:'+issues+'/(?:assignees|labels/[^/]+|lock)|'+pulls+'/requested_reviewers|'+reactionTarget+'/reactions/'+resourceId+')$'),
 ],
}
export const githubRestVerb=z.enum(['POST','PATCH','PUT','DELETE'])

export function githubWritePath(method:z.infer<typeof githubRestVerb>,path:string){
 const normalized=path.replace(/^\//,'')
 if(!restWrites[method]?.some(allowed=>allowed.test(normalized))||normalized.includes('?'))throw new GithubError('unsupported')
 return normalized
}
