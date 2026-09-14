import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3010,
    host: "127.0.0.1",
    proxy: {
      "/api/deploys": "http://127.0.0.1:3021",
      "/api": "http://127.0.0.1:3020",
      "/health": "http://127.0.0.1:3020",
    },
  },
});
