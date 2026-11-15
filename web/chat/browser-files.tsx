import { useEffect, useRef, useState } from "react";
import { Download, Paperclip, Upload, X, LoaderCircle } from "lucide-react";

type Target = { id: string; label: string; accept: string };
export function BrowserFiles({
  id,
  client,
  epoch,
  controlled,
  L,
  onError,
  onUploaded,
}: {
  id: string;
  client: string;
  epoch: number;
  controlled: boolean;
  L: (en: string, zh: string) => string;
  onError: (error: unknown) => void;
  onUploaded: () => void;
}) {
  const [open, setOpen] = useState(false),
    [targets, setTargets] = useState<Target[]>([]),
    [downloads, setDownloads] = useState<{ name: string }[]>([]),
    [target, setTarget] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const base = "/api/browser/sessions/" + id;
  const fail = (error: unknown) => {
    setError(error instanceof Error && error.message === 'attachment_too_large' ? L('File exceeds 25 MB.','文件超过 25 MB。') : L('File operation failed. Check the page and try again.','文件操作失败，请检查页面后重试。'));
    onError(error);
  };
  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(base + path, init),
      result = await response.json();
    if (!response.ok) throw Error(result.code);
    return result;
  };
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    let active = true;
    const refresh = async () => {
      try {
        const files = await request("/downloads");
        if (active) setDownloads(files);
      } catch (error) {
        if (active) fail(error);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    if (controlled)
      void request("/upload-targets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client, epoch }),
      })
        .then((items: Target[]) => {
          if (active) {
            setTargets(items);
            setTarget(items[0]?.id ?? "");
          }
        })
        .catch(error=>{if(active)fail(error)});
    else setTargets([]);
    return () => {
      active = false;
      clearInterval(timer);
      trigger.current?.focus();
    };
  }, [open, id, controlled, epoch]);
  const close = () => {
    setOpen(false);
    setFile(null);
    setTargets([]);
    setError("");
  };
  async function upload() {
    if (!file || !target) return;
    setBusy(true);
    setError("");
    try {
      if(file.size>25*1024*1024)throw Error('attachment_too_large');
      const query = new URLSearchParams({
        client,
        epoch: String(epoch),
        target,
        name: file.name,
      });
      await request("/upload?" + query, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      });
      close();
      onUploaded();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        title={L("Browser files", "浏览器文件")}
        aria-label={L("Browser files", "浏览器文件")}
        onClick={() => setOpen(true)}
      >
        <Paperclip size={16} />
      </button>
      {open ? (
        <dialog
          ref={dialog}
          className="browser-dialog browser-files"
          aria-labelledby="browser-files-title"
          onCancel={(e) => {
            if (busy) e.preventDefault();
            else close();
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <header>
            <h2 id="browser-files-title">{L("Files", "文件")}</h2>
            <button
              className="icon-button"
              disabled={busy}
              aria-label={L("Close", "关闭")}
              onClick={close}
            >
              <X size={18} />
            </button>
          </header>
          {error?<p className="browser-error" role="alert">{error}</p>:null}
          {controlled ? (
            <section>
              <h3>{L("Upload to page", "上传到网页")}</h3>
              {targets.length ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void upload();
                  }}
                >
                  {targets.length > 1 ? (
                    <select
                      aria-label={L("Upload field", "上传位置")}
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                    >
                      {targets.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <input
                    aria-label={
                      targets.find((t) => t.id === target)?.label ||
                      L("Choose file", "选择文件")
                    }
                    type="file"
                    accept={targets.find((t) => t.id === target)?.accept}
                    disabled={busy}
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                  <button className="browser-primary" disabled={!file || busy}>
                    {busy ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <Upload size={16} />
                    )}{" "}
                    {L("Upload", "上传")}
                  </button>
                </form>
              ) : (
                <p>{L("No upload field on this page", "此页面没有上传入口")}</p>
              )}
            </section>
          ) : null}
          <section>
            <h3>{L("Downloads", "下载")}</h3>
            {downloads.length ? (
              downloads.map((f) => (
                <a
                  key={f.name}
                  href={base + "/download?name=" + encodeURIComponent(f.name)}
                  download={f.name}
                >
                  <Download size={16} />
                  {f.name}
                </a>
              ))
            ) : (
              <p>{L("No downloads", "暂无下载")}</p>
            )}
          </section>
        </dialog>
      ) : null}
    </>
  );
}
