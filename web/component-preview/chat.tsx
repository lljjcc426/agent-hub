import { useEffect, useRef, useState } from 'react'
import {
  Check,
  CornerUpLeft,
  Heart,
  Paperclip,
  SlidersHorizontal,
  Smile,
  Sparkles,
  ThumbsUp,
  X,
} from 'lucide-react'
import {
  AgentIdentity,
  ChoiceGroup,
  Composer,
  CopyButton,
  Disclosure,
  IconButton,
  Message,
  Popover,
  SelectField,
  StatusMark,
} from '../ui'
import { SampleFile } from './samples.tsx'

export type DemoMessage = { id: string; text: string; time: string; quote?: string; attachment?: File }
export const reply = '整理好了。三项检查已按负责人分组。'
const zh = (_en: string, value: string) => value

function LocalAttachment({ file }: { file: File }) {
  const [href, setHref] = useState<string>()
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file)
    setHref(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])
  return (
    <a className="inline-attachment" href={href} download={file.name}>
      <Paperclip size={13} />
      {file.name}
    </a>
  )
}

const reactions = [
  { name: '赞同', icon: ThumbsUp },
  { name: '喜欢', icon: Heart },
  { name: '庆祝', icon: Sparkles },
]

export function useDemoComposer() {
  const [text, setText] = useState('')
  const [quote, setQuote] = useState('')
  const [reaction, setReaction] = useState('')
  const [attachment, setAttachment] = useState<File>()
  const [model, setModel] = useState('Codex')
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>('medium')
  function clearDraft() {
    setText('')
    setQuote('')
    setAttachment(undefined)
  }
  return {
    text,
    setText,
    quote,
    setQuote,
    reaction,
    setReaction,
    attachment,
    setAttachment,
    model,
    setModel,
    effort,
    setEffort,
    clearDraft,
  }
}

export function ChatExample({
  openFile,
  showTime,
  messages,
  addMessage,
  hasSample,
  teamActivity,
  draft,
}: {
  openFile: () => void
  showTime: boolean
  messages: DemoMessage[]
  addMessage: (message: DemoMessage) => void
  hasSample: boolean
  teamActivity: boolean
  draft: ReturnType<typeof useDemoComposer>
}) {
  const {
    text,
    setText,
    quote,
    setQuote,
    reaction,
    setReaction,
    attachment,
    setAttachment,
    model,
    setModel,
    effort,
    setEffort,
    clearDraft,
  } = draft
  const chosen = reactions.find((item) => item.name === reaction)
  const upload = useRef<HTMLInputElement>(null)
  const end = useRef<HTMLDivElement>(null)
  function send() {
    const time = new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date())
    addMessage({ id: crypto.randomUUID(), text: text.trim(), time, quote, attachment })
    clearDraft()
    requestAnimationFrame(() => {
      const view = end.current?.parentElement
      if (view) view.scrollTop = view.scrollHeight
    })
  }
  return (
    <div className="sample-chat">
      <div className="sample-transcript" role="region" aria-label="示例对话记录" tabIndex={0}>
        {hasSample && (
          <>
            <Message author="user" time={showTime ? '09:41' : ''}>
              <p>把发布清单按负责人整理一下。</p>
            </Message>
            {teamActivity && (
              <div className="sample-worker-note">
                <Disclosure
                  title={
                    <span className="worker-activity">
                      <AgentIdentity name="文档助手" kind="worker" id="doc" size={18} />
                      核对清单
                    </span>
                  }
                >
                  三项检查，涉及两位负责人。{showTime && <span className="rp-time">09:42</span>}
                </Disclosure>
              </div>
            )}
            <Message
              author="agent"
              identity={<AgentIdentity name="Router" size={25} />}
              time={showTime ? '09:42' : ''}
              actions={
                <>
                  <StatusMark state="done">已完成</StatusMark>
                  <i aria-hidden="true" />
                  <IconButton
                    label="引用回复"
                    onClick={(e) => {
                      setQuote(reply)
                      e.currentTarget.closest('.sample-chat')?.querySelector('textarea')?.focus()
                    }}
                  >
                    <CornerUpLeft size={15} />
                  </IconButton>
                  <Popover label="选择回应" trigger={<Smile size={15} />}>
                    {(dismiss) => (
                      <div className="sample-reactions">
                        {reactions.map(({ name, icon: Icon }) => (
                          <IconButton
                            key={name}
                            label={name}
                            aria-pressed={reaction === name}
                            onClick={() => {
                              setReaction(reaction === name ? '' : name)
                              dismiss()
                            }}
                          >
                            <Icon size={16} />
                          </IconButton>
                        ))}
                      </div>
                    )}
                  </Popover>
                  <CopyButton value={reply} L={zh} />
                </>
              }
            >
              <p>{reply}</p>
              <SampleFile open={openFile} />
              {chosen && (
                <button
                  type="button"
                  className="sample-reaction"
                  aria-label={'撤回' + chosen.name}
                  onClick={() => setReaction('')}
                >
                  <chosen.icon size={12} /> 1
                </button>
              )}
            </Message>
          </>
        )}
        {messages.map((m) => (
          <Message key={m.id} author="user" time={showTime ? m.time : ''}>
            {m.quote && <blockquote>{m.quote}</blockquote>}
            {m.text && <p>{m.text}</p>}
            {m.attachment && <LocalAttachment file={m.attachment} />}
          </Message>
        ))}
        {!hasSample && messages.length === 0 && (
          <div className="chat-empty">
            <Check size={18} /> 示例对话已清空
          </div>
        )}
        <div ref={end} />
      </div>
      <input
        type="file"
        hidden
        ref={upload}
        onChange={(event) => {
          setAttachment(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      <Composer
        value={text}
        hasAttachments={!!attachment}
        onChange={setText}
        onSend={send}
        placeholder="输入示例消息…"
        sendLabel="发送示例消息"
        leading={
          <IconButton label="选择本地附件" onClick={() => upload.current?.click()}>
            <Paperclip size={17} />
          </IconButton>
        }
        tools={
          <Popover label="示例模型和思考强度" trigger={<SlidersHorizontal size={16} />}>
            {() => (
              <div className="sample-model">
                <div>
                  <span>模型连接</span>
                  <SelectField label="模型连接" value={model} onChange={(e) => setModel(e.target.value)}>
                    <option>Codex</option>
                    <option>DeepSeek</option>
                  </SelectField>
                </div>
                <div>
                  <span>思考程度</span>
                  <ChoiceGroup
                    label="思考程度"
                    value={effort}
                    onChange={setEffort}
                    choices={[
                      { value: 'low', label: '低' },
                      { value: 'medium', label: '中' },
                      { value: 'high', label: '高' },
                    ]}
                  />
                </div>
              </div>
            )}
          </Popover>
        }
        context={
          (quote || attachment) && (
            <>
              {quote && (
                <div className="sample-context">
                  <CornerUpLeft size={14} />
                  <span>{quote}</span>
                  <IconButton label="取消引用" onClick={() => setQuote('')}>
                    <X size={13} />
                  </IconButton>
                </div>
              )}
              {attachment && (
                <div className="sample-context">
                  <Paperclip size={14} />
                  <span>{attachment.name}</span>
                  <IconButton label="移除附件" onClick={() => setAttachment(undefined)}>
                    <X size={13} />
                  </IconButton>
                </div>
              )}
            </>
          )
        }
      />
    </div>
  )
}
