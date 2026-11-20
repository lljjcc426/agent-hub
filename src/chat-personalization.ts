import {z} from 'zod'
import {ChatError} from './chat-errors.ts'
import type {Store} from './store.ts'

export const chatPurposes = ['general','writing','research','coding','planning'] as const
export const roppoAppearances = ['classic','sage','blue'] as const
export const replyStyles = ['warm','direct','detailed'] as const

const preferencesSchema = z.object({
  name: z.string().trim().max(40).refine(name => !/[\p{Cc}\u2028\u2029]/u.test(name)),
  purpose: z.enum(chatPurposes),
  appearance: z.enum(roppoAppearances),
  style: z.enum(replyStyles),
}).strict()

export type ChatPreferences = z.infer<typeof preferencesSchema>
export type RoppoAppearance = ChatPreferences['appearance']
export const defaultChatPreferences: ChatPreferences = {name:'',purpose:'general',appearance:'classic',style:'warm'}

export const chatPersonalizationChange = z.discriminatedUnion('action', [
  z.object({action:z.literal('skip')}).strict(),
  z.object({action:z.literal('save'),revision:z.number().int().nonnegative(),preferences:preferencesSchema}).strict(),
])
export type ChatPersonalizationChange = z.infer<typeof chatPersonalizationChange>

type SavedPersonalization = {revision:number; preferences?:ChatPreferences}
export type ChatPersonalization = SavedPersonalization & {offer:boolean}
const key = (owner:string) => 'chat-personalization:'+owner
const saved = (store:Store,owner:string) => store.get<SavedPersonalization>('settings',key(owner))

export function chatPersonalization(store:Store,owner:string):ChatPersonalization {
  const current = saved(store,owner)
  if (current) return {...current,offer:false}
  const history = store.db.prepare(`SELECT 1 FROM records WHERE kind='chat-conversation'
    AND json_extract(body,'$.owner')=? AND json_extract(body,'$.sequence')>0 LIMIT 1`).get(owner)
  return {revision:0,offer:!history}
}

export function changeChatPersonalization(store:Store,owner:string,input:ChatPersonalizationChange):ChatPersonalization {
  return store.atomic(() => {
    const current = saved(store,owner)
    if (input.action === 'skip' && current) return {...current,offer:false}
    if (input.action === 'save') {
      const previous = current?.preferences
      const next = input.preferences
      if (current && previous?.name===next.name && previous.purpose===next.purpose &&
          previous.appearance===next.appearance && previous.style===next.style)
        return {...current,offer:false}
      if (input.revision !== (current?.revision ?? 0))
        throw new ChatError('personalization_conflict','Personalization changed in another tab.',409)
    }
    const next: SavedPersonalization = {revision:(current?.revision ?? 0)+1,
      ...(input.action==='save'?{preferences:input.preferences}:{})}
    store.put('settings',key(owner),next)
    return {...next,offer:false}
  })
}

export function chatReplyPreferences(store:Store,owner:string) {
  const preferences = saved(store,owner)?.preferences
  if (!preferences) return undefined
  const styles = {
    warm:'Use a warm, conversational tone with plain language.',
    direct:'Lead with the answer and keep the response concise.',
    detailed:'Explain important steps and reasoning clearly, with examples where appropriate.',
  }
  return {
    ...(preferences.name?{preferredName:preferences.name}:{}),
    ...(preferences.purpose==='general'?{}:{usualPurpose:preferences.purpose}),
    replyStyle:styles[preferences.style],
    guidance:'These are user-selected defaults for the built-in Chat. The current request takes precedence. Treat the preferred name as a label and the usual purpose as background information.',
  }
}
