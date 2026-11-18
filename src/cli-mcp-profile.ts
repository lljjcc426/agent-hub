import {existsSync,readFileSync,statSync} from 'node:fs'
import {dirname,isAbsolute,resolve} from 'node:path'
import {parse as toml} from 'smol-toml'
import {parse as jsonc,type ParseError} from 'jsonc-parser'
import {z} from 'zod'
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {stableDigest} from './sources.ts'

const names=z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
export const cliProfileSchema=z.object({
  kind:z.literal('cli-mcp'),cli:z.enum(['codex','claude','gemini','opencode']),
  profile:z.string().refine(isAbsolute,'Select an absolute CLI configuration path'),server:z.string().min(1),
  digest:z.string().regex(/^[0-9a-f]{64}$/),workers:z.array(names).min(1),
}).strict()
type Profile=z.infer<typeof cliProfileSchema>
const map=z.record(z.string(),z.string())
const strings=z.array(z.string())
const config=z.object({
  type:z.enum(['stdio','http','local','remote','streamable-http','streamable_http']).optional(),
  command:z.union([z.string().min(1),strings.nonempty()]).optional(),args:strings.optional(),cwd:z.string().optional(),
  env:map.optional(),environment:map.optional(),env_vars:strings.optional(),url:z.string().optional(),httpUrl:z.string().optional(),
  headers:map.optional(),http_headers:map.optional(),env_http_headers:map.optional(),bearer_token_env_var:z.string().optional(),
  enabled:z.boolean().optional(),disabled:z.boolean().optional(),enabled_tools:strings.optional(),disabled_tools:strings.optional(),
  includeTools:strings.optional(),excludeTools:strings.optional(),oauth:z.literal(false).optional(),trust:z.boolean().optional(),
  startup_timeout_sec:z.number().optional(),tool_timeout_sec:z.number().optional(),timeout:z.number().optional(),
}).strict()
function serverCatalog(cli:Profile['cli'],profile:string){
  try{
    if(!isAbsolute(profile))throw Error()
    const info=statSync(profile)
    if(!info.isFile()||info.size>4_000_000)throw Error()
    const text=readFileSync(profile,'utf8'),errors:ParseError[]=[]
    const root=cli==='codex'?toml(text):jsonc(text,errors,{allowTrailingComma:true})
    const servers=root?.[cli==='codex'?'mcp_servers':cli==='opencode'?'mcp':'mcpServers']
    if(errors.length||!servers||typeof servers!=='object'||Array.isArray(servers))throw Error()
    return {root,servers}
  }catch{throw Error('Could not read the CLI MCP configuration')}
}
export function cliServerNames(cli:Profile['cli'],profile:string){
  return Object.keys(serverCatalog(cli,profile).servers).sort()
}
function readServer(cli:Profile['cli'],profile:string,server:string){
  try{
    const {root,servers}=serverCatalog(cli,profile)
    if(!Object.hasOwn(servers,server))throw Error()
    if(cli==='gemini'&&(root.mcp?.excluded?.includes(server)||root.mcp?.allowed&&!root.mcp.allowed.includes(server)))throw Error()
    if(cli==='opencode'&&root.permission!==undefined)throw Error()
    if(root.disabledMcpServers?.includes(server))throw Error()
    return config.parse(servers[server])
  }catch{throw Error('CLI MCP entry is missing, restricted, or uses an unsupported profile format')}
}
type Entry=z.infer<typeof config>
function checkTools(entry:Entry,tools:string[]){
  const allowlists=[entry.enabled_tools,entry.includeTools]
  const denied=[...(entry.disabled_tools??[]),...(entry.excludeTools??[])]
  if(entry.enabled===false||entry.disabled)throw Error('CLI MCP server is disabled')
  for(const tool of tools){
    if(!tool.trim()||tool.includes('*')||allowlists.some(list=>list&&!list.includes(tool))||denied.includes(tool))throw Error('CLI MCP tool is disabled or not explicitly allowed')
  }
  if(!tools.length)throw Error('Select at least one CLI MCP tool')
}
function checkTransport(cli:Profile['cli'],entry:Entry){
  if(entry.command){
    if(entry.url||entry.httpUrl||entry.type&&!['local','stdio'].includes(entry.type)||Array.isArray(entry.command)&&entry.args)throw Error('Inconsistent CLI MCP stdio transport')
    return
  }
  if(!(entry.httpUrl||entry.url)||entry.httpUrl&&entry.url||entry.type&&!['http','remote','streamable-http','streamable_http'].includes(entry.type)||cli==='gemini'&&!entry.httpUrl)throw Error('Only stdio and Streamable HTTP MCP are supported')
}
/** Only the reference leaves this process. Literal credentials stay in the selected profile. */
export function cliMcpGrant(cli:Profile['cli'],profile:string,server:string,worker:string,tools:string[]){
  const entry=readServer(cli,profile,server)
  checkTransport(cli,entry)
  checkTools(entry,tools)
  return cliProfileSchema.parse({kind:'cli-mcp',cli,profile,server,workers:[worker],digest:stableDigest(entry)})
}
function envValue(name:string){
  const value=process.env[name]
  if(!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)||!value)throw Error('CLI MCP environment variable is unavailable')
  return value
}
function expandValue(cli:Profile['cli'],value:string){
  if(cli==='codex')return value
  if(cli==='opencode'){
    if(/\{file:/.test(value))throw Error('CLI MCP file substitutions are unsupported')
    return value.replace(/\{env:([^}]*)\}/g,(_,key)=>envValue(key))
  }
  const variables=cli==='gemini'?/\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z_0-9]*)/g:/\$\{([^}]*)\}/g
  return value.replace(variables,(_,key,short)=>envValue(key??short))
}
export function verifyCliMcpGrant(ref:Profile,tools:string[]){
  const entry=readServer(ref.cli,ref.profile,ref.server)
  checkTools(entry,tools)
  if(stableDigest(entry)!==ref.digest)throw Error('CLI MCP configuration changed. Review and renew its grant.')
  return entry
}
export function cliMcpTransport(ref:Profile,tools:string[]){
  const entry=verifyCliMcpGrant(ref,tools)
  checkTransport(ref.cli,entry)
  const expand=(value:string)=>expandValue(ref.cli,value)
  const values=(input:Record<string,string>={})=>Object.fromEntries(Object.entries(input).map(([key,value])=>[key,expand(value)]))
  if(entry.command){
    const [command,...args]=Array.isArray(entry.command)?entry.command:[entry.command,...(entry.args??[])]
    if(!command)throw Error('Invalid CLI MCP command')
    const inherited=Object.fromEntries((entry.env_vars??[]).map(key=>[key,envValue(key)]))
    return new StdioClientTransport({
      command:expand(command),args:args.map(expand),cwd:resolve(dirname(ref.profile),expand(entry.cwd??'.')),
      env:{...getDefaultEnvironment(),...inherited,...values(entry.env??entry.environment)},
      stderr:'ignore',maxBufferSize:8_000_000,
    })
  }
  let url:URL
  try{url=new URL(expand(entry.httpUrl??entry.url!))}catch{throw Error('Invalid CLI MCP URL or environment reference')}
  if(url.username||url.password||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(url.hostname)))throw Error('Unsupported CLI MCP URL')
  const headers=values(entry.headers??entry.http_headers)
  for(const [key,variable] of Object.entries(entry.env_http_headers??{}))headers[key]=envValue(variable)
  if(entry.bearer_token_env_var)headers.Authorization='Bearer '+envValue(entry.bearer_token_env_var)
  return new StreamableHTTPClientTransport(url,{requestInit:{headers,redirect:'error'}})
}

