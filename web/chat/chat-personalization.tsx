import {useEffect,useLayoutEffect,useRef,useState,type FormEvent} from 'react'
import {ArrowLeft,ArrowRight,Check} from 'lucide-react'
import {chatPurposes,defaultChatPreferences,replyStyles,roppoAppearances,type ChatPersonalization,type ChatPreferences,type RoppoAppearance} from '../../src/chat-personalization.ts'
import {Button,ChoiceGroup,InputControl} from '../ui/controls.tsx'
import {Dialog} from '../ui/overlays.tsx'
import {AgentAvatar,RoppoAppearanceContext} from './agent-avatar.tsx'
import {animateChatArrival,type ChatArrival} from './chat-arrival.ts'
import type {Localize} from './composer-commands.tsx'
import {chatPersonalizationCopy,replyExample} from './personalization-copy.ts'
import {RoppoCharacter} from './roppo-character.tsx'
import './chat-personalization.css'

function usePageHidden() {
  const [hidden,setHidden]=useState(()=>document.hidden)
  useEffect(()=>{
    const update=()=>setHidden(document.hidden)
    document.addEventListener('visibilitychange',update)
    return ()=>document.removeEventListener('visibilitychange',update)
  },[])
  return hidden
}

export function FirstChatWelcome({L,start,skip}: {L:Localize; start:()=>void; skip:()=>void}) {
  const [wave,setWave]=useState({look:'classic' as RoppoAppearance,count:1})
  const paused=usePageHidden()
  const {looks}=chatPersonalizationCopy(L)
  return <section className="first-chat-welcome" aria-labelledby="first-chat-title">
    <div className="first-chat-copy">
      <h1 id="first-chat-title">{L('Meet your Roppo','认识一下你的 Roppo')}</h1>
      <p>{L('Pick a look and show me how you like to work.','选一个你喜欢的样子，也告诉我你习惯怎么聊。')}</p>
      <div className="first-chat-actions">
        <Button tone="primary" onClick={start}>{L('Set up my Roppo','设置我的 Roppo')}<ArrowRight size={15} aria-hidden="true"/></Button>
        <Button tone="quiet" onClick={skip}>{L('Go straight to Chat','直接聊天')}</Button>
      </div>
    </div>
    <div className="first-chat-crew" role="group" aria-label={L('Say hello to Roppo','和小 Roppo 打招呼')}>
      {(['sage','classic','blue'] as const).map(look=><RoppoAppearanceContext key={look} value={look}>
        <button type="button" className="first-chat-actor" data-look={look}
          aria-label={L('Wave to '+looks[look]+' Roppo','向'+looks[look]+' Roppo 打招呼')}
          onClick={()=>setWave(previous=>({look,count:previous.count+1}))}>
          <RoppoCharacter phase="idle" greeting={wave.look===look?wave.count:0} paused={paused}/>
        </button>
      </RoppoAppearanceContext>)}
    </div>
  </section>
}

