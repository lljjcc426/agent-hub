type Point = readonly [number, number]

// Crown and shoulder samples of the 50% alpha edge of roppo-body.webp, at 512px.
const bodyOutline: Point[] = [
  [256,61],[274,61],[292,62],[309,64],[327,68],[344,73],[360,80],
  [375,89],[389,100],[402,113],[413,127],
  [89,143],[98,128],[110,114],[122,101],[137,91],[152,82],
  [168,75],[185,70],[203,66],[220,63],[238,62],
]

const SVG = 'http://www.w3.org/2000/svg'
const traceEnd = 250
const dockAt = 745
const sweepEnd = 1635
const finishAt = 1775
const ease = 'cubic-bezier(.22,.72,.2,1)'

export type ChatArrival = (renderChat: () => void, close: (dialog?: HTMLDialogElement) => void) => Promise<void>

function imageOutline(image: HTMLImageElement, dialog: HTMLDialogElement) {
  // Find the linear part of the displayed pose. The bounding box center also
  // accounts for layout offsets and transforms around noncentral origins.
  const matrix = new DOMMatrix()
  for (let node: HTMLElement | null = image; node; node = node.parentElement) {
    const {transform} = getComputedStyle(node)
    if (transform !== 'none') matrix.preMultiplySelf(new DOMMatrix(transform))
    if (node === dialog) break
  }
  const {x,y,width,height} = image.getBoundingClientRect()
  const {offsetWidth,offsetHeight} = image
  return bodyOutline.map(([u,v]): Point => {
    const dx = offsetWidth * (u / 512 - .5)
    const dy = offsetHeight * (v / 512 - .5)
    return [x + width / 2 + matrix.a * dx + matrix.c * dy, y + height / 2 + matrix.b * dx + matrix.d * dy]
  })
}

function pointString(x: number, y: number) { return x.toFixed(1)+' '+y.toFixed(1) }

function smoothArc(points: Point[]) {
  const last = points.length - 1
  let result = 'M'+pointString(...points[0]!)
  for (let i=0;i<last;i++) {
    const [ax,ay]=points[Math.max(0,i-1)]!, [bx,by]=points[i]!,
      [cx,cy]=points[i+1]!, [dx,dy]=points[Math.min(last,i+2)]!
    result+='C'+pointString(bx+(cx-ax)/6,by+(cy-ay)/6)+' '+pointString(cx-(dx-bx)/6,cy-(dy-by)/6)+' '+pointString(cx,cy)
  }
  return result
}

function arrivalRoute(source:Point[], composer:HTMLElement) {
  const box=composer.getBoundingClientRect()
  if (box.width<40 || box.height<20 || box.top>=innerHeight || box.bottom<=0) return

  // Start at the crown and follow the shoulder facing the input box.
  const direction=source[0]![0]<(box.left+box.right)/2?1:-1
  const arc=direction===1?source.slice(0,11):[source[0]!,...source.slice(-11).reverse()]
  const [x,y]=arc.at(-1)!, [previousX,previousY]=arc.at(-2)!
  const tangent=Math.hypot(x-previousX,y-previousY)
  if (!tangent) return

  // The curve approaches the nearest horizontal edge and joins it tangentially.
  const inset=.6
  const left=box.left+inset, right=box.right-inset
  const top=box.top+inset, bottom=box.bottom-inset
  const inward=y<(top+bottom)/2?1:-1
  const near=inward===1?top:bottom, far=inward===1?bottom:top
  const first=direction===1?right:left, last=direction===1?left:right
  const radius=Math.max(0,Math.min((parseFloat(getComputedStyle(composer).borderTopLeftRadius)||0)-inset,
    (right-left)/2,(bottom-top)/2))
  const dockX=left+(right-left)*(.5+direction*.19)
  const span=Math.abs(dockX-x)
  const bendX=x+(dockX-x)*.52
  const clearance=Math.min(70,Math.max(28,span*.24))
  const bendY=Math.max(8,Math.min(innerHeight-8,near-inward*clearance))
  const lead=Math.min(60,span*.22)
  const handle=(dockX-x)*.17
  const shoulder=smoothArc(arc)
  const crossing=shoulder+` C${pointString(x+lead*(x-previousX)/tangent,y+lead*(y-previousY)/tangent)}
    ${pointString(bendX-handle,bendY)} ${pointString(bendX,bendY)}
    C${pointString(bendX+handle,bendY)} ${pointString(dockX-handle,near)} ${pointString(dockX,near)}`
  const corner=`A${radius} ${radius} 0 0 ${direction===inward?1:0}`
  const outline=` H${first-direction*radius} ${corner} ${first} ${near+inward*radius}
    V${far-inward*radius} ${corner} ${first-direction*radius} ${far}
    H${last+direction*radius} ${corner} ${last} ${far-inward*radius}
    V${near+inward*radius} ${corner} ${last+direction*radius} ${near} H${dockX}`
  return {shoulder,crossing,path:crossing+outline}
}

