import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "../src/core": resolve(__dirname, "dist/core"),
    },
  },
});
