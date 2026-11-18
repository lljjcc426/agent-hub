import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Brain,
  ChevronRight,
  Download,
  FileText,
  IdCard,
  MessageSquare,
  MoreHorizontal,
  NotebookPen,
  RefreshCw,
  Speech,
  Upload,
  UserRound,
} from 'lucide-react';
import { NoteDetail, memoryTitle, type Note } from './memory-note.tsx';
import { download, request, type Entry, type Labels } from './memory-api.ts';
import { MemoryFile, personaRequest, type PersonaFile, type PersonaFiles } from './memory-files.tsx';
import { Methods } from './memory-methods.tsx';
import './memory.css';

type FileTab = 'MEMORY.md' | 'USER.md' | PersonaFile;
const files: FileTab[] = ['MEMORY.md', 'USER.md', 'SOUL.md', 'IDENTITY.md', 'AGENTS.md'];
type InitialLearning = { enabled: boolean; editable: boolean; available: boolean; revision: number };
type MemoryWorkspace = { contexts: Entry[]; initialLearning: InitialLearning };
export function MemorySettings({ L }: { L: Labels }) {
  const [file, setFile] = useState<FileTab>('MEMORY.md'),
    [scope, setScope] = useState('personal'),
    [entries, setEntries] = useState<Entry[] | null>(null),
    [persona, setPersona] = useState<PersonaFiles | null>(null);
  const [selected, setSelected] = useState(''),
    [mobileDetail, setMobileDetail] = useState(false),
    [editing, setEditing] = useState(false),
    [revision, refresh] = useState(0),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [pendingLearning, setPendingLearning] = useState<boolean | null>(null),
    [methods, setMethods] = useState(false),
    [methodEntry, setMethodEntry] = useState('');
  const menu = useRef<HTMLDetailsElement>(null),
    importInput = useRef<HTMLInputElement>(null),
    methodsDialog = useRef<HTMLDialogElement>(null);
  const personal = file === 'MEMORY.md' || file === 'USER.md',
    scopedFile = personal || file === 'AGENTS.md',
    groups = entries?.filter((e) => !e.conversationId) ?? [],
    all = entries ?? [];
  const actualScope = scope !== 'personal' && !groups.some((e) => e.id === scope) ? 'personal' : scope;
  const visible = all.filter((e) =>
    actualScope === 'personal' ? !!e.conversationId : e.id === actualScope,
  );
  const notes: Note[] = [
    ...new Map(
      visible.flatMap((entry) =>
        entry.items
          .filter(
            (f) =>
              ['active', 'candidate'].includes(f.state) &&
              f.proposalAction !== 'forget' &&
              (file !== 'USER.md' || ['profile', 'preference', 'interest'].includes(f.kind ?? '')),
          )
          .map((fact) => [fact.id, { fact, entry }] as const),
      ),
    ).values(),
  ].sort((a, b) => b.fact.createdAt - a.fact.createdAt);
  const learned: Note[] = visible.flatMap((entry) =>
    entry.items
      .filter((f) => f.state === 'active' && f.origin === 'experience')
      .map((fact) => ({ fact, entry })),
  );
  const current = notes.find((n) => n.fact.id === selected) ?? notes[0];
  const [initialLearning, setInitialLearning] = useState<InitialLearning | null>(null);
  const hasContext = visible.length > 0;
  const learning = hasContext
    ? visible.every((entry) => entry.enabled && entry.policy.writeMode !== 'explicit_only')
    : initialLearning?.enabled ?? false;
  const canChangeLearning = hasContext ? visible.every((entry) => entry.enabled) : initialLearning?.editable;
  const showWorkspace = (data: MemoryWorkspace) => {
    setInitialLearning(data.initialLearning);
    setEntries(data.contexts);
  };
  useEffect(() => {
    let disposed = false;
    setError('');
    void Promise.all([request<MemoryWorkspace>({ action: 'refresh' }), personaRequest()])
      .then(([m, p]) => {
        if (!disposed) {
          showWorkspace(m);
          setPersona(p);
        }
      })
      .catch(() => {
        if (!disposed) setError(L('Could not load. Try refreshing.', '读取失败，请刷新重试。'));
      });
    return () => {
      disposed = true;
    };
  }, [revision]);
  useEffect(() => {
    if (methods) methodsDialog.current?.showModal();
    else methodsDialog.current?.close();
  }, [methods]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  const closeMenu = () => {
    if (menu.current) menu.current.open = false;
  };
  const run = async (work: () => Promise<unknown>, reload = true) => {
    setBusy(true);
    setError('');
    closeMenu();
    try {
      await work();
      if (reload) refresh((v) => v + 1);
    } catch {
      setError(L('Could not complete the operation. Please try again.', '操作未完成，请重试。'));
    } finally {
      setBusy(false);
    }
  };
  const changeLearning = async () => {
    const enabled = !learning;
    setBusy(true);
    setPendingLearning(enabled);
    setError('');
    try {
      if (!hasContext && initialLearning?.editable) {
        await request({action:'initial-learning', enabled, revision:initialLearning.revision});
      } else {
        const scopes = new Map(visible.map((entry) => [entry.scopeId,entry]));
        for (const entry of scopes.values())
          await request({entryId:entry.id,action:'learning',enabled,revision:entry.revision});
      }
      showWorkspace(await request<MemoryWorkspace>({action:'refresh'}));
    } catch {
      setError(L('Could not change learning. Try refreshing.', '学习设置未能保存，请刷新重试。'));
      try { showWorkspace(await request<MemoryWorkspace>({action:'refresh'})); } catch { /* Keep the retry action available. */ }
    } finally {
      setPendingLearning(null);
      setBusy(false);
    }
  };
  const exportFile = () =>
    void run(async () => {
      if (!personal) {
        if (persona) {
          const learnedText =
            file === 'AGENTS.md'
              ? (
                  await Promise.all(
                    visible.map((e) =>
                      request<{ text: string }>({ entryId: e.id, action: 'export', file }),
                    ),
                  )
                )
                  .map((t) => t.text.replace(/^# AGENTS\.md\s*/, ''))
                  .filter(Boolean)
                  .join('\n\n')
              : '';
          download(
            file,
            persona.files[file] +
              (learnedText
                ? '\n\n<!-- roppo:learned-conventions -->\n## Learned working conventions\n\n' +
                  learnedText +
                  '\n<!-- /roppo:learned-conventions -->'
                : ''),
          );
        }
        return;
      }
      const text = await Promise.all(
        visible.map((e) => request<{ text: string }>({ entryId: e.id, action: 'export', file })),
      );
      download(file, text.map((t) => t.text).join('\n\n'));
    }, false);
  const chooseFile = (next: FileTab) => {
    setFile(next);
    setMobileDetail(false);
    setSelected('');
  };
  const activeMethod = visible.find((e) => e.id === methodEntry) ?? visible[0];
  const profiles = [
    { file: 'IDENTITY.md', label: L('Identity', '身份'), Icon: IdCard },
    { file: 'SOUL.md', label: L('Personality and voice', '性格与表达'), Icon: Speech },
    { file: 'AGENTS.md', label: L('Working conventions', '工作约定'), Icon: NotebookPen },
  ] as const;
  const profile = profiles.find((row) => row.file === file);
  const profileButtons = useRef<Partial<Record<PersonaFile, HTMLButtonElement | null>>>({});
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const openProfile = (next: PersonaFile) => {
    chooseFile(next);
    requestAnimationFrame(() => detailTitle.current?.focus());
  };
  const closeProfile = () => {
    chooseFile('MEMORY.md');
    if (profile) requestAnimationFrame(() => profileButtons.current[profile.file]?.focus());
  };
  return (
    <section className="memory-settings" aria-label={L('Memory', '记忆')}>
      {!personal && (
        <button className="memory-profile-back" onClick={closeProfile} disabled={editing || busy}>
          <ArrowLeft size={16} />
          {L('Back to memory', '返回记忆')}
        </button>
      )}
      <header className="memory-heading">
        <h1 id="page-title" ref={detailTitle} tabIndex={-1}>
          {profile?.label ?? L('Memory', '记忆')}
        </h1>
        <details
          ref={menu}
          className="memory-menu"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              closeMenu();
              menu.current?.querySelector('summary')?.focus();
            }
          }}
        >
          <summary aria-label={L('More memory actions', '更多记忆操作')}>
            <MoreHorizontal size={18} />
            {L('Actions', '更多操作')}
          </summary>
          <div className="memory-menu-items">
            <button
              disabled={editing || busy}
              onClick={() => {
                closeMenu();
                refresh((v) => v + 1);
              }}
            >
              <RefreshCw size={16} />
              {L('Refresh', '刷新')}
            </button>
            <button disabled={busy || !persona || (personal && !visible.length)} onClick={exportFile}>
              <Download size={16} />
              {L('Export ', '导出 ') + file}
            </button>
            <button
              disabled={busy || editing || !persona || (personal && !visible.length)}
              onClick={() => {
                closeMenu();
                importInput.current?.click();
              }}
            >
              <Upload size={16} />
              {L('Import Markdown', '导入 Markdown')}
            </button>
            {personal && (
              <button
                disabled={busy || editing || !visible.length}
                onClick={() =>
                  void run(async () => {
                    for (const e of visible) await request({ entryId: e.id, action: 'consolidate' });
                  })
                }
              >
                <FileText size={16} />
                {L('Organize memories', '整理记忆')}
              </button>
            )}
          </div>
        </details>
      </header>
      {error && (
        <p className="memory-error" role="alert">
          {error}
          <button className="text-button" onClick={() => refresh((v) => v + 1)}>
            {L('Refresh', '刷新')}
          </button>
        </p>
      )}
      {scopedFile && groups.length > 0 && (
        <label className="memory-scope">
          <UserRound size={17} />
          {L('Memory scope', '记忆范围')}
          <select
            disabled={editing || busy}
            value={actualScope}
            onChange={(e) => {
              setScope(e.target.value);
              setSelected('');
              setMobileDetail(false);
            }}
          >
            <option value="personal">{L('My memories', '我的记忆')}</option>
            <optgroup label={L('Group memories', '群聊记忆')}>
              {groups.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
      )}
      {personal && (
        <>
          <label className="memory-toggle learn-setting">
            <span className="settings-glyph">
              <Brain size={21} />
            </span>
            <span className="learn-name">
              {L('Learn from conversations', '从对话中学习')}
              {entries && !hasContext && initialLearning && !initialLearning.available && (
                <small>{L('Conversation memory is not enabled in this workspace', '此工作区尚未启用对话记忆')}</small>
              )}
              {entries && !hasContext && initialLearning?.available && !canChangeLearning && (
                <small>{L('Start a conversation to change this setting', '开始对话后可更改')}</small>
              )}
            </span>
            <input
              role="switch"
              aria-label={L('Learn from conversations', '从对话中学习')}
              type="checkbox"
              checked={pendingLearning ?? learning}
              disabled={busy || !canChangeLearning}
              onChange={() => void changeLearning()}
            />
          </label>
          <section className="settings-group">
            <div className="memory-section-title">
              <h2>{L('Saved memories', '记住的内容')}</h2>
              <div
                className="settings-segments"
                role="group"
                aria-label={L('Filter memories', '筛选记忆')}
              >
                {(
                  [
                    ['MEMORY.md', L('All', '全部')],
                    ['USER.md', L('About you', '个人偏好')],
                  ] as const
                ).map(([name, label]) => (
                  <button
                    key={name}
                    disabled={editing || busy}
                    aria-pressed={file === name}
                    onClick={() => chooseFile(name)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {entries === null ? (
              <p role="status">
                {error ? L('Memory unavailable', '记忆暂不可用') : L('Loading…', '加载中…')}
              </p>
            ) : current ? (
              <div className="memory-reader saved-reader" data-detail={mobileDetail}>
                <nav className="memory-list" aria-label={L('Memories', '记忆列表')}>
                  {notes.map((note) => (
                    <button
                      key={note.fact.id}
                      aria-current={note.fact.id === current.fact.id ? 'true' : undefined}
                      disabled={editing}
                      onClick={() => {
                        setSelected(note.fact.id);
                        setMobileDetail(true);
                      }}
                    >
                      <MessageSquare size={19} />
                      <span>
                        <strong>{memoryTitle(note.fact, L)}</strong>
                        <span>{note.fact.content}</span>
                      </span>
                    </button>
                  ))}
                </nav>
                <NoteDetail
                  key={current.fact.id + ':' + current.fact.revision}
                  note={current}
                  L={L}
                  changed={() => refresh((v) => v + 1)}
                  editingChanged={setEditing}
                  back={() => setMobileDetail(false)}
                />
              </div>
            ) : (
              <div className="settings-empty">
                <BookOpen size={24} />
                <span>
                  {file === 'USER.md'
                    ? L('No saved preferences', '还没有记下个人偏好')
                    : L('No saved memories', '还没有记住的内容')}
                </span>
              </div>
            )}
          </section>
          <section className="settings-group">
            <h2>{L('Router profile', 'Router 角色资料')}</h2>
            <div className="settings-links">
              {profiles.map(({ file: name, label, Icon }) => (
                <button
                  key={name}
                  ref={(el) => {
                    profileButtons.current[name] = el;
                  }}
                  disabled={editing || busy}
                  onClick={() => openProfile(name)}
                >
                  <span className="settings-glyph">
                    <Icon size={19} />
                  </span>
                  <span>{label}</span>
                  <ChevronRight size={17} />
                </button>
              ))}
            </div>
          </section>
          {visible.length > 0 && (
            <button
              className="memory-method-link"
              disabled={editing || busy}
              onClick={() => setMethods(true)}
            >
              <BookOpen size={17} />
              {L('Working methods', '工作方法')}
              <ChevronRight size={16} />
            </button>
          )}
        </>
      )}
      {!personal &&
        (persona ? (
          <MemoryFile
            key={file + actualScope}
            file={file}
            data={persona}
            L={L}
            saved={setPersona}
            editingChanged={setEditing}
            learned={file === 'AGENTS.md' ? learned : []}
            notesChanged={() => refresh((v) => v + 1)}
          />
        ) : (
          <p role="status">
            {error ? L('Profile unavailable', '角色资料暂不可用') : L('Loading…', '加载中…')}
          </p>
        ))}
      <input
        ref={importInput}
        type="file"
        accept=".md"
        hidden
        onChange={(e) => {
          const upload = e.target.files?.[0];
          e.target.value = '';
          if (!upload) return;
          if (upload.size > 64000 || !files.includes(upload.name as FileTab)) {
            setError(
              L(
                'Import a Markdown file up to 64 KB named ',
                '请选择不超过 64 KB 的文件，支持的文件名为 ',
              ) + files.join('、'),
            );
            return;
          }
          void run(async () => {
            const text = await upload.text();
            if (upload.name === 'MEMORY.md' || upload.name === 'USER.md') {
              const entry = visible[0];
              if (!entry) throw Error('No memory context');
              await request({
                entryId: entry.id,
                action: 'import',
                file: upload.name,
                text,
                operationId: crypto.randomUUID(),
              });
            } else {
              if (!persona) throw Error('No settings');
              setPersona(
                await personaRequest({
                  agentId: 'router',
                  file: upload.name,
                  text,
                  revision: persona.revision,
                }),
              );
            }
          });
        }}
      />
      <dialog
        ref={methodsDialog}
        className="memory-method-dialog"
        onCancel={() => setMethods(false)}
        onClose={() => {
          setMethods(false);
        }}
      >
        <header>
          <h3>{L('Working methods', '工作方法')}</h3>
          <button className="button" onClick={() => setMethods(false)}>
            {L('Close', '关闭')}
          </button>
        </header>
        {visible.length > 1 && (
          <label>
            {L('Conversation', '对话')}
            <select value={activeMethod?.id} onChange={(e) => setMethodEntry(e.target.value)}>
              {visible.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {activeMethod && (
          <Methods
            key={activeMethod.id}
            entry={activeMethod}
            L={L}
            changed={() => refresh((v) => v + 1)}
          />
        )}
      </dialog>
    </section>
  );
}
