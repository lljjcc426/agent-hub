import {useCallback, useEffect, useState, type RefObject} from 'react'
import type {ChatSessions} from '../../src/chat.ts'

type View = ReturnType<ChatSessions['view']>
export type Handoff = View['handoffs'][number]
export type Speaker = Handoff['to']
export type HandoffCursor = RefObject<{id: string; sequence: number} | null>
type Playback = {scope: string; queue: Handoff[]; holder?: Speaker}

export function useHandoffPlayer(cursor: HandoffCursor, id: string | null, view: View | null, watch: boolean, participant?: string) {
  const scope = JSON.stringify([id, participant, watch])
  const [playback, setPlayback] = useState<Playback | null>(null)
  useEffect(() => { setPlayback(null) }, [scope])
  useEffect(() => {
    if (!id || view?.conversation.id !== id) return
    const previous = cursor.current
    const sequence = view.conversation.sequence
    if (previous?.id === id && sequence < previous.sequence) return
    cursor.current = {id, sequence}
    if (!watch) return
    const relevant = (view.handoffs ?? []).filter(h =>
      !participant || h.from.id === participant || h.to.id === participant)
    // Restore who has an ongoing task on first load without replaying its history.
    if (previous?.id !== id) {
      const latest = relevant.at(-1)
      if (latest && view.tasks.some(t => t.id === latest.ticketId && ['running','queued','waiting'].includes(t.state))) {
        setPlayback({scope, queue: [], holder: latest.to})
      }
      return
    }
    const arrived = relevant.filter(h => h.sequence > previous.sequence)
    if (document.hidden) {
      const latest = arrived.at(-1)
      if (latest) setPlayback({scope, queue: [], holder: latest.to})
      return
    }
    if (arrived.length) setPlayback(p => p?.scope === scope
      ? {...p, queue: [...p.queue, ...arrived]}
      : {scope, queue: arrived})
  }, [cursor, id, view, watch, participant, scope])

  const finish = useCallback((id: string) => setPlayback(p => {
    const event = p?.queue[0]
    return p && event?.id === id ? {...p, holder: event.to, queue: p.queue.slice(1)} : p
  }), [])
  const current = watch && playback?.scope === scope ? playback : null
  return {event: current?.queue[0], holder: current?.holder, finish}
}