export function ChatPersonalizationDialog({open,mode,state,L,onSave,onSkip,onClose,onAfterClose}: {
  open:boolean; mode:'first'|'edit'; state:ChatPersonalization; L:Localize
  onSave:(preferences:ChatPreferences,arrival?:ChatArrival)=>Promise<void>; onSkip:()=>void; onClose:()=>void; onAfterClose:()=>void
}) {
  const [preferences,setPreferences]=useState<ChatPreferences>(()=>({...defaultChatPreferences,...state.preferences}))
  const [step,setStep]=useState(0)
  const [direction,setDirection]=useState('next')
  const [greeting,setGreeting]=useState(1)
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState('')
  const heading=useRef<HTMLHeadingElement>(null)
  const paused=usePageHidden()||!open
  const copy=chatPersonalizationCopy(L)
  const example=copy.purposes[preferences.purpose]
  const title=[L('Let’s get to know each other','先认识一下'),L('Make Roppo yours','选你的 Roppo'),L('Ready to chat','可以开始聊天了')][step]

  useLayoutEffect(()=>{
    // The dialog itself receives focus when it opens. Subsequent steps have their own heading.
    if (open && (step>0 || direction==='back')) heading.current?.focus({preventScroll:true})
  },[open,step,direction])

  function changeStep(next:number) {
    setDirection(next>step?'next':'back')
    setError('')
    setStep(next)
    if (next===2) setGreeting(value=>value+1)
  }

  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if(saving)return
    if(step<2){changeStep(step+1);return}
    const form=event.currentTarget
    setSaving(true);setError('')
    try {
      const arrival:ChatArrival|undefined=mode==='first'?(renderChat,close)=>animateChatArrival(form,renderChat,close):undefined
      await onSave({...preferences,name:preferences.name.trim()},arrival)
    } catch (reason) {
      const conflict=reason instanceof Error && 'code' in reason && reason.code==='personalization_conflict'
      setError(conflict
        ? L('These settings changed in another tab. Check your choices and save again.','其他页面更新了设置。请确认这里的选择后再保存。')
        : L('Could not save your preferences. Try again.','设置未能保存，请重试。'))
    } finally { setSaving(false) }
  }

  return <Dialog open={open} className="roppo-ui chat-personalization-dialog"
    title={L('Personalize Roppo','个性化 Roppo')} closeLabel={L('Close personalization','关闭个性化设置')}
    onClose={()=>{if(!saving)onClose()}} onAfterClose={onAfterClose}>
    <form className="roppo-setup" onSubmit={submit}>
      <div className="roppo-setup-layout">
        <div className="roppo-setup-content">
          <div className="roppo-setup-progress" role="progressbar" aria-label={L('Setup progress','设置进度')}
            aria-valuemin={1} aria-valuemax={3} aria-valuenow={step+1}>
            {[0,1,2].map(index=><i key={index} data-current={index===step} data-done={index<step}/>)}
          </div>
          <div className="roppo-setup-step" key={step} data-direction={direction}>
            <h3 ref={heading} tabIndex={-1}>{title}</h3>
            {step===0 && <>
              <label className="roppo-setup-field">
                <span>{L('What should I call you?','我该怎么称呼你？')}<small>{L('Optional','选填')}</small></span>
                <InputControl autoComplete="nickname" placeholder={L('Your preferred name','比如，小林')}
                  value={preferences.name} maxLength={40}
                  onChange={event=>setPreferences(value=>({...value,name:event.target.value}))}/>
              </label>
              <div className="roppo-setup-choices roppo-setup-purposes">
                <h4>{L('What do you usually work on?','平时最常做什么？')}</h4>
                <ChoiceGroup label={L('Usual work','常用场景')} appearance="tiles"
                  choices={chatPurposes.map(value=>({value,label:copy.purposes[value].label}))}
                  value={preferences.purpose} onChange={purpose=>setPreferences(value=>({...value,purpose}))}/>
              </div>
            </>}
            {step===1 && <>
              <div className="roppo-setup-choices roppo-setup-looks">
                <h4>{L('Appearance','外观')}</h4>
                <ChoiceGroup label={L('Roppo appearance','Roppo 外观')} appearance="tiles"
                  choices={roppoAppearances.map(value=>({value,label:copy.looks[value],visual:
                    <span className="roppo-look-portrait"><RoppoAppearanceContext value={value}><AgentAvatar size={38}/></RoppoAppearanceContext></span>}))}
                  value={preferences.appearance} onChange={appearance=>{
                    setPreferences(value=>({...value,appearance}));setGreeting(value=>value+1)
                  }}/>
              </div>
              <div className="roppo-setup-choices roppo-setup-styles">
                <h4>{L('Reply style','回复风格')}</h4>
                <ChoiceGroup label={L('Reply style','回复风格')} appearance="tiles"
                  choices={replyStyles.map(value=>({value,label:copy.styles[value]}))}
                  value={preferences.style} onChange={style=>setPreferences(value=>({...value,style}))}/>
              </div>
            </>}
            {step===2 && <dl className="roppo-setup-summary">
              {preferences.name.trim() && <div><dt>{L('I’ll call you','你的称呼')}</dt><dd>{preferences.name.trim()}</dd></div>}
              <div><dt>{L('Usual work','常用场景')}</dt><dd>{example.label}</dd></div>
              <div><dt>{L('Appearance','外观')}</dt><dd>{copy.looks[preferences.appearance]}</dd></div>
              <div><dt>{L('Reply style','回复风格')}</dt><dd>{copy.styles[preferences.style]}</dd></div>
            </dl>}
          </div>
        </div>
        <RoppoAppearanceContext value={preferences.appearance}>
          <section className="roppo-setup-preview" aria-label={L('Reply preview','回复预览')}>
            <div className="roppo-setup-stage">
              <button type="button" disabled={saving} data-look={preferences.appearance} className="first-chat-actor" aria-label={L('Wave to Roppo','和 Roppo 打招呼')}
                onClick={()=>setGreeting(value=>value+1)}>
                <RoppoCharacter phase={step===2?'completed':'idle'} greeting={greeting} paused={paused}/>
              </button>
            </div>
            <div className="roppo-setup-example">
              <h4>{L('Reply preview','回复预览')}</h4>
              <p className="roppo-example-user">{example.prompt}</p>
              <div className="roppo-example-reply" key={preferences.purpose+':'+preferences.style}>
                <AgentAvatar size={21}/>
                {preferences.style==='detailed'
                  ? <ol>{replyExample(preferences,L).map(line=><li key={line}>{line}</li>)}</ol>
                  : <p>{replyExample(preferences,L)[0]}</p>}
              </div>
            </div>
          </section>
        </RoppoAppearanceContext>
      </div>
      {error && <p className="roppo-setup-error" role="alert">{error}</p>}
      <footer className="roppo-setup-actions">
        {mode==='first' && <Button tone="quiet" onClick={onSkip} disabled={saving}>{L('Skip setup','先跳过')}</Button>}
        <div>
          {step>0 && <Button tone="quiet" onClick={()=>changeStep(step-1)} disabled={saving}><ArrowLeft size={14} aria-hidden="true"/>{L('Back','上一步')}</Button>}
          <Button type="submit" tone="primary" busy={saving}>
            {step<2?L('Continue','继续'):mode==='first'?L('Start chatting','开始聊天'):L('Save preferences','保存设置')}
            {!saving && (step<2 ? <ArrowRight size={15} aria-hidden="true"/> : <Check size={15} aria-hidden="true"/>)}
          </Button>
        </div>
      </footer>
    </form>
  </Dialog>
}
