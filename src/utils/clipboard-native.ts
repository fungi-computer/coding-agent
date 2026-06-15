import { createRequire } from "module";

export interface ClipboardModule {
  getImageBinary: () => Promise<number[]>;
  hasImage: () => boolean;
  setText: (text: string) => Promise<void>;
}

const require = (() => {
  try {
    return createRequire(
      typeof import.meta.url === "string"
        ? import.meta.url
        : "/virtual/shiitake/coding-agent/clipboard-native.js",
    );
  } catch {
    return () => null;
  }
})();
let clipboard: ClipboardModule | null = null;

const hasDisplay =
  process.platform !== "linux" ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

if (!process.env.TERMUX_VERSION && hasDisplay) {
  try {
    clipboard = require("@mariozechner/clipboard") as ClipboardModule;
  } catch {
    clipboard = null;
  }
}

export { clipboard };
