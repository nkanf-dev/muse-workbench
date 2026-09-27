/**
 * useRunner：把 Effect 跑成 Promise 的 hook。
 * 统一处理 loading / error / data 三态，默认挂载即执行，
 * 也可 immediate: false 做成手动触发（用于写操作）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Effect } from "effect";
import { ApiClient, ApiClientLive, type ApiFailure } from "../lib/api";

export type RunnerStatus = "idle" | "loading" | "success" | "error";

export interface RunnerState<A, E = ApiFailure> {
  status: RunnerStatus;
  loading: boolean;
  data: A | undefined;
  error: E | undefined;
  /** 手动执行一次，返回数据（失败时返回 undefined，错误写入 state） */
  run: () => Promise<A | undefined>;
  /** run 的别名，语义上更像“刷新” */
  refresh: () => void;
}

interface UseRunnerOptions {
  deps?: ReadonlyArray<unknown>;
  immediate?: boolean;
}

export function useRunner<A, E = ApiFailure>(
  makeEffect: () => Effect.Effect<A, E, ApiClient>,
  options: UseRunnerOptions = {},
): RunnerState<A, E> {
  const { deps = [], immediate = true } = options;
  const [status, setStatus] = useState<RunnerStatus>(immediate ? "loading" : "idle");
  const [data, setData] = useState<A | undefined>(undefined);
  const [error, setError] = useState<E | undefined>(undefined);

  const effectRef = useRef(makeEffect);
  effectRef.current = makeEffect;
  const cancelledRef = useRef(false);

  const run = useCallback(async (): Promise<A | undefined> => {
    cancelledRef.current = false;
    setStatus("loading");
    setError(undefined);
    try {
      const result = await Effect.runPromise(
        effectRef.current().pipe(Effect.provide(ApiClientLive)),
      );
      if (cancelledRef.current) return undefined;
      setData(result);
      setStatus("success");
      return result;
    } catch (e) {
      if (cancelledRef.current) return undefined;
      setError(e as E);
      setStatus("error");
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (immediate) {
      void run();
    }
    return () => {
      cancelledRef.current = true;
    };
    // deps 由调用方显式传入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, immediate, ...deps]);

  const refresh = useCallback(() => {
    void run();
  }, [run]);

  return { status, loading: status === "loading", data, error, run, refresh };
}

/**
 * useMutation：手动触发的写操作 hook。
 * fn 接收参数并返回 Effect（内部用 Effect.gen + yield* ApiClient 编写），
 * 调用 run(params) 执行，同样提供 loading / error 三态。
 */
export function useMutation<A, P>(
  fn: (params: P) => Effect.Effect<A, ApiFailure, ApiClient>,
): {
  status: RunnerStatus;
  loading: boolean;
  error: ApiFailure | undefined;
  run: (params: P) => Promise<A | undefined>;
  reset: () => void;
} {
  const [status, setStatus] = useState<RunnerStatus>("idle");
  const [error, setError] = useState<ApiFailure | undefined>(undefined);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async (params: P): Promise<A | undefined> => {
    setStatus("loading");
    setError(undefined);
    try {
      const result = await Effect.runPromise(
        fnRef.current(params).pipe(Effect.provide(ApiClientLive)),
      );
      setStatus("success");
      return result;
    } catch (e) {
      setStatus("error");
      setError(e as ApiFailure);
      return undefined;
    }
  }, []);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(undefined);
  }, []);

  return { status, loading: status === "loading", error, run, reset };
}
