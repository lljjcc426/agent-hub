import type {ToolResult} from './chat-permissions.ts'

const messages = {
 invalid_request: 'Supply a GitHub repository and valid arguments for this operation.',
 unconfigured: 'No GitHub connection is available for this operation.',
 auth_required: 'GitHub authentication is required or has expired.',
 access_denied: 'The connection or task lacks access to this repository or operation.',
 not_found: 'GitHub could not find the requested resource or grant access to it.',
 rate_limited: 'GitHub is rate limiting the connection. Use its retry interval before trying again.',
 unavailable: 'GitHub did not return a usable result.',
 unsupported: 'The GitHub connection does not offer this operation.',
 conflict: 'The GitHub connection or target changed. Inspect the current state before continuing.',
} as const

export class GithubError extends Error {
 constructor(readonly code: keyof typeof messages, readonly retryAfterSeconds?: number) {
  super(messages[code])
 }
}

export function githubHttpError(status: number, headers: Headers) {
 if(status===401)return new GithubError('auth_required')
 if(status===404)return new GithubError('not_found')
 const retry=headers.get('retry-after'),reset=headers.get('x-ratelimit-reset')
 if(status===429||status===403&&(headers.get('x-ratelimit-remaining')==='0'||retry)){
  const wait=retry?Number(retry):reset?Number(reset)-Date.now()/1000:NaN
  return new GithubError('rate_limited',Number.isFinite(wait)?Math.max(1,Math.ceil(wait)):undefined)
 }
 if(status===403)return new GithubError('access_denied')
 if(status===405||status===409||status===422)return new GithubError('conflict')
 return new GithubError('unavailable')
}

export function githubResult(value: unknown, success=true): ToolResult {
 return {success,contentItems:[{type:'inputText',text:JSON.stringify(value)}]}
}

export function githubFailure(error: GithubError) {
 return githubResult({status:error.code,message:error.message,...(error.retryAfterSeconds===undefined?{}:{retryAfterSeconds:error.retryAfterSeconds})},false)
}
