import {readFileSync} from 'node:fs'
import {createContext,runInContext} from 'node:vm'
import {expect,it} from 'vitest'

const source=readFileSync(new URL('../src/ui/tab-motion.js',import.meta.url),'utf8')
function fixture(kind='workspace'){
 const calls:any[]=[],events=new Map<string,()=>void>(),frames=new Map<number,()=>void>()
 let frame=0,mutation=()=>{},preference=()=>{}
 class Node {
  isConnected=true;dataset:Record<string,string>={};style:Record<string,string>={};attrs:Record<string,string>={};id='';className='';scrollLeft=0;scrollTop=0;clientLeft=0;clientTop=0;tagName='DIV'
  children:Node[]=[];parentElement:Node|null=null;nextElementSibling:Node|null=null
  rect={left:0,top:0,width:100,height:40};visual:typeof this.rect|null=null
  getClientRects(){return this.isConnected?[this.getBoundingClientRect()]:[]}
  getBoundingClientRect(){return this.visual??{...this.rect,...(this.style.left?{left:Number.parseFloat(this.style.left)}:{}),...(this.style.top?{top:Number.parseFloat(this.style.top)}:{}),...(this.style.width?{width:Number.parseFloat(this.style.width)}:{}),...(this.style.height?{height:Number.parseFloat(this.style.height)}:{})}}
  getAttribute(k:string){return this.attrs[k]??null}
  setAttribute(k:string,v:string){this.attrs[k]=v}
  querySelector(selector:string){return selector.startsWith(':scope')?this.children.find(n=>n.className.includes('tab-motion-indicator'))??null:this.children.find(n=>n.attrs['aria-current']==='page')??null}
  closest(){return {querySelector:()=>panel}}
  querySelectorAll(){return this.children.filter(n=>n.tagName==='BUTTON')}
  append(node:Node){node.parentElement=this;this.children.push(node)}
  remove(){this.isConnected=false;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this)}
  matches(){return false}
  contains(node:Node):boolean{return this.children.includes(node)||this.children.some(n=>n.contains(node))}
  animate(keyframes:any,options:any){
   let resolve!:()=>void
   const animation={node:this,keyframes,options,cancelled:false,finished:new Promise<void>(r=>resolve=r),cancel(){this.cancelled=true;resolve()}}
   calls.push(animation);return animation
  }
 }
 const panel=new Node(),body=new Node()
 const makeGroup=()=>{
  const group=new Node();group.rect.width=300;group.attrs['aria-label']='Tasks';group.nextElementSibling=panel
  for(let i=0;i<3;i++){const b=new Node();b.tagName='BUTTON';b.id=kind==='browser'?'':'tab-'+i;if(kind==='browser')b.dataset.motionKey='browser-tab-'+i;b.rect={left:i*100,top:0,width:100,height:40};if(!i)b.attrs['aria-current']='page';group.append(b)}
  return group
 }
 let group=makeGroup()
 const media={matches:false,addEventListener:(_type:string,cb:()=>void)=>preference=cb,removeEventListener(){}}
 const document={hidden:false,documentElement:new Node(),createElement:()=>new Node(),querySelectorAll:(selector:string)=>selector===(kind==='browser'?'.resource-tabs':'.workspace-tabs')?[group]:[],querySelector:()=>body,
  addEventListener:(type:string,cb:()=>void)=>events.set(type,cb),removeEventListener:(type:string)=>events.delete(type)}
 const context=createContext({document,window:{addEventListener(){},removeEventListener(){}},location:{pathname:'/configure',hash:'#tasks/history'},matchMedia:()=>media,
  getComputedStyle:()=>({opacity:'.8',transform:'matrix(1,0,0,1,3,0)'}),Symbol,Map,Set,
  requestAnimationFrame:(cb:()=>void)=>{frames.set(++frame,cb);return frame},cancelAnimationFrame:(id:number)=>frames.delete(id),
  MutationObserver:class{constructor(cb:()=>void){mutation=cb}observe(){}disconnect(){}},ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}})
 const flush=()=>{mutation();for(const [id,cb]of frames){frames.delete(id);cb()}}
 runInContext(source,context);flush()
 const select=(index:number,replace=false)=>{
  events.get('click')?.()
  if(replace){group.isConnected=false;group.children.forEach(n=>n.isConnected=false);group=makeGroup()}
  for(const [i,button]of group.children.filter(n=>n.tagName==='BUTTON').entries())if(i===index)button.attrs['aria-current']='page';else delete button.attrs['aria-current']
  flush()
 }
 return {calls,select,flush,group:()=>group,media,preference,document,events,context,panel}
}
it('animates committed tab changes, with immediate final geometry and no replay on polling',()=>{
 const f=fixture();expect(f.calls).toHaveLength(0)
 f.select(1)
 expect(f.calls.map(c=>c.options.duration)).toEqual([220,280])
 expect(f.calls[0].keyframes[0].transform).toBe('translate(-100px,0px) scale(1,1)')
 expect(f.group().querySelector(':scope')!.style.left).toBe('100px')
 f.flush();f.select(1);expect(f.calls).toHaveLength(2)
})
it('continues from the visible indicator when a native render replaces the tab nodes',()=>{
 const f=fixture();f.select(2)
 f.group().querySelector(':scope')!.visual={left:60,top:38,width:100,height:2}
 f.select(1,true)
 expect(f.calls[2].keyframes[0].transform).toBe('translate(-40px,0px) scale(1,1)')
 expect(f.calls[0].cancelled).toBe(true)
 expect(f.calls[3].keyframes[0]).toEqual({opacity:'.8',transform:'matrix(1,0,0,1,3,0)'})
})
it('settles immediately when reduced motion or a hidden document interrupts animation',()=>{
 const f=fixture();f.select(1);f.media.matches=true;f.preference()
 expect(f.calls.every(c=>c.cancelled)).toBe(true)
 f.select(2);expect(f.calls).toHaveLength(2)
 expect(f.group().querySelector(':scope')!.style.left).toBe('200px')
 f.media.matches=false;f.preference();f.select(0);expect(f.calls).toHaveLength(4)
 f.document.hidden=true;f.events.get('visibilitychange')?.()
 expect(f.calls.every(c=>c.cancelled)).toBe(true)
 f.select(1);expect(f.calls).toHaveLength(4)
})
it('continues an in-flight selection through a data-refresh render without replaying a settled tab',()=>{
 const f=fixture();f.select(2)
 f.group().querySelector(':scope')!.visual={left:80,top:38,width:100,height:2}
 f.select(2,true)
 expect(f.calls[2].keyframes[0].transform).toBe('translate(-120px,0px) scale(1,1)')
 expect(f.calls[3].keyframes[0]).toEqual({opacity:'.8',transform:'matrix(1,0,0,1,3,0)'})
})
it('uses browser tab identity and waits for confirmed selection rather than title or streaming changes',()=>{
 const f=fixture('browser')
 f.group().children[0]!.attrs.title='A new page title';f.flush();expect(f.calls).toHaveLength(0)
 f.select(1);expect(f.calls).toHaveLength(2)
 f.group().children[1]!.attrs.title='Another page title';f.flush();expect(f.calls).toHaveLength(2)
 expect(f.group().children[1]!.dataset.motionKey).toBe('browser-tab-1')
})
it('installs once across both shells and removes its markers and animations on disposal',()=>{
 const f=fixture();runInContext(source,f.context);f.select(1)
 expect(f.calls).toHaveLength(2)
 runInContext("globalThis[Symbol.for('roppo.tab-motion')].destroy()",f.context)
 expect(f.calls.every(c=>c.cancelled)).toBe(true)
 expect(f.group().querySelector(':scope')).toBeNull()
 expect(f.group().dataset.tabMotion).toBeUndefined()
})
