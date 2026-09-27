import { Effect } from "effect";
import { motion } from "motion/react";
import { FolderOpen, KeyRound, LayoutDashboard, SquareTerminal } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { ApiClient } from "../lib/api";
import { useRunner } from "../hooks/useRunner";
import { Badge } from "./ui/badge";

const NAV = [
  { to: "/", label: "仪表盘", icon: LayoutDashboard, end: true },
  { to: "/terminal", label: "终端", icon: SquareTerminal, end: false },
  { to: "/files", label: "文件", icon: FolderOpen, end: false },
  { to: "/vault", label: "凭据库", icon: KeyRound, end: false },
] as const;

const TITLES: Record<string, { title: string; desc: string }> = {
  "/": { title: "仪表盘", desc: "服务器实时状态一览" },
  "/terminal": { title: "终端", desc: "直连服务器的交互式 Shell" },
  "/files": { title: "文件", desc: "浏览、编辑与管理服务器文件" },
  "/vault": { title: "凭据库", desc: "集中管理 API 密钥与访问凭据" },
};

function HealthDot() {
  const { data, status } = useRunner(() =>
    Effect.gen(function* () {
      const api = yield* ApiClient;
      return yield* api.getHealth();
    }),
  );
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card/60 px-3 py-2">
      <span className="relative flex size-2">
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
            status === "success" ? "bg-emerald-400" : "bg-amber-400",
          )}
        />
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full",
            status === "success" ? "bg-emerald-400" : "bg-amber-400",
          )}
        />
      </span>
      <span className="text-xs text-muted-foreground">
        {status === "success" ? `后端在线 · v${data?.version ?? ""}` : "连接中…"}
      </span>
    </div>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const meta = TITLES[location.pathname] ?? TITLES["/"];

  return (
    <div className="flex h-full bg-background text-foreground">
      {/* 左侧边栏 */}
      <aside className="flex w-60 shrink-0 flex-col border-r bg-card/40">
        <div className="flex items-center gap-3 px-5 pb-6 pt-6">
          <div className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 via-purple-500 to-fuchsia-600 shadow-[0_0_24px_-4px_hsl(var(--primary)/0.6)]">
            <SquareTerminal className="size-5 text-white" />
          </div>
          <div className="leading-tight">
            <div className="font-bold tracking-tight">Muse</div>
            <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Workbench
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="relative block">
              {({ isActive }) => (
                <div
                  className={cn(
                    "relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                    isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {isActive && (
                    <motion.span
                      layoutId="nav-active-pill"
                      className="absolute inset-0 rounded-lg bg-accent"
                      transition={{ type: "spring", stiffness: 420, damping: 36 }}
                    />
                  )}
                  <item.icon className="relative z-10 size-4 shrink-0" />
                  <span className="relative z-10">{item.label}</span>
                  {isActive && (
                    <motion.span
                      layoutId="nav-active-dot"
                      className="relative z-10 ml-auto size-1.5 rounded-full bg-primary"
                    />
                  )}
                </div>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="space-y-3 p-4">
          <HealthDot />
          <p className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">
            暗色工作台 · Effect 驱动
          </p>
        </div>
      </aside>

      {/* 右侧主区域 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass sticky top-0 z-30 flex items-center justify-between border-b px-8 py-4">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">{meta.title}</h2>
            <p className="text-xs text-muted-foreground">{meta.desc}</p>
          </div>
          <Badge variant="outline" className="font-mono2 text-[11px]">
            {location.pathname}
          </Badge>
        </header>
        <main className="scroll-slim min-h-0 flex-1 overflow-y-auto px-8 py-6">{children}</main>
      </div>
    </div>
  );
}
