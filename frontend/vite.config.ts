import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { contentSecurityPolicy } from "./csp";
export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          terminal: ["@xterm/xterm", "@xterm/addon-fit"],
          react: ["react", "react-dom"],
        },
      },
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
  },
});
