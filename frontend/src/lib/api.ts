/**
 * API 层：Effect Schema 定义所有后端响应结构，
 * ApiClient Effect 服务封装 fetch（相对路径，走 Vite proxy）。
 * 组件里只允许通过 `yield* ApiClient` 调用，禁止裸 fetch。
 */
import { Context, Data, Effect, Layer, Schema } from "effect";

/* ------------------------------------------------------------------ */
/* 错误类型                                                            */
/* ------------------------------------------------------------------ */

export class HttpError extends Data.TaggedError("HttpError")<{
  status: number;
  body: string;
}> {}

export class NetworkError extends Data.TaggedError("NetworkError")<{
  message: string;
}> {}

export class DecodeError extends Data.TaggedError("DecodeError")<{
  message: string;
}> {}

export type ApiFailure = HttpError | NetworkError | DecodeError;

/** 把 ApiFailure 翻译成中文展示文案 */
export function formatApiError(e: unknown): string {
  if (typeof e === "object" && e !== null && "_tag" in e) {
    const t = e as { _tag: string; status?: number; body?: string; message?: string };
    switch (t._tag) {
      case "HttpError":
        return `请求失败（HTTP ${t.status ?? "?"}）${t.body ? `：${t.body}` : ""}`;
      case "NetworkError":
        return `网络错误：${t.message || "无法连接服务器"}`;
      case "DecodeError":
        return `数据解析失败：${t.message || ""}`;
      default:
        break;
    }
  }
  return e instanceof Error ? e.message : "未知错误";
}

/* ------------------------------------------------------------------ */
/* Schema：所有 API 响应的结构化定义                                    */
/* ------------------------------------------------------------------ */

export const HealthSchema = Schema.Struct({
  status: Schema.String,
  version: Schema.String,
});
export type Health = Schema.Schema.Type<typeof HealthSchema>;

export const SystemStatsSchema = Schema.Struct({
  hostname: Schema.String,
  uptime_secs: Schema.Number,
  cpu_usage: Schema.Number,
  mem_total: Schema.Number,
  mem_used: Schema.Number,
  load_avg: Schema.Array(Schema.Number),
});
export type SystemStats = Schema.Schema.Type<typeof SystemStatsSchema>;

export const FileKindSchema = Schema.Literal("file", "dir");

export const FileEntrySchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: FileKindSchema,
  size: Schema.Number,
  modified: Schema.Union(Schema.Number, Schema.String),
});
export type FileEntry = Schema.Schema.Type<typeof FileEntrySchema>;

export const FileListSchema = Schema.Struct({
  entries: Schema.Array(FileEntrySchema),
});

export const FileContentSchema = Schema.Struct({
  content: Schema.String,
  truncated: Schema.Boolean,
});
export type FileContent = Schema.Schema.Type<typeof FileContentSchema>;

export const VaultEntryMetaSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.String,
  kind: Schema.String,
  created_at: Schema.Union(Schema.String, Schema.Number),
  updated_at: Schema.Union(Schema.String, Schema.Number),
});
export type VaultEntryMeta = Schema.Schema.Type<typeof VaultEntryMetaSchema>;

export const VaultEntryListSchema = Schema.Array(VaultEntryMetaSchema);

export const VaultRevealSchema = Schema.Struct({
  secret: Schema.String,
});

export const VaultCreateResultSchema = Schema.Struct({
  id: Schema.String,
});

/** 写/删/改类接口的宽松响应（允许空 body） */
export const OkSchema = Schema.Struct({
  ok: Schema.optional(Schema.Boolean),
});

/* ------------------------------------------------------------------ */
/* 凭据库的枚举（UI 下拉用）                                            */
/* ------------------------------------------------------------------ */

export const VAULT_PROVIDERS = [
  "github",
  "openai",
  "anthropic",
  "google",
  "cloudflare",
  "custom",
] as const;
export type VaultProvider = (typeof VAULT_PROVIDERS)[number];

export const VAULT_KINDS = ["api_key", "token", "password", "certificate", "other"] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

export interface VaultEntryInput {
  name: string;
  provider: string;
  kind: string;
  secret?: string;
}

/* ------------------------------------------------------------------ */
/* 认证 token（登录后存 sessionStorage，随标签页销毁）                  */
/* ------------------------------------------------------------------ */

const TOKEN_KEY = "muse-workbench/auth-token";

export const getToken = (): string | null => {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

export const setToken = (token: string): void => {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 存储不可用时忽略，token 仅存于内存 */
  }
};

export const clearToken = (): void => {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
};

