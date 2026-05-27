import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  base: "./",
  plugins: [vue()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3100",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
