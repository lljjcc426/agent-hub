// Presentation metadata belongs to the request, never to the effect being authorized.
import { z } from 'zod'
import type { ToolSpec } from './model.ts'

export const pendingNoticeDescription = "Write one short, natural sentence for the user in their language explaining what you need and why. Include the word for approval, answer or review (审批、回答、审阅 in Chinese). Chat links that word to the exact request. Do not include a URL, raw command or internal IDs."
export const pendingNoticeSchema = z.string().trim().min(1).max(360).describe(pendingNoticeDescription).optional()
export const pendingNoticeProperty = { type: 'string', maxLength: 360, description: pendingNoticeDescription }
export const permissionNoticeTools = new Set([
  'superagent_shell','superagent_browser','superagent_publish','superagent_review','superagent_workflow','superagent_tool',
  'workspace_browser','worker_manage','router_manage','router_goal','router_knowledge',
])

export function withPendingNotice(spec:ToolSpec):ToolSpec {
  if (!permissionNoticeTools.has(spec.name)) return spec
  return {...spec, inputSchema:{...spec.inputSchema, properties:{...spec.inputSchema.properties as object,pendingNotice:pendingNoticeProperty}}}
}

export function splitPendingNotice(name:string, value:unknown) {
  if (!permissionNoticeTools.has(name) || !value || typeof value!=='object' || !('pendingNotice' in value)) return {args:value}
  const {pendingNotice,...args}=value
  return {args, notice:pendingNoticeSchema.parse(pendingNotice)}
}
