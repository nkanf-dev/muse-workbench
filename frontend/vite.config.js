import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            "/api": {
                target: "http://127.0.0.1:3001",
                changeOrigin: true,
                ws: true,
            },
        },
    },
    build: {
        target: "es2022",
        outDir: "dist",
        rollupOptions: {
            output: {
                manualChunks: {
                    "vendor-react": ["react", "react-dom", "react-router-dom"],
                    "vendor-effect": ["effect"],
                    "vendor-motion": ["motion"],
                    "vendor-xterm": ["@xterm/xterm", "@xterm/addon-fit"],
                },
            },
        },
    },
});
