import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import AppShell from "./components/AppShell";
import LockScreen from "./components/LockScreen";
import Dashboard from "./pages/Dashboard";
import FilesPage from "./pages/Files";
import TerminalPage from "./pages/Terminal";
import VaultPage from "./pages/Vault";
import { clearToken, getToken, probeHealth } from "./lib/api";

function AnimatedRoutes() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/terminal" element={<TerminalPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/vault" element={<VaultPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AnimatePresence>
  );
}

export default function App() {
  // null = 尚未判定（启动时校验已有 token 是否仍然有效）
  const [unlocked, setUnlocked] = useState<boolean | null>(null);

  useEffect(() => {
    const t = getToken();
    if (!t) {
      setUnlocked(false);
      return;
    }
    probeHealth(t).then((ok) => {
      if (!ok) clearToken();
      setUnlocked(ok);
    });
  }, []);

  if (unlocked === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!unlocked) {
    return <LockScreen onUnlock={() => setUnlocked(true)} />;
  }

  return (
    <HashRouter>
      <AppShell>
        <AnimatedRoutes />
      </AppShell>
    </HashRouter>
  );
}