const ramp = (time:number, from:number, to:number) => Math.max(0, Math.min(1, (time-from)/(to-from)))

// Match the exit speed of each stretch to the entry speed of the next.
function travelSegment(time:number, from:number, to:number, start:number, finish:number, entrySpeed:number, exitSpeed:number) {
  const t=ramp(time,start,finish), duration=finish-start
  return from+(to-from)*t*t*(3-2*t)+duration*t*(1-t)*(entrySpeed*(1-t)-exitSpeed*t)
}

function setStrokeSegment(path:SVGPathElement, head:number, tail:number, total:number, opacity:number) {
  const visible=Math.min(head,tail)
  path.setAttribute('stroke-dasharray',`${visible} ${total+2}`)
  path.setAttribute('stroke-dashoffset',String(visible-head))
  path.setAttribute('opacity',String(opacity))
}

/** Carry a short stroke from the mascot to the freshly laid-out composer. */
export async function animateChatArrival(form:HTMLFormElement, renderChat:()=>void, close:Parameters<ChatArrival>[1]) {
  const dialog=form.closest('dialog'), actor=form.querySelector<HTMLElement>('.roppo-setup-stage .first-chat-actor')
  const image=actor?.querySelector<HTMLImageElement>('.roppo-body img')
  const motion=matchMedia('(prefers-reduced-motion: reduce)')
  if (!dialog?.open || !actor || !image || !image.offsetWidth || motion.matches || document.hidden ||
      typeof HTMLElement.prototype.showPopover!=='function' || typeof DOMMatrix!=='function') {
    renderChat();close();return
  }

  const listener=new AbortController()
  const animations:Animation[]=[]
  const frozen=actor.getAnimations({subtree:true}).filter(animation=>animation.playState==='running')
  let layer:HTMLDivElement|undefined
  let frame=0
  let rendered=false
  function fade(element:Element|null,appear:boolean,delay:number,duration:number,travel=0) {
    if (!element)return
    const keyframes:Keyframe[]=[{opacity:appear?0:1},{opacity:appear?1:0}]
    if(travel)keyframes[appear?0:1]!.transform='translateY('+travel+'px)'
    animations.push(element.animate(keyframes,{delay,duration,easing:ease,fill:'both'}))
  }
  try {
    frozen.forEach(animation=>animation.pause())
    const source=imageOutline(image,dialog)
    renderChat()
    rendered=true
    const composer=document.querySelector<HTMLElement>('.thread[data-welcome] .composer:not(.worker-readonly)')
    const route=composer&&arrivalRoute(source,composer)
    const thread=composer?.closest('.thread')
    if(!composer||!route||!thread)return

    // The top layer lets the stroke travel beyond the scrollable setup dialog.
    layer=document.createElement('div')
    layer.className='roppo-chat-arrival'
    layer.setAttribute('popover','manual')
    layer.setAttribute('aria-hidden','true')
    const svg=document.createElementNS(SVG,'svg')
    const trail=document.createElementNS(SVG,'path'), line=document.createElementNS(SVG,'path'),
      light=document.createElementNS(SVG,'path')
    light.classList.add('roppo-arrival-light')
    svg.append(trail,line,light)
    layer.append(svg)
    dialog.append(layer)
    layer.showPopover()
    line.setAttribute('d',route.shoulder)
    const takeoffLength=line.getTotalLength()
    line.setAttribute('d',route.crossing)
    const dockLength=line.getTotalLength()
    line.setAttribute('d',route.path)
    const length=line.getTotalLength()
    trail.setAttribute('d',route.path)
    light.setAttribute('d',route.path)
    const traceSpeed=takeoffLength/traceEnd
    const crossingSpeed=(dockLength-takeoffLength)/(dockAt-traceEnd)
    const sweepSpeed=(length-dockLength)/(sweepEnd-dockAt)
    const takeoffSpeed=2*traceSpeed*crossingSpeed/(traceSpeed+crossingSpeed)
    const dockingSpeed=2*crossingSpeed*sweepSpeed/(crossingSpeed+sweepSpeed)
    dialog.dataset.chatArrival=''
    const {signal}=listener
    const departure=form.querySelector('.roppo-setup-layout')
    fade(dialog.querySelector('section > header'),false,traceEnd-120,375,-6)
    fade(departure?.querySelector('.roppo-setup-content')??null,false,traceEnd-90,400,-7)
    fade(departure?.querySelector('.roppo-setup-example')??null,false,traceEnd-36,380,5)
    fade(form.querySelector('.roppo-setup-actions'),false,traceEnd-100,370,5)
    fade(actor,false,traceEnd+20,400)
    fade(dialog,false,traceEnd+147,410)
    fade(thread.querySelector('.empty-state'),true,dockAt-155,540,6)
    fade(composer,true,dockAt-24,450)
    fade(thread.querySelector('.starter-actions'),true,dockAt+365,430,5)

    await new Promise<void>(resolve=>{
      const interrupt=()=>{cancelAnimationFrame(frame);resolve()}
      const options={once:true,signal}
      window.addEventListener('resize',interrupt,options)
      window.visualViewport?.addEventListener('resize',interrupt,options)
      window.addEventListener('pagehide',interrupt,options)
      window.addEventListener('popstate',interrupt,options)
      document.addEventListener('visibilitychange',interrupt,options)
      motion.addEventListener('change',interrupt,options)
      window.addEventListener('keydown',event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();interrupt()}
      },{capture:true,signal})

      function draw(ms:number) {
        const head=ms<traceEnd
          ? travelSegment(ms,0,takeoffLength,0,traceEnd,0,takeoffSpeed)
          : ms<dockAt
            ? travelSegment(ms,takeoffLength,dockLength,traceEnd,dockAt,takeoffSpeed,dockingSpeed)
            : travelSegment(ms,dockLength,length,dockAt,sweepEnd,dockingSpeed,0)
        const reach=19+82*ramp(ms,traceEnd-18,dockAt-105)+31*ramp(ms,dockAt,dockAt+250)
        const opacity=ramp(ms,0,94)*(1-ramp(ms,sweepEnd-160,finishAt))
        setStrokeSegment(trail,head,reach,length,.34*opacity)
        setStrokeSegment(line,head,reach*.57,length,.55*opacity)
        setStrokeSegment(light,head,reach*.19,length,opacity)
      }
      const started=performance.now()
      const tick=(now:number)=>{
        const ms=now-started
        draw(ms)
        if(ms<finishAt)frame=requestAnimationFrame(tick)
        else resolve()
      }
      draw(0)
      frame=requestAnimationFrame(tick)
    })
  } catch {
    // Preferences are already saved. A browser that cannot paint the trace still enters Chat.
  } finally {
    listener.abort()
    cancelAnimationFrame(frame)
    if (!rendered) renderChat()
    close(dialog)
    layer?.remove()
    delete dialog.dataset.chatArrival
    animations.forEach(animation=>animation.cancel())
    frozen.forEach(animation=>{if(animation.playState==='paused')animation.play()})
  }
}
