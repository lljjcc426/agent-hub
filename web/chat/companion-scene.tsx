import {useLayoutEffect, useRef, useState} from 'react'
import type {CompanionPhase} from './companion-state.ts'
import {RoppoCharacter} from './roppo-character.tsx'
import type {Handoff, Speaker} from './use-handoff.ts'
import './companion-scene.css'

const duration = 3250
const mix = (a: number, b: number, t: number) => a + (b-a)*t
function ease(t: number, start: number, end: number) {
  const u = Math.max(0, Math.min(1, (t-start)/(end-start)))
  return u*u*(3-2*u)
}

export function CompanionScene({actor, phase, event, paused, onFinish}: {
  actor: Speaker; phase: CompanionPhase; event?: Handoff; paused: boolean; onFinish: (id: string) => void
}) {
  const scene = useRef<HTMLSpanElement>(null)
  const [releasedEvent, setReleasedEvent] = useState<string>()
  const eventId = event?.id
  useLayoutEffect(() => {
    if (!eventId) return
    const node = scene.current!
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0, elapsed = 0, last: number | undefined, released = false
    const draw = () => {
      const t = Math.min(1, elapsed / (reduced.matches ? 450 : duration))
      const step = ease(t, .04, .43)
      const meet = ease(t, .43, .55)
      const pass = ease(t, .55, .69)
      const leave = ease(t, .70, .96)
      // World coordinates. Track the sender first, frame the pair at contact,
      // then settle on the receiver while the sender walks off to the left.
      const gap = 42, travel = 134, receiver = travel + gap
      const sender = travel*step - 146*leave
      const camera = mix(mix(travel*step, travel+gap/2, meet), receiver, leave)
      const stride = t < .55 ? step : leave
      const rock = Math.sin(8*Math.PI*stride)*Math.sin(Math.PI*stride)
      const vars = node.style
      vars.setProperty('--giver-x', (reduced.matches ? 0 : sender-camera)+'px')
      vars.setProperty('--taker-x', (reduced.matches ? 0 : receiver-camera)+'px')
      vars.setProperty('--giver-opacity', String(reduced.matches ? 1-ease(t,.25,.56) : 1-ease(t,.72,.91)))
      vars.setProperty('--taker-opacity', String(reduced.matches ? ease(t,.44,.74) : 1))
      vars.setProperty('--sway', (reduced.matches ? 0 : rock*9)+'deg')
      vars.setProperty('--hop', (reduced.matches ? 0 : -Math.abs(rock)*2.6)+'px')
      vars.setProperty('--reach', String(ease(t,.43,.54)*(1-ease(t,.67,.78))))
      vars.setProperty('--document-x', (mix(sender+14, receiver-14, pass)-camera)+'px')
      vars.setProperty('--document-y', (-5*Math.sin(Math.PI*pass)-Math.abs(rock)*2*(1-pass))+'px')
      vars.setProperty('--document-opacity', String(reduced.matches ? 0 : ease(t,0,.09)*(1-ease(t,.72,.86))))
      vars.setProperty('--ground-x', (-camera%18)+'px')
      vars.setProperty('--ground-opacity', String(reduced.matches ? 0 : ease(t,.02,.12)*(1-ease(t,.80,.97))))
      if (!released && t >= .80) { released = true; setReleasedEvent(eventId) }
    }
    const tick = (now: number) => {
      if (document.hidden) return
      if (last !== undefined) elapsed += Math.min(80, now-last)
      last = now
      draw()
      if (elapsed >= (reduced.matches ? 450 : duration)) onFinish(eventId)
      else frame = requestAnimationFrame(tick)
    }
    const resume = () => {
      cancelAnimationFrame(frame)
      last = undefined
      draw()
      if (!document.hidden) frame = requestAnimationFrame(tick)
    }
    resume()
    document.addEventListener('visibilitychange',resume)
    reduced.addEventListener('change',resume)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange',resume)
      reduced.removeEventListener('change',resume)
    }
  }, [eventId,onFinish])

  const cast = event ? [event.from,event.to] : [actor]
  return <span ref={scene} className="companion-lens" aria-hidden="true">
    {event && <span className="companion-ground"/>}
    {cast.map((member,i) => {
      const place = !event ? 'solo' : i === 0 ? 'giver' : 'taker'
      const normal = !event || (place === 'taker' && releasedEvent === event.id)
      return <span key={member.kind+':'+member.id} className="companion-actor" data-place={place} data-member={member.id}>
        <span className="companion-stride">
          <RoppoCharacter workerId={member.kind==='worker'?member.id:undefined} phase={normal?phase:'idle'} paused={paused}/>
          {event && <i className="companion-hand"/>}
        </span>
      </span>
    })}
    {event && <span className="companion-document"><i/></span>}
  </span>
}