/** 用候选 token 探测 /api/health，验证通过返回 true（裸 fetch，不走 Effect） */
export const probeHealth = async (token: string): Promise<boolean> => {
  try {
    const res = await fetch("/api/health", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
};

/** 给 URL 追加 ?token=（WebSocket 与 <a download> 无法设置请求头） */
const withTokenParam = (url: string): string => {
  const t = getToken();
  if (!t) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(t)}`;
};

/** 给请求头注入 Authorization（有 token 时） */
const authHeaders = (init?: RequestInit): HeadersInit => {
  const base = new Headers(init?.headers);
  const t = getToken();
  if (t && !base.has("Authorization")) {
    base.set("Authorization", `Bearer ${t}`);
  }
  return base;
};

/* ------------------------------------------------------------------ */
/* 底层请求原语                                                        */
/* ------------------------------------------------------------------ */

const decodeJson = <A, I>(
  schema: Schema.Schema<A, I>,
  data: unknown,
): Effect.Effect<A, DecodeError> =>
  Schema.decodeUnknown(schema)(data).pipe(
    Effect.mapError(
      (cause) => new DecodeError({ message: `Schema 校验失败：${String(cause)}` }),
    ),
  );

const parseBody = (text: string): Effect.Effect<unknown, DecodeError> => {
  if (text.trim() === "") return Effect.succeed({});
  return Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (e) => new DecodeError({ message: `响应不是合法 JSON：${String(e)}` }),
  });
};

/** 核心请求：fetch → 状态检查 → JSON → Schema 解码，全链路 Effect 化 */
const requestJson = <A, I>(
  schema: Schema.Schema<A, I>,
  path: string,
  init?: RequestInit,
): Effect.Effect<A, ApiFailure> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () => fetch(`/api${path}`, { ...init, headers: authHeaders(init) }),
      catch: (e) =>
        new NetworkError({
          message: e instanceof Error ? e.message : String(e),
        }),
    });
    const text = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (e) =>
        new NetworkError({
          message: `读取响应失败：${e instanceof Error ? e.message : String(e)}`,
        }),
    });
    if (!res.ok) {
      return yield* Effect.fail(
        new HttpError({ status: res.status, body: text.slice(0, 300) }),
      );
    }
    const json = yield* parseBody(text);
    return yield* decodeJson(schema, json);
  });

const postJson = (path: string, body: unknown, method = "POST") =>
  requestJson(OkSchema, path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).pipe(Effect.asVoid);

/** multipart 上传 */
const uploadMultipart = (path: string, file: File): Effect.Effect<void, ApiFailure> =>
  Effect.gen(function* () {
    const form = new FormData();
    form.append("file", file);
    form.append("path", path);
    yield* requestJson(OkSchema, "/files/upload", { method: "POST", body: form });
  }).pipe(Effect.asVoid);

/* ------------------------------------------------------------------ */
/* 纯函数 URL 构造（供 <a> 下载 / WebSocket 直连用）                      */
/* ------------------------------------------------------------------ */

export const buildDownloadUrl = (path: string): string =>
  withTokenParam(`/api/files/download?path=${encodeURIComponent(path)}`);

export const buildTerminalWsUrl = (cols: number, rows: number): string => {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return withTokenParam(
    `${proto}//${window.location.host}/api/terminal/ws?cols=${cols}&rows=${rows}`,
  );
};

/* ------------------------------------------------------------------ */
/* ApiClient Effect 服务                                                */
/* ------------------------------------------------------------------ */

export interface ApiClientShape {
  readonly getHealth: () => Effect.Effect<Health, ApiFailure>;
  readonly getSystemStats: () => Effect.Effect<SystemStats, ApiFailure>;
  readonly listFiles: (path: string) => Effect.Effect<ReadonlyArray<FileEntry>, ApiFailure>;
  readonly readFile: (path: string) => Effect.Effect<FileContent, ApiFailure>;
  readonly writeFile: (path: string, content: string) => Effect.Effect<void, ApiFailure>;
  readonly mkdir: (path: string) => Effect.Effect<void, ApiFailure>;
  readonly deletePath: (path: string) => Effect.Effect<void, ApiFailure>;
  readonly renamePath: (from: string, to: string) => Effect.Effect<void, ApiFailure>;
  readonly uploadFile: (path: string, file: File) => Effect.Effect<void, ApiFailure>;
  readonly downloadUrl: (path: string) => string;
  readonly listVaultEntries: () => Effect.Effect<ReadonlyArray<VaultEntryMeta>, ApiFailure>;
  readonly createVaultEntry: (input: VaultEntryInput) => Effect.Effect<string, ApiFailure>;
  readonly revealVaultEntry: (id: string) => Effect.Effect<string, ApiFailure>;
  readonly updateVaultEntry: (id: string, input: VaultEntryInput) => Effect.Effect<void, ApiFailure>;
  readonly deleteVaultEntry: (id: string) => Effect.Effect<void, ApiFailure>;
  readonly terminalWsUrl: (cols: number, rows: number) => string;
}

export class ApiClient extends Context.Tag("muse-workbench/ApiClient")<
  ApiClient,
  ApiClientShape
>() {}

export const ApiClientLive: Layer.Layer<ApiClient> = Layer.succeed(ApiClient, {
  getHealth: () => requestJson(HealthSchema, "/health"),
  getSystemStats: () => requestJson(SystemStatsSchema, "/system/stats"),

  listFiles: (path) =>
    requestJson(FileListSchema, `/files/list?path=${encodeURIComponent(path)}`).pipe(
      Effect.map((r) => r.entries),
    ),
  readFile: (path) => requestJson(FileContentSchema, `/files/read?path=${encodeURIComponent(path)}`),
  writeFile: (path, content) => postJson("/files/write", { path, content }),
  mkdir: (path) => postJson("/files/mkdir", { path }),
  deletePath: (path) => postJson("/files/delete", { path }),
  renamePath: (from, to) => postJson("/files/rename", { from, to }),
  uploadFile: (path, file) => uploadMultipart(path, file),
  downloadUrl: buildDownloadUrl,

  listVaultEntries: () => requestJson(VaultEntryListSchema, "/vault/entries"),
  createVaultEntry: (input) =>
    requestJson(VaultCreateResultSchema, "/vault/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).pipe(Effect.map((r) => r.id)),
  revealVaultEntry: (id) =>
    requestJson(VaultRevealSchema, `/vault/entries/${encodeURIComponent(id)}/reveal`).pipe(
      Effect.map((r) => r.secret),
    ),
  updateVaultEntry: (id, input) =>
    postJson(`/vault/entries/${encodeURIComponent(id)}`, input, "PUT"),
  deleteVaultEntry: (id) =>
    requestJson(OkSchema, `/vault/entries/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).pipe(Effect.asVoid),

  terminalWsUrl: buildTerminalWsUrl,
});
