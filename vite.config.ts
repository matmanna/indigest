import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: "index.html",
        docs: "docs.html",
        usage: "usage.html",
        keys: "keys.html",
        map: "map.html",
        channels: "channels.html",
        channel: "channel.html",
        subscriptions: "subscriptions.html",
        settings: "settings.html",
        login: "login.html",
        audit: "audit.html",
      },
    },
  },
});
