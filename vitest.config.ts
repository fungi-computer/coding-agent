import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "../src/core": resolve(__dirname, "dist/core"),
    },
  },
  test: {
    environment: "node",
  },
});
