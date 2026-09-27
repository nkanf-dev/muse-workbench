import { useState } from "react";
import { motion } from "motion/react";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { probeHealth, setToken } from "../lib/api";

interface LockScreenProps {
  onUnlock: () => void;
}

/** 登录锁屏：输入访问令牌，验证通过后进入工作台。 */
export default function LockScreen({ onUnlock }: LockScreenProps) {
  const [token, setTokenInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = token.trim();
    if (!t || checking) return;
    setChecking(true);
    setError(null);
    const ok = await probeHealth(t);
    setChecking(false);
    if (ok) {
      setToken(t);
      onUnlock();
    } else {
      setError("令牌无效或服务器不可达，请重试。");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="w-full max-w-sm"
      >
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-2xl">
              🔐
            </div>
            <CardTitle>Muse Workbench</CardTitle>
            <CardDescription>请输入访问令牌以解锁工作台</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <Input
                type="password"
                autoComplete="current-password"
                autoFocus
                placeholder="访问令牌"
                value={token}
                onChange={(e) => setTokenInput(e.target.value)}
                disabled={checking}
              />
              {error && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-sm text-destructive"
                >
                  {error}
                </motion.p>
              )}
              <Button type="submit" className="w-full" disabled={checking || !token.trim()}>
                {checking ? "验证中…" : "解锁"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
