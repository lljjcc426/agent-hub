import {useEffect, useRef, useState} from 'react'
import {Check, Inbox, Paperclip, X} from 'lucide-react'
import {
  AgentIdentity, ChatComposer, ContextCard, DecisionCard, Disclosure, IconButton, InteractionProvider,
  Message, MessageActions, PendingRequests, QuotePreview, QuotedMessage, Reactions, StatusMark,
  type CurrentContext, type DraftQuote, type ModelConnectionStore,
} from '../ui'
import {SampleFile} from './samples.tsx'

export type DemoMessage = {id: string; text: string; time: string; quote?: DraftQuote; attachment?: File}
export const reply = '整理好了。三项检查已按负责人分组。'
const zh = (_en: string, value: string) => value
const requestText = '把发布清单按负责人整理一下。'
const formats = [{id: 'sheet', label: '表格', detail: ''}, {id: 'document', label: '文档', detail: ''}]

function LocalAttachment({file}: {file: File}) {
  const [href, setHref] = useState<string>()
  useEffect(() => {
    const url = URL.createObjectURL(file)
    setHref(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  return <a className="inline-attachment" href={href} download={file.name}><Paperclip size={13}/>{file.name}</a>
}

function previewConnections(): ModelConnectionStore {
  let current: Awaited<ReturnType<ModelConnectionStore['load']>>['current'] = {
    revision: 1, config: {
      model: 'gpt-6.1-terra', models: {},
      backends: {codex: {kind: 'codex', model: 'gpt-6.1-terra'}, deepseek: {kind: 'openai-chat', label: 'DeepSeek', model: 'deepseek-flash'}},
      execution: {backend: 'codex', roles: {}, router: {backend: 'codex', effort: 'medium'}},
    },
  }
  return {
    load: async () => ({current}),
    capabilities: async (backend, model) => ({
      models: [model ?? 'gpt-6.1-terra'],
      reasoning: {source: 'catalog', efforts: backend === 'deepseek' ? ['low', 'high'] : ['low', 'medium', 'high', 'xhigh']},
    }),
    save: async (revision, patch) => {
      if (revision !== current.revision) throw Error('settings_conflict')
      current = {revision: revision + 1, config: {...current.config, ...patch}}
      return current
    },
  }
}

export function useDemoComposer() {
  const [text, setText] = useState('')
  const [quote, setQuote] = useState<DraftQuote | null>(null)
  const [reactions, setReactions] = useState<Record<string, string[]>>({})
  const [attachment, setAttachment] = useState<File>()
  const [mode, setMode] = useState<'ask' | 'full'>('ask')
  const [model, setModel] = useState('gpt-6.1-terra')
  const [modelStore] = useState(previewConnections)
  function clearDraft() { setText(''); setQuote(null); setAttachment(undefined) }
  return {text, setText, quote, setQuote, reactions, setReactions, attachment, setAttachment,
    mode, setMode, model, setModel, modelStore, clearDraft}
}

export function ChatExample({openFile, showTime, messages, addMessage, hasSample, teamActivity, draft}: {
  openFile: () => void; showTime: boolean; messages: DemoMessage[]; addMessage: (message: DemoMessage) => void
  hasSample: boolean; teamActivity: boolean; draft: ReturnType<typeof useDemoComposer>
}) {
  const {text, quote, attachment, mode, model, modelStore, reactions} = draft
  const [tray, setTray] = useState(false), [details, setDetails] = useState(false)
  const [answer, setAnswer] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null), upload = useRef<HTMLInputElement>(null), trayButton = useRef<HTMLButtonElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const canSend = !!text.trim() || !!attachment
  const sampleMessages = [
    ...(hasSample ? [{id: 'request', text: requestText, role: 'user' as const},
      {id: 'reply', text: reply, role: 'assistant' as const, speaker: {id: 'router', label: 'Router'}}] : []),
    ...messages.map(m => ({...m, role: 'user' as const, attachments: m.attachment ? [{name: m.attachment.name}] : []})),
  ].map(m => ({...m, reactions: reactions[m.id]}))
  const usage: CurrentContext = hasSample ? {data: {activity: null, at: null, model, inputTokens: 6400,
    capacity: 32000, budget: null, composition: null, previous: false}} : {empty: true}

  function send() {
    if (!canSend) return
    const time = new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date())
    addMessage({id: crypto.randomUUID(), text: text.trim(), time, quote: quote ?? undefined, attachment})
    draft.clearDraft()
    requestAnimationFrame(() => { const view = end.current?.parentElement; if (view) view.scrollTop = view.scrollHeight })
  }
  function locate(id: string) {
    const node = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])
      .find(row => row.dataset.messageId === id)
    node?.querySelector<HTMLElement>('.message-line')?.focus({preventScroll: true})
    node?.scrollIntoView({block: 'nearest'})
  }
  function decide(value: string) { setAnswer(value) }
  const decision = <DecisionCard question="下一次交付用哪种格式？" options={formats} answer={answer}
    onAnswer={decide} allowCustom={false}/>
  function closeTray() { setTray(false); trayButton.current?.focus() }
  return <InteractionProvider L={zh} messages={sampleMessages} locate={locate}
    reply={q => {draft.setQuote(q); root.current?.querySelector('textarea')?.focus()}}
    react={(id, emoji) => draft.setReactions(previous => {
      const own = previous[id] ?? []
      return {...previous, [id]: own.includes(emoji) ? own.filter(v => v !== emoji) : [...own, emoji]}
    })}>
    <div ref={root} className="sample-chat" onKeyDown={event => {
      if (event.key === 'Escape' && tray) {event.stopPropagation(); closeTray()}
    }}>
      <div className="sample-chat-tools"><button ref={trayButton} type="button" className="rp-icon-button pending-trigger"
        aria-label="待处理事项" aria-expanded={tray} aria-controls="preview-pending" onClick={() => setTray(!tray)}>
        <Inbox size={17}/>{hasSample && !answer && <span className="pending-badge">1</span>}
      </button></div>
      {tray && <PendingRequests id="preview-pending" close={closeTray} L={zh} loading={false}
        items={!hasSample || answer ? [] : [{id: 'format', content: decision}]}/>}
      <div className="sample-transcript" role="region" aria-label="示例对话记录" tabIndex={0}>
        {hasSample && <>
          <Message author="user" messageId="request" time={showTime ? '09:41' : ''}
            sideActions={<MessageActions id="request"/>} reactions={<Reactions id="request"/>}><p>{requestText}</p></Message>
          {teamActivity && <div className="sample-worker-note"><Disclosure title={<span className="worker-activity">
            <AgentIdentity name="文档助手" kind="worker" id="doc" size={18}/>核对清单</span>}>
            三项检查，涉及两位负责人。{showTime && <span className="rp-time">09:42</span>}</Disclosure></div>}
          <Message author="agent" messageId="reply" identity={<AgentIdentity name="Router" size={25}/>}
            time={showTime ? '09:42' : ''} sideActions={<MessageActions id="reply"/>}
            reactions={<Reactions id="reply"/>} actions={<StatusMark state="done">已完成</StatusMark>}>
            <p>{reply}</p><SampleFile open={openFile}/>
          </Message>
          <div className="sample-question">{decision}</div>
        </>}
        {messages.map(m => <Message key={m.id} author="user" messageId={m.id} time={showTime ? m.time : ''}
          sideActions={<MessageActions id={m.id}/>} reactions={<Reactions id={m.id}/>}>
          {m.quote && <QuotedMessage quote={m.quote}/>}
          {m.text && <p>{m.text}</p>}
          {m.attachment && <LocalAttachment file={m.attachment}/>}
        </Message>)}
        {!hasSample && !messages.length && <div className="chat-empty"><Check size={18}/> 示例对话已清空</div>}
        <div ref={end}/>
      </div>
      {details && <ContextCard current={usage} L={zh} focusOnReveal onClose={() => setDetails(false)}/>}
      <form className="sample-composer rp-composer" onSubmit={event => {event.preventDefault(); send()}}>
        <QuotePreview quote={quote} onClear={() => draft.setQuote(null)} L={zh}/>
        {attachment && <div className="sample-context"><Paperclip size={14}/><span>{attachment.name}</span>
          <IconButton label="移除附件" onClick={() => draft.setAttachment(undefined)}><X size={13}/></IconButton></div>}
        <input ref={upload} type="file" hidden onChange={event => {
          const file = event.target.files?.[0]; if (file) draft.setAttachment(file); event.target.value = ''
        }}/>
        <ChatComposer L={zh} visible sending={false} mode={mode} usage={usage} router="Router" model={model}
          modelBusy={false} uploadDisabled={false} value={text} setText={draft.setText} canSend={canSend}
          onAttach={() => upload.current?.click()} onEnter={send} onSend={send} modelStore={modelStore}
          saveMode={async next => draft.setMode(next)} onContext={() => setDetails(true)}
          onModelSaved={async () => {
            const {current: {config}} = await modelStore.load()
            const backend = config.execution.router?.backend ?? config.execution.backend
            draft.setModel(config.execution.router?.model ?? config.backends[backend]?.model ?? backend)
          }}/>
      </form>
    </div>
  </InteractionProvider>
}
