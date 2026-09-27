import { useEffect, useRef, useState } from "react";
import { Effect } from "effect";
import { animate, motion } from "motion/react";
import {
  Activity,
  Clock,
  Cpu,
  MemoryStick,
  RefreshCw,
  Server,
  TriangleAlert,
} from "lucide-react";
import { ApiClient, formatApiError, type SystemStats } from "../lib/api";
import { useRunner } from "../hooks/useRunner";
import { Page, PageHeader } from "../components/Page";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import { formatBytes, formatUptime } from "../lib/utils";

const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const fmtInt = (n: number) => `${Math.round(n)}`;

/** 数字滚动动画 */
function AnimatedNumber({
  value,
  format,
  className,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
}) {
  const [display, setDisplay] = useState(() => format(value));
  const prev = useRef(value);
  useEffect(() => {
    const controls = animate(prev.current, value, {
      duration: 0.7,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setDisplay(format(v)),
    });
    prev.current = value;
    return () => controls.stop();
  }, [value, format]);
  return <span className={className}>{display}</span>;
}

function Bar({ value, className }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-2 overflow-hidden rounded-full bg-muted", className)}>
      <motion.div
        className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500"
        initial={false}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  );
}

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07 } },
};
const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as const } },
};

function StatSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-4 w-24" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-2 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function StatsGrid({ stats }: { stats: SystemStats }) {
  const memPct = stats.mem_total > 0 ? (stats.mem_used / stats.mem_total) * 100 : 0;
  const cards = [
    {
      icon: Server,
      label: "主机名",
      body: (
        <div className="font-mono2 truncate text-2xl font-bold tracking-tight">
          {stats.hostname}
        </div>
      ),
      foot: (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Activity className="size-3.5" />
          <span>
            负载 {stats.load_avg.map((v) => v.toFixed(2)).join(" · ") || "—"}
          </span>
        </div>
      ),
    },
    {
      icon: Cpu,
      label: "CPU 使用率",
      body: <AnimatedNumber value={stats.cpu_usage} format={fmtPct} className="text-3xl font-bold tracking-tight" />,
      foot: <Bar value={stats.cpu_usage} />,
    },
    {
      icon: MemoryStick,
      label: "内存使用",
      body: (
        <div className="text-3xl font-bold tracking-tight">
          <AnimatedNumber value={memPct} format={fmtPct} />
        </div>
      ),
      foot: (
        <div className="space-y-2">
          <Bar value={memPct} />
          <div className="text-xs text-muted-foreground">
            {formatBytes(stats.mem_used)} / {formatBytes(stats.mem_total)}
          </div>
        </div>
      ),
    },
    {
      icon: Clock,
      label: "运行时间",
      body: (
        <div className="text-2xl font-bold tracking-tight">
          <AnimatedNumber value={stats.uptime_secs} format={(n) => formatUptime(n)} />
        </div>
      ),
      foot: (
        <div className="font-mono2 text-xs text-muted-foreground">
          <AnimatedNumber value={stats.uptime_secs} format={fmtInt} /> 秒
        </div>
      ),
    },
  ];

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"
    >
      {cards.map((c) => (
        <motion.div key={c.label} variants={item}>
          <Card className="group h-full transition-colors hover:border-primary/40">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {c.label}
              </CardTitle>
              <c.icon className="size-4 text-muted-foreground transition-colors group-hover:text-primary" />
            </CardHeader>
            <CardContent className="space-y-3">{c.body}{c.foot}</CardContent>
          </Card>
        </motion.div>
      ))}
    </motion.div>
  );
}

export default function Dashboard() {
  const { data, error, loading, refresh } = useRunner(() =>
    Effect.gen(function* () {
      const api = yield* ApiClient;
      return yield* api.getSystemStats();
    }),
  );

  useEffect(() => {
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <Page>
      <PageHeader
        title="系统状态"
        description="每 5 秒自动刷新 · 数据来自 /api/system/stats"
        actions={
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            刷新
          </Button>
        }
      />

      {loading && !data && <StatSkeleton />}

      {error && !data && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center gap-4 py-8">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-destructive/15">
              <TriangleAlert className="size-5 text-destructive" />
            </div>
            <div className="flex-1">
              <div className="font-medium">获取系统状态失败</div>
              <div className="mt-0.5 text-sm text-muted-foreground">{formatApiError(error)}</div>
            </div>
            <Button variant="outline" size="sm" onClick={refresh}>
              重试
            </Button>
          </CardContent>
        </Card>
      )}

      {data && <StatsGrid stats={data} />}

      {data && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
          className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"
        >
          <span className="relative flex size-1.5">
            <span className="absolute h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative size-1.5 rounded-full bg-emerald-400" />
          </span>
          实时监控中
          {loading && <span className="text-muted-foreground/60">（更新中…）</span>}
        </motion.div>
      )}
    </Page>
  );
}
