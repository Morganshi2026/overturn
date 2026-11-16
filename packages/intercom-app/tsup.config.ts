import { defineConfig } from "tsup";

// The Canvas Kit app answers Intercom's POSTs, so the bundle is a server build: one ESM file
// with the handler, the payload builder and the Overturn client.
export default defineConfig({
  entry: { index: "src/server.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: false,
  clean: true,
  minify: false,
  noExternal: ["@overturn-ai/shared"],
  outDir: "dist",
});
