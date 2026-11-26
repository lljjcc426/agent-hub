import {expect,it} from 'vitest'
import {TerminalCompanion} from '../src/terminal/companion.ts'
import type {Snapshot} from '../src/terminal/client.ts'
const snapshot=():Snapshot=>({conversation:{id:'personal',sequence:10},run:{id:'turn',state:'completed'},messages:[],workers:[],tasks:[],calls:[],browsers:[],handoffs:[]} as unknown as Snapshot)
it('does not replay old handoffs, plays new exchanges, and drops hidden exchanges',()=>{
 const view=snapshot(),companion=new TerminalCompanion(1000)
 const transfer={id:'handoff',sequence:10,ticketId:'task',from:{id:'router',label:'Router',kind:'router'},to:{id:'one',label:'Research',kind:'worker'}} as Snapshot['handoffs'][number]
 view.handoffs=[transfer]
 companion.update(view,true,false,true,1000)
 expect(companion.frame(3000).label).not.toContain('→')
 view.conversation.sequence=11;view.handoffs=[{...transfer,id:'next',sequence:11}]
 companion.update(view,true,false,true,3000)
 expect(companion.frame(3000).label).toContain('→')
 expect(companion.frame(9100).label).not.toContain('→')
 view.conversation.sequence=12;view.handoffs=[{...transfer,id:'hidden',sequence:12}]
 companion.update(view,true,false,false,10000);companion.update(view,true,false,true,11000)
 expect(companion.frame(11000).label).not.toContain('→')
})
it('settles completed history to idle and keeps reduced motion frames still',()=>{
 const view=snapshot(),companion=new TerminalCompanion(1000)
 companion.update(view,true,false,true,1000)
 expect(companion.frame(1000).phase).toBe('idle')
 expect(companion.frame(2000,true).pixels).toEqual(companion.frame(7000,true).pixels)
 view.run!.state='running';companion.update(view,true,false,true,8000)
 expect(companion.frame(8000).phase).toBe('thinking')
 view.run!.state='completed';companion.update(view,true,false,true,9000)
 expect(companion.frame(9000).phase).toBe('completed')
 expect(companion.frame(11500).phase).toBe('idle')
})
