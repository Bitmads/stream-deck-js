import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Unit tests run in Node. The svelte plugin compiles *.svelte.ts rune modules so store logic can be
// tested too (Tauri APIs are mocked per test file).
export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
