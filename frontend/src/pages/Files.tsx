import { useMemo, useRef, useState } from "react";
import { Effect } from "effect";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  Download,
  File as FileIcon,
  FilePlus2,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Upload,
  FolderOpen,
  Save,
} from "lucide-react";
import {
  ApiClient,
  buildDownloadUrl,
  formatApiError,
  type FileEntry,
} from "../lib/api";
import { useMutation, useRunner } from "../hooks/useRunner";
import { Page, PageHeader } from "../components/Page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { formatBytes, formatTime, joinPath, parentPath } from "../lib/utils";

interface PreviewState {
  path: string;
  content: string;
  truncated: boolean;
  dirty: boolean;
}

export default function FilesPage() {
  const [path, setPath] = useState("");
  const [createKind, setCreateKind] = useState<"file" | "dir" | null>(null);
  const [newName, setNewName] = useState("");
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameName, setRenameName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* 查询：当前目录列表 */
  const list = useRunner(
    () =>
      Effect.gen(function* () {
        const api = yield* ApiClient;
        return yield* api.listFiles(path);
      }),
    { deps: [path] },
  );

  /* 写操作 mutations */
  const mkdirM = useMutation((p: { path: string }) =>
    Effect.gen(function* () {
      const api = yield* ApiClient;
      yield* api.mkdir(p.path);
    }),
  );
  const writeM = useMutation((p: { path: string; content: string }) =>
    Effect.gen(function* () {
      const api = yield* ApiClient;
      yield* api.writeFile(p.path, p.content);
    }),
  );
  const deleteM = useMutation((p: { path: string }) =>
    Effect.gen(function* () {
      const api = yield* ApiClient;
      yield* api.deletePath(p.path);
    }),
  );
  const renameM = useMutation((p: { from: string; to: string }) =>
    Effect.gen(function* () {
      const api = yield* ApiClient;
      yield* api.renamePath(p.from, p.to);
    }),
  );
  const uploadM = useMutation((p: { dir: string; file: File }) =>
    Effect.gen(function* () {
      const api = yield* ApiClient;
      yield* api.uploadFile(p.dir, p.file);
    }),
  );
  const readM = useMutation((p: { path: string }) =>
    Effect.gen(function* () {
      const api = yield* ApiClient;
      return yield* api.readFile(p.path);
    }),
  );

  const entries = useMemo(() => {
    const arr = list.data ? [...list.data] : [];
    arr.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN");
    });
    return arr;
  }, [list.data]);

  const segments = path === "" ? [] : path.split("/").filter(Boolean);
  const busy = mkdirM.loading || writeM.loading || deleteM.loading || renameM.loading || uploadM.loading;
  const mutError = mkdirM.error ?? writeM.error ?? deleteM.error ?? renameM.error ?? uploadM.error ?? readM.error;

  const openPreview = async (entry: FileEntry) => {
    const result = await readM.run({ path: entry.path });
    if (result) {
      setPreview({ path: entry.path, content: result.content, truncated: result.truncated, dirty: false });
    }
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || !createKind) return;
    const target = joinPath(path, name);
    const ok =
      createKind === "dir"
        ? await mkdirM.run({ path: target })
        : await writeM.run({ path: target, content: "" });
    if (ok !== undefined) {
      setCreateKind(null);
      setNewName("");
      list.refresh();
    }
  };

  const handleRename = async () => {
    const name = renameName.trim();
    if (!name || !renameTarget || name === renameTarget.name) return;
    const to = joinPath(parentPath(renameTarget.path), name);
    const ok = await renameM.run({ from: renameTarget.path, to });
    if (ok !== undefined) {
      setRenameTarget(null);
      list.refresh();
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const ok = await deleteM.run({ path: deleteTarget.path });
    if (ok !== undefined) {
      setDeleteTarget(null);
      list.refresh();
    }
  };

  const handleSavePreview = async () => {
    if (!preview || !preview.dirty) return;
    const ok = await writeM.run({ path: preview.path, content: preview.content });
    if (ok !== undefined) {
      setPreview((p) => (p ? { ...p, dirty: false } : p));
      list.refresh();
    }
  };

  const handleUploadPick = async (file: File | undefined) => {
    if (!file) return;
    const ok = await uploadM.run({ dir: path, file });
    if (ok !== undefined) list.refresh();
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <Page>
      <PageHeader
        title="文件管理"
        description="浏览、编辑与管理服务器上的文件"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setCreateKind("file")}>
              <FilePlus2 className="size-4" /> 新建文件
            </Button>
            <Button variant="outline" size="sm" onClick={() => setCreateKind("dir")}>
              <FolderPlus className="size-4" /> 新建文件夹
            </Button>
            <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadM.loading}>
              <Upload className="size-4" /> 上传
            </Button>
            <Button variant="ghost" size="icon" onClick={list.refresh} title="刷新">
              <RefreshCw className={cn("size-4", list.loading && "animate-spin")} />
            </Button>
          </>
        }
      />
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => void handleUploadPick(e.target.files?.[0])}
      />

      {mutError && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
          <TriangleAlert className="size-4 shrink-0 text-destructive" />
          <span>{formatApiError(mutError)}</span>
        </div>
      )}

      {/* 面包屑 */}
      <div className="mb-4 flex items-center gap-1.5 text-sm">
        {path !== "" && (
          <Button variant="ghost" size="sm" onClick={() => setPath(parentPath(path))} className="gap-1">
            <ArrowLeft className="size-4" /> 上级
          </Button>
        )}
        <button
          onClick={() => setPath("")}
          className={cn(
            "rounded px-1.5 py-0.5 transition-colors hover:bg-accent",
            path === "" ? "font-semibold text-foreground" : "text-muted-foreground",
          )}
        >
          根目录
        </button>
        {segments.map((seg, i) => {
          const full = segments.slice(0, i + 1).join("/");
          const isLast = i === segments.length - 1;
          return (
            <span key={full} className="flex items-center gap-1.5">
              <span className="text-muted-foreground/50">/</span>
              <button
                onClick={() => setPath(full)}
                className={cn(
                  "rounded px-1.5 py-0.5 transition-colors hover:bg-accent",
                  isLast ? "font-semibold text-foreground" : "text-muted-foreground",
                )}
              >
                {seg}
              </button>
            </span>
          );
        })}
        <span className="font-mono2 ml-2 hidden text-xs text-muted-foreground/60 lg:inline">
          /{path}
        </span>
      </div>

      {/* 文件列表 */}
      <Card className="overflow-hidden">
        {list.loading && !list.data && (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        )}

        {list.error && !list.data && (
          <div className="flex items-center gap-4 p-8">
            <TriangleAlert className="size-5 text-destructive" />
            <div className="flex-1 text-sm">
              <div className="font-medium">加载失败</div>
              <div className="text-muted-foreground">{formatApiError(list.error)}</div>
            </div>
            <Button variant="outline" size="sm" onClick={list.refresh}>重试</Button>
          </div>
        )}

        {list.data && entries.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-accent">
              <FolderOpen className="size-7 text-muted-foreground" />
            </div>
            <div className="font-medium">空文件夹</div>
            <p className="max-w-xs text-sm text-muted-foreground">
              这里还没有任何文件，可以新建文件、文件夹或上传。
            </p>
          </div>
        )}

        {entries.length > 0 && (
          <ul className="divide-y divide-border/60">
            <AnimatePresence initial={false}>
              {entries.map((entry) => (
                <motion.li
                  key={entry.path}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      entry.kind === "dir" ? setPath(entry.path) : void openPreview(entry)
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        entry.kind === "dir" ? setPath(entry.path) : void openPreview(entry);
                    }}
                    className="group flex cursor-pointer items-center gap-3 px-4 py-2.5 outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
                  >
                    {entry.kind === "dir" ? (
                      <Folder className="size-5 shrink-0 text-sky-400" />
                    ) : (
                      <FileIcon className="size-5 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{entry.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {entry.kind === "dir" ? "文件夹" : formatBytes(entry.size)}
                        {" · "}
                        {formatTime(entry.modified)}
                      </div>
                    </div>
                    {entry.kind === "file" && (
                      <a
                        href={buildDownloadUrl(entry.path)}
                        download
                        onClick={(e) => e.stopPropagation()}
                        title="下载"
                        className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-background hover:text-foreground group-hover:opacity-100"
                      >
                        <Download className="size-4" />
                      </a>
                    )}
                    <button
                      title="重命名"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenameName(entry.name);
                        setRenameTarget(entry);
                      }}
                      className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-background hover:text-foreground group-hover:opacity-100"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      title="删除"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(entry);
                      }}
                      className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Card>

      {/* 新建对话框 */}
      <Dialog open={createKind !== null} onOpenChange={(o) => !o && setCreateKind(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{createKind === "dir" ? "新建文件夹" : "新建文件"}</DialogTitle>
            <DialogDescription>
              在 <span className="font-mono2">/{path || ""}</span> 下创建
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={createKind === "dir" ? "文件夹名称" : "文件名，如 notes.txt"}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleCreate()}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateKind(null)}>取消</Button>
            <Button onClick={() => void handleCreate()} disabled={!newName.trim() || busy}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名对话框 */}
      <Dialog open={renameTarget !== null} onOpenChange={(o) => !o && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名</DialogTitle>
            <DialogDescription className="font-mono2 break-all">{renameTarget?.path}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleRename()}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameTarget(null)}>取消</Button>
            <Button
              onClick={() => void handleRename()}
              disabled={!renameName.trim() || renameName === renameTarget?.name || busy}
            >
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              确定要删除 <Badge variant="outline" className="font-mono2 mx-1">{deleteTarget?.name}</Badge>
              吗？此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={busy}>
              <Trash2 className="size-4" /> 删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 预览 / 编辑 */}
      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-mono2 break-all text-base">{preview?.path}</DialogTitle>
            <DialogDescription>
              {preview?.truncated ? "文件较大，仅预览前部内容" : "文本预览 · 可直接编辑"}
              {preview?.dirty && <span className="ml-2 text-amber-400">（有未保存的修改）</span>}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            className="font-mono2 h-[50vh] text-[13px] leading-relaxed"
            value={preview?.content ?? ""}
            onChange={(e) =>
              setPreview((p) => (p ? { ...p, content: e.target.value, dirty: true } : p))
            }
            spellCheck={false}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPreview(null)}>关闭</Button>
            <Button onClick={() => void handleSavePreview()} disabled={!preview?.dirty || writeM.loading}>
              <Save className="size-4" /> 保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
