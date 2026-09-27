import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { PlugZap, RotateCcw } from "lucide-react";
import { Page, PageHeader } from "../components/Page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { buildTerminalWsUrl } from "../lib/api";
import { cn } from "../lib/utils";

type ConnState = "connecting" | "open" | "closed";

const CONN_META: Record<ConnState, { label: string; variant: "warning" | "success" | "secondary" }> = {
  connecting: { label: "连接中", variant: "warning" },
  open: { label: "已连接", variant: "success" },
  closed: { label: "已断开", variant: "secondary" },
};

interface ServerMsg {
  type: "output" | "exit";
  data?: string;
  code?: number;
}

export default function TerminalPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [session, setSession] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 14,
      lineHeight: 1.25,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      scrollback: 5000,
      theme: {
        background: "#0b0e17",
        foreground: "#dbe2f1",
        cursor: "#a78bfa",
        cursorAccent: "#0b0e17",
        selectionBackground: "rgba(139, 92, 246, 0.35)",
        black: "#0b0e17",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e5e7eb",
        brightBlack: "#4b5563",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde047",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#f9fafb",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    term.writeln("\x1b[90m正在建立终端连接…\x1b[0m");

    const ws = new WebSocket(buildTerminalWsUrl(term.cols, term.rows));
    setConn("connecting");

    ws.onopen = () => {
      setConn("open");
      term.focus();
    };
    ws.onmessage = (ev: MessageEvent) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      if (msg.type === "output" && typeof msg.data === "string") {
        term.write(msg.data);
      } else if (msg.type === "exit") {
        term.writeln(`\r\n\x1b[90m— 会话结束（exit code ${msg.code ?? "?"}），可点击重连 —\x1b[0m`);
        setConn("closed");
      }
    };
    const markClosed = () => {
      setConn((c) => (c === "open" ? "closed" : c));
    };
    ws.onclose = markClosed;
    ws.onerror = markClosed;

    const disposeData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    const sendResize = () => {
      try {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch {
        /* 忽略 fit 过程中的瞬时错误 */
      }
    };
    const ro = new ResizeObserver(sendResize);
    ro.observe(el);
    window.addEventListener("resize", sendResize);

    return () => {
      disposeData.dispose();
      ro.disconnect();
      window.removeEventListener("resize", sendResize);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      term.dispose();
    };
  }, [session]);

  const meta = CONN_META[conn];

  return (
    <Page className="flex h-full flex-col">
      <PageHeader
        title="终端"
        description="完整的 PTY 交互 · 支持颜色、快捷键与窗口自适应"
        actions={
          <>
            <Badge variant={meta.variant} className="gap-1.5">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  conn === "open" ? "bg-emerald-400" : conn === "connecting" ? "animate-pulse bg-amber-400" : "bg-muted-foreground",
                )}
              />
              {meta.label}
            </Badge>
            <Button variant="outline" size="sm" onClick={() => setSession((s) => s + 1)}>
              <RotateCcw className="size-4" />
              重连
            </Button>
          </>
        }
      />

      <Card className="flex min-h-[480px] flex-1 flex-col overflow-hidden border-primary/20">
        <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
          <span className="flex gap-1.5">
            <i className="size-2.5 rounded-full bg-[#ff5f57]" />
            <i className="size-2.5 rounded-full bg-[#febc2e]" />
            <i className="size-2.5 rounded-full bg-[#28c840]" />
          </span>
          <span className="font-mono2 ml-2 text-xs text-muted-foreground">ssh · muse-workbench</span>
          <PlugZap className="ml-auto size-3.5 text-muted-foreground/60" />
        </div>
        <div ref={containerRef} className="min-h-0 flex-1 bg-[#0b0e17] p-3 [&_.xterm]:h-full" />
      </Card>

      <p className="mt-3 text-xs text-muted-foreground">
        提示：点击终端区域即可聚焦输入；调整窗口大小会自动同步行列数。
      </p>
    </Page>
  );
}
