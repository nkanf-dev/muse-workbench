import { useEffect, useState } from "react";
import { Effect } from "effect";
import { motion } from "motion/react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  ShieldCheck,
  Timer,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  ApiClient,
  VAULT_KINDS,
  VAULT_PROVIDERS,
  formatApiError,
  type ApiFailure,
  type VaultEntryMeta,
} from "../lib/api";
import { useMutation, useRunner } from "../hooks/useRunner";
import { Page, PageHeader } from "../components/Page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { formatTime } from "../lib/utils";

const PROVIDER_BADGE: Record<string, "default" | "success" | "info" | "warning" | "secondary"> = {
  github: "secondary",
  openai: "success",
  anthropic: "warning",
  google: "info",
  cloudflare: "warning",
  custom: "default",
};

const KIND_LABEL: Record<string, string> = {
  api_key: "API 密钥",
  token: "令牌",
  password: "密码",
  certificate: "证书",
  other: "其他",
};

const REVEAL_TTL = 30;

interface Revealed {
  id: string;
  secret: string;
  remaining: number;
}

interface EditorState {
  mode: "create" | "edit";
  entry?: VaultEntryMeta;
}

export default function VaultPage() {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VaultEntryMeta | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [copied, setCopied] = useState(false);

  const list = useRunner(() =>
    Effect.gen(function* () {
      const api = yield* ApiClient;
      return yield* api.listVaultEntries();
    }),
  );

  const saveM = useMutation((p: {
    mode: "create" | "edit";
    id?: string;
    name: string;
    provider: string;
    kind: string;
    secret?: string;
  }) =>
    Effect.gen(function* () {
      const api = yield* ApiClient;
      if (p.mode === "create") {
        yield* api.createVaultEntry({
          name: p.name,
          provider: p.provider,
          kind: p.kind,
          secret: p.secret ?? "",
        });
      } else {
        yield* api.updateVaultEntry(p.id ?? "", {
          name: p.name,
          provider: p.provider,
          kind: p.kind,
          ...(p.secret ? { secret: p.secret } : {}),
        });
      }
    }),
  );

  const deleteM = useMutation((p: { id: string }) =>
    Effect.gen(function* () {
      const api = yield* ApiClient;
      yield* api.deleteVaultEntry(p.id);
    }),
  );

  const revealM = useMutation((p: { id: string }) =>
    Effect.gen(function* () {
      const api = yield* ApiClient;
      return yield* api.revealVaultEntry(p.id);
    }),
  );

  /* 阅后即焚：30 秒倒计时自动隐藏 */
  useEffect(() => {
    if (!revealed) return;
    if (revealed.remaining <= 0) {
      setRevealed(null);
      return;
    }
    const t = setTimeout(
      () => setRevealed((r) => (r ? { ...r, remaining: r.remaining - 1 } : r)),
      1000,
    );
    return () => clearTimeout(t);
  }, [revealed]);

  const mutError = saveM.error ?? deleteM.error ?? revealM.error;

  const handleReveal = async (entry: VaultEntryMeta) => {
    if (revealed?.id === entry.id) {
      setRevealed(null);
      return;
    }
    const secret = await revealM.run({ id: entry.id });
    if (secret !== undefined) {
      setCopied(false);
      setRevealed({ id: entry.id, secret, remaining: REVEAL_TTL });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const ok = await deleteM.run({ id: deleteTarget.id });
    if (ok !== undefined) {
      if (revealed?.id === deleteTarget.id) setRevealed(null);
      setDeleteTarget(null);
      list.refresh();
    }
  };

  const handleCopy = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };

  return (
    <Page>
      <PageHeader
        title="凭据库"
        description="集中管理 API 密钥与访问凭据 · 私钥永不落盘明文展示"
        actions={
          <Button size="sm" onClick={() => setEditor({ mode: "create" })}>
            <Plus className="size-4" /> 添加凭据
          </Button>
        }
      />

      {mutError && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
          <TriangleAlert className="size-4 shrink-0 text-destructive" />
          <span>{formatApiError(mutError)}</span>
        </div>
      )}

      {list.loading && !list.data && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-5 w-2/3" />
              <div className="mt-3 flex gap-2">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="mt-4 h-4 w-1/2" />
            </Card>
          ))}
        </div>
      )}

      {list.error && !list.data && (
        <Card>
          <CardContent className="flex items-center gap-4 py-8">
            <TriangleAlert className="size-5 text-destructive" />
            <div className="flex-1 text-sm">
              <div className="font-medium">加载失败</div>
              <div className="text-muted-foreground">{formatApiError(list.error)}</div>
            </div>
            <Button variant="outline" size="sm" onClick={list.refresh}>重试</Button>
          </CardContent>
        </Card>
      )}

      {list.data && list.data.length === 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-20 text-center"
        >
          <div className="flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 ring-1 ring-primary/30">
            <KeyRound className="size-8 text-primary" />
          </div>
          <div>
            <div className="text-lg font-semibold">还没有任何凭据</div>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              把 GitHub Token、OpenAI API Key 等统一收纳在这里，需要时一键解密查看，阅后即焚。
            </p>
          </div>
          <Button onClick={() => setEditor({ mode: "create" })}>
            <Plus className="size-4" /> 添加第一个凭据
          </Button>
        </motion.div>
      )}

      {list.data && list.data.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.data.map((entry, i) => {
            const isRevealed = revealed?.id === entry.id;
            return (
              <motion.div
                key={entry.id}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.05, 0.3), duration: 0.35 }}
              >
                <Card className="group p-5 transition-colors hover:border-primary/40">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent">
                        <KeyRound className="size-4 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{entry.name}</div>
                        <div className="text-xs text-muted-foreground">
                          更新于 {formatTime(entry.updated_at)}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge variant={PROVIDER_BADGE[entry.provider] ?? "default"}>
                      {entry.provider}
                    </Badge>
                    <Badge variant="outline">{KIND_LABEL[entry.kind] ?? entry.kind}</Badge>
                  </div>

                  {isRevealed && revealed && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      className="overflow-hidden"
                    >
                      <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                        <div className="mb-1.5 flex items-center justify-between text-xs">
                          <span className="flex items-center gap-1 text-amber-400">
                            <Timer className="size-3.5" />
                            {revealed.remaining} 秒后自动隐藏
                          </span>
                          <div className="flex gap-1">
                            <button
                              onClick={() => void handleCopy()}
                              title="复制"
                              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            >
                              {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
                            </button>
                            <button
                              onClick={() => setRevealed(null)}
                              title="立即隐藏"
                              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            >
                              <EyeOff className="size-3.5" />
                            </button>
                          </div>
                        </div>
                        <div className="font-mono2 break-all text-[13px] leading-relaxed text-foreground">
                          {revealed.secret}
                        </div>
                      </div>
                    </motion.div>
                  )}

                  <div className="mt-4 flex items-center gap-1 border-t pt-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleReveal(entry)}
                      disabled={revealM.loading}
                      className={cn(isRevealed && "text-amber-400 hover:text-amber-300")}
                    >
                      <Eye className="size-4" />
                      {isRevealed ? "隐藏" : "解密查看"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditor({ mode: "edit", entry })}
                    >
                      <Pencil className="size-4" /> 编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(entry)}
                      className="ml-auto text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </Card>
              </motion.div>
            );
          })}
        </div>
      )}

      <p className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5" />
        凭据密文由后端加密存储；解密查看需显式操作，且 30 秒后自动隐藏。
      </p>

      {/* 新增 / 编辑 */}
      <VaultEditor
        editor={editor}
        onClose={() => setEditor(null)}
        onSaved={() => {
          setEditor(null);
          list.refresh();
        }}
        saveM={saveM}
      />

      {/* 删除确认 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除凭据</DialogTitle>
            <DialogDescription>
              确定删除 <span className="font-semibold text-foreground">{deleteTarget?.name}</span> 吗？
              密文将被永久销毁，不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleteM.loading}>
              <Trash2 className="size-4" /> 删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function VaultEditor({
  editor,
  onClose,
  onSaved,
  saveM,
}: {
  editor: EditorState | null;
  onClose: () => void;
  onSaved: () => void;
  saveM: {
    loading: boolean;
    error: ApiFailure | undefined;
    run: (p: {
      mode: "create" | "edit";
      id?: string;
      name: string;
      provider: string;
      kind: string;
      secret?: string;
    }) => Promise<unknown>;
  };
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<string>(VAULT_PROVIDERS[0]);
  const [kind, setKind] = useState<string>(VAULT_KINDS[0]);
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  useEffect(() => {
    if (editor?.mode === "edit" && editor.entry) {
      setName(editor.entry.name);
      setProvider(editor.entry.provider);
      setKind(editor.entry.kind);
    } else {
      setName("");
      setProvider(VAULT_PROVIDERS[0]);
      setKind(VAULT_KINDS[0]);
    }
    setSecret("");
    setShowSecret(false);
  }, [editor]);

  const handleSave = async () => {
    if (!editor || !name.trim()) return;
    if (editor.mode === "create" && !secret) return;
    const ok = await saveM.run({
      mode: editor.mode,
      id: editor.entry?.id,
      name: name.trim(),
      provider,
      kind,
      secret: secret || undefined,
    });
    if (ok !== undefined) onSaved();
  };

  return (
    <Dialog open={editor !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editor?.mode === "edit" ? "编辑凭据" : "添加凭据"}</DialogTitle>
          <DialogDescription>
            {editor?.mode === "edit"
              ? "修改元信息；密钥留空则保持不变"
              : "名称、服务商与类型用于归类，密钥将被加密存储"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">名称</label>
            <Input
              autoFocus
              placeholder="如 github-personal-token"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">服务商</label>
              <Select
                value={provider}
                onValueChange={setProvider}
                options={VAULT_PROVIDERS.map((p) => ({ value: p, label: p }))}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">类型</label>
              <Select
                value={kind}
                onValueChange={setKind}
                options={VAULT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] ?? k }))}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              密钥 {editor?.mode === "edit" && <span className="font-normal text-muted-foreground">（留空不修改）</span>}
            </label>
            <div className="relative">
              <Textarea
                className={cn("font-mono2 pr-10 text-[13px]", !showSecret && "secret-mask")}
                rows={3}
                placeholder={editor?.mode === "edit" ? "不修改请留空" : "粘贴密钥内容"}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowSecret((s) => !s)}
                title={showSecret ? "隐藏" : "显示"}
                className="absolute right-2.5 top-2.5 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>
          {saveM.error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <TriangleAlert className="size-4" /> {formatApiError(saveM.error)}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            onClick={() => void handleSave()}
            disabled={!name.trim() || (editor?.mode === "create" && !secret) || saveM.loading}
          >
            {editor?.mode === "edit" ? "保存修改" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
