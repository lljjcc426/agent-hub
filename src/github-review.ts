import {z} from 'zod'
import {GithubError} from './github-errors.ts'
import type {GithubReader} from './github-read.ts'

export const githubPullControl=z.enum(['ready','draft','auto_merge','resolve_thread','unresolve_thread'])
export const githubNodeId=z.string().min(1).max(200).regex(/^[\w=+/-]+$/)
const threadFields='id isResolved isOutdated path line comments(first:12){nodes{id databaseId body url author{login} createdAt} pageInfo{hasNextPage endCursor}}'

async function graphql(reader:GithubReader,token:string,query:string,variables:Record<string,unknown>,signal?:AbortSignal,beforeSend?:()=>void,checkRead?:()=>void){
 const response=await reader.api('graphql',token,{method:'POST',body:{query,variables},beforeSend:beforeSend??checkRead},signal)
 if(response?.errors?.length){
  // A mutation can run even when a field selected for its response fails.
  const rejected=(type:string)=>response.errors.every((error:{type?:string;path?:unknown[]})=>
   error.type===type&&(!beforeSend||error.path?.length===1))
  if(rejected('FORBIDDEN'))throw new GithubError('access_denied',undefined,403)
  if(rejected('NOT_FOUND'))throw new GithubError('not_found',undefined,404)
  if(!beforeSend&&rejected('RATE_LIMITED'))throw new GithubError('rate_limited',60)
  throw new GithubError('unavailable')
 }
 if(!response?.data||typeof response.data!=='object')throw new GithubError('unavailable')
 return response.data
}

export async function githubReviewThreads(reader:GithubReader,token:string,repository:string,number:number,after?:string,signal?:AbortSignal,check?:()=>void){
 const [owner,name]=repository.split('/')
 const result=await graphql(reader,token,`query($owner:String!,$name:String!,$number:Int!,$after:String){
   repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:15,after:$after){
    nodes{${threadFields}} pageInfo{hasNextPage endCursor}
   }}}
  }`,{owner,name,number,after},signal,undefined,check)
 const threads=result.repository?.pullRequest?.reviewThreads
 if(!threads)throw new GithubError('not_found')
 return threads
}

export async function githubCheckReviewThread(reader:GithubReader,token:string,repository:string,number:number,threadId:string,signal?:AbortSignal){
 const result=await graphql(reader,token,`query($id:ID!){
  node(id:$id){... on PullRequestReviewThread{pullRequest{number repository{nameWithOwner}}}}
 }`,{id:threadId},signal)
 const pull=result.node?.pullRequest
 if(pull?.number!==number||pull.repository?.nameWithOwner?.toLowerCase()!==repository)throw new GithubError('invalid_request')
}

type Control=z.infer<typeof githubPullControl>
const pullFunctions={ready:'markPullRequestReadyForReview',draft:'convertPullRequestToDraft',auto_merge:'enablePullRequestAutoMerge'} as const
export async function githubChangePull(reader:GithubReader,token:string,repository:string,number:number,control:Control,
 threadId:string|undefined,mergeMethod:string|undefined,beforeSend:()=>void,signal?:AbortSignal){
 if(control==='resolve_thread'||control==='unresolve_thread'){
  if(!threadId)throw new GithubError('invalid_request')
  await githubCheckReviewThread(reader,token,repository,number,threadId,signal)
  const action=control==='resolve_thread'?'resolveReviewThread':'unresolveReviewThread'
  const result=await graphql(reader,token,`mutation($id:ID!){${action}(input:{threadId:$id}){thread{id isResolved}}}`,
   {id:threadId},signal,beforeSend)
  const thread=result[action]?.thread
  if(thread?.id!==threadId||thread.isResolved!==(control==='resolve_thread'))throw new GithubError('unavailable')
  return thread
 }
 const pull=await reader.get('repos/'+repository+'/pulls/'+number,token,signal)
 if(typeof pull?.node_id!=='string')throw new GithubError('not_found')
 const action=pullFunctions[control]
 const result=await graphql(reader,token,control==='auto_merge'?
  `mutation($id:ID!,$method:PullRequestMergeMethod!){${action}(input:{pullRequestId:$id,mergeMethod:$method}){pullRequest{number url autoMergeRequest{mergeMethod}}}}`:
  `mutation($id:ID!){${action}(input:{pullRequestId:$id}){pullRequest{number url isDraft}}}`,
  {id:pull.node_id,...(control==='auto_merge'?{method:(mergeMethod??'squash').toUpperCase()}:{})},signal,beforeSend)
 const updated=result[action]?.pullRequest
 if(updated?.number!==number|| (control==='auto_merge'?!updated.autoMergeRequest:updated.isDraft!==(control==='draft')))
  throw new GithubError('unavailable')
 return updated
}
