import type {ToolResult} from './chat-permissions.ts'

const messages = {
 invalid_request: 'Supply a GitHub repository and valid arguments for this operation.',
 unconfigured: 'No GitHub connection is available for this operation.',
 auth_required: 'GitHub authentication is required or has expired.',
 cli_unavailable: 'GitHub CLI (gh) is unavailable on the deployment host.',
 access_denied: 'The connection or task lacks access to this repository or operation.',
 not_found: 'GitHub could not find the requested resource or grant access to it.',
 rate_limited: 'GitHub is rate limiting the connection. Use its retry interval before trying again.',
 unavailable: 'GitHub did not return a usable result.',
 unsupported: 'The GitHub connection does not offer this operation.',
 conflict: 'The GitHub connection or target changed. Inspect the current state before continuing.',
} as const

export class GithubError extends Error {
 constructor(readonly code: keyof typeof messages, readonly retryAfterSeconds?: number, readonly httpStatus?:number) {
  super(messages[code])
 }
}

export function githubRateLimitDelay(headers: Headers,now=Date.now()){
 const retry=headers.get('retry-after')
 const retrySeconds=retry===null?NaN:/^\d+$/.test(retry)?Number(retry):(Date.parse(retry)-now)/1000
 const reset=headers.get('x-ratelimit-reset')
 const resetSeconds=reset&&headers.get('x-ratelimit-remaining')==='0'?Number(reset)-now/1000:NaN
 const waits=[retrySeconds,resetSeconds].filter(Number.isFinite)
 return waits.length?Math.max(1,Math.ceil(Math.max(...waits))):60
}

export function githubHttpError(status: number, headers: Headers, message?:string) {
 if(status===401)return new GithubError('auth_required',undefined,status)
 if(status===404)return new GithubError('not_found',undefined,status)
 const retry=headers.get('retry-after')
 if(status===429||status===403&&(headers.get('x-ratelimit-remaining')==='0'||retry||/api rate limit exceeded|secondary rate limit/i.test(message??''))){
  return new GithubError('rate_limited',githubRateLimitDelay(headers),status)
 }
 if(status===403)return new GithubError('access_denied',undefined,status)
 if(status===405||status===409||status===422)return new GithubError('conflict',undefined,status)
 return new GithubError('unavailable')
}

export function githubResult(value: unknown, success=true): ToolResult {
 return {success,contentItems:[{type:'inputText',text:JSON.stringify(value)}]}
}

export function githubFailure(error: GithubError) {
 return githubResult({status:error.code,message:error.message,...(error.httpStatus===undefined?{}:{source:'github',httpStatus:error.httpStatus}),
  ...(error.retryAfterSeconds===undefined?{}:{retryAfterSeconds:error.retryAfterSeconds})},false)
}
