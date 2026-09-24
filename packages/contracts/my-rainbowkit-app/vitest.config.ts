import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pure logic only — the modules under test take plain data and return plain data, so there's no DOM here.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
