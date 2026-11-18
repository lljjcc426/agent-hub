import { SelectField } from '../ui/controls.tsx'
import { useEffect, useState } from "react";
import {
  Folder,
  FileText,
  ChevronRight,
  ArrowLeft,
  RefreshCw,
} from "lucide-react";
import type {ChatDelivery} from '../../src/chat-deliveries.ts';
import {ChoiceGroup} from '../ui';
import {DeliveryCard} from './team-view.tsx';

type Task = { id: string; title: string; workerId: string };
type Result = {
  items?: { name: string; directory: boolean }[];
  text?: string;
  nextOffset: number | null;
  cursor?: string;
};
export function FilesPanel({conversationId, deliveries, openFile, L}:{
  conversationId:string|null;
  deliveries:ChatDelivery[];
  openFile:(file:ChatDelivery)=>void;
  L:(en:string,zh:string)=>string;
}) {
  const [tab,setTab]=useState<'chat'|'tasks'>('chat');
  return <div className="studio-files">
    <div className="studio-files-tabs roppo-ui"><ChoiceGroup label={L('Files','文件')} value={tab} onChange={setTab} choices={[
      {value:'chat',label:L('Chat files','会话文件')},{value:'tasks',label:L('Task folders','任务目录')}
    ]}/></div>
    {tab==='tasks'?<TaskFiles conversationId={conversationId} L={L}/>:<div className="studio-deliveries">
      {deliveries.length?[...deliveries].sort((a,b)=>b.createdAt-a.createdAt).map(file=><DeliveryCard key={file.id} file={file} open={openFile} L={L}/>):<p>{L('No files yet','还没有会话文件')}</p>}
    </div>}
  </div>
}

function TaskFiles({
  conversationId,
  L,
}: {
  conversationId: string | null;
  L: (en: string, zh: string) => string;
}) {
  const storageKey = "roppo.files." + (conversationId ?? "new");
  const [saved] = useState(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      return value &&
        typeof value.ticket === "string" &&
        typeof value.path === "string" &&
        ["directory", "files"].includes(value.kind)
        ? value
        : null;
    } catch {
      return null;
    }
  });
  const [tasks, setTasks] = useState<Task[]>([]),
    [ticket, setTicket] = useState<string>(saved?.ticket ?? ""),
    [path, setPath] = useState<string>(saved?.path ?? ""),
    [kind, setKind] = useState<"directory" | "files">(
      saved?.kind ?? "directory",
    ),
    [result, setResult] = useState<Result | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [revision, setRevision] = useState(0),
    [offset, setOffset] = useState(0),
    [cursor, setCursor] = useState("");
  useEffect(() => {
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ ticket, path, kind }),
      );
    } catch {}
  }, [storageKey, ticket, path, kind]);
  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = new URLSearchParams({
      ...(ticket
        ? {
            ticket,
            path,
            kind,
            offset: String(offset),
            ...(cursor ? { cursor } : {}),
          }
        : {}),
    });
    fetch("/api/chat/conversations/" + conversationId + "/files?" + query, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const failure = await response.json().catch(() => ({}));
          if (controller.signal.aborted) return;
          if (failure.code === "file_task_missing") {
            setTicket("");
            setPath("");
            setKind("directory");
            setOffset(0);
            setCursor("");
            setResult(null);
            return;
          }
          throw Error("file_unavailable");
        }
        const data = await response.json();
        if (controller.signal.aborted) return;
        setTasks(data.tasks);
        if (!ticket && data.tasks.length) {
          setTicket(data.tasks[0].id);
          return;
        }
        setResult((previous) =>
          offset && previous
            ? {
                ...data.result,
                items: previous.items
                  ? [...previous.items, ...data.result.items]
                  : undefined,
                text:
                  previous.text !== undefined
                    ? previous.text + data.result.text
                    : undefined,
              }
            : (data.result ?? null),
        );
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          setError("file_unavailable");
          setResult(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [conversationId, ticket, path, kind, revision, offset, cursor]);
  const go = (next: string, type: "directory" | "files") => {
    setPath(next);
    setKind(type);
    setOffset(0);
    setCursor("");
    setResult(null);
  };
  return (
    <div className="files-panel">
      <div className="files-toolbar">
        <SelectField
          aria-label={L("Task files", "任务文件")}
          value={ticket}
          onChange={(event) => {
            setTicket(event.target.value);
            go("", "directory");
          }}
        >
          <option value="" disabled>
            {L("Task files", "任务文件")}
          </option>
          {tasks.map((task) => (
            <option value={task.id} key={task.id}>
              {task.title || task.workerId}
            </option>
          ))}
        </SelectField>
        <button
          className="icon-button"
          aria-label={L("Refresh files", "刷新文件")}
          onClick={() => {
            setOffset(0);
            setCursor("");
            setRevision(revision + 1);
          }}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {path ? (
        <div className="file-path">
          <button
            className="icon-button"
            aria-label={L("Parent folder", "上级目录")}
            onClick={() =>
              go(path.split("/").slice(0, -1).join("/"), "directory")
            }
          >
            <ArrowLeft size={16} />
          </button>
          <span title={path}>{path}</span>
        </div>
      ) : null}
      {error ? (
        <div className="panel-empty" role="alert">
          <FileText size={28} />
          <p>
            {L(
              "This file is unavailable or cannot be previewed.",
              "文件不可用或不支持预览。",
            )}
          </p>
          <button
            onClick={() => {
              setOffset(0);
              setCursor("");
              setRevision(revision + 1);
            }}
          >
            {L("Retry", "重试")}
          </button>
        </div>
      ) : !conversationId || (!loading && !tasks.length) ? (
        <div className="panel-empty">
          <Folder size={30} />
          <h2>{L("Files from this conversation", "本会话的文件")}</h2>
          <p>
            {L(
              "Task files appear here when your team starts work.",
              "团队开始工作后，任务文件会显示在这里。",
            )}
          </p>
        </div>
      ) : (
        <div className="file-content" aria-busy={loading}>
          {loading && !result ? (
            <p role="status">{L("Loading…", "加载中…")}</p>
          ) : null}
          {result?.items?.map((item) => (
            <button
              className="file-row"
              key={item.name}
              onClick={() =>
                go(
                  [path, item.name].filter(Boolean).join("/"),
                  item.directory ? "directory" : "files",
                )
              }
            >
              {item.directory ? <Folder size={17} /> : <FileText size={17} />}
              <span>{item.name}</span>
              {item.directory ? <ChevronRight size={14} /> : null}
            </button>
          ))}
          {result?.items?.length === 0 ? (
            <p>{L("This folder is empty.", "此文件夹为空。")}</p>
          ) : null}
          {result?.text !== undefined ? (
            <pre className="file-preview">
              <code>{result.text}</code>
            </pre>
          ) : null}
          {result?.nextOffset != null ? (
            <button
              className="file-more"
              disabled={loading}
              onClick={() => {
                setCursor(result.cursor ?? "");
                setOffset(result.nextOffset!);
              }}
            >
              {L("Load more", "加载更多")}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