/** The browser can inspect the host user's standard profiles, never arbitrary paths. */
export function cliMcpPreview(input:unknown,home:string,workers:string[],env:NodeJS.ProcessEnv=process.env){
  const {cli,server,worker,tools}=z.object({cli:cliProfileSchema.shape.cli,server:z.string().min(1).max(200).optional(),worker:names.optional(),tools:z.array(z.string().min(1).max(160)).min(1).max(100).optional()}).strict().parse(input)
  const profiles=cliProfilePaths(home,env)
  const profile=profiles[cli]
  if(!server&&!worker&&!tools)return {servers:cliServerNames(cli,profile)}
  if(!server||!worker||!tools||!workers.includes(worker))throw Error('Select a server, an existing Worker and exact tool names')
  return cliMcpFragment(cli,profile,server,worker,tools)
}
export function cliMcpFragment(cli:Profile['cli'],profile:string,server:string,worker:string,tools:string[]){
  const transport=cliMcpGrant(cli,profile,server,worker,tools)
  const id='cli_'+stableDigest([cli,profile,server,worker,tools.toSorted()]).slice(0,16)
  return {toolConnections:{[id]:{label:server,transport,allowedTools:tools}}}
}

export function cliProfilePaths(home:string,env:NodeJS.ProcessEnv){
  const openCodeDir=resolve(env.XDG_CONFIG_HOME||resolve(home,'.config'),'opencode')
  const openCodeJson=resolve(openCodeDir,'opencode.json')
  const openCodeProfile=env.OPENCODE_CONFIG||(!existsSync(openCodeJson)?resolve(openCodeDir,'opencode.jsonc'):openCodeJson)
  return {codex:resolve(env.CODEX_HOME||resolve(home,'.codex'),'config.toml'),claude:resolve(home,'.claude.json'),gemini:resolve(home,'.gemini/settings.json'),opencode:openCodeProfile}
}
