import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Node environment, not jsdom: everything under test is server-side routing
 * logic. The React pages are exercised by hand against the running app, not
 * here — see the testing strategy in README.md.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // No provider is ever reached in the suite; a test that tries is a bug.
    env: {
      OPENAI_API_KEY: "",
      GOOGLE_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
