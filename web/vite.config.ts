/// <reference types="vitest" />
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The bundle is embedded in the binary, so it is built with relative asset
// paths: the inbox is served from the binary's root today and could be
// served from a prefix tomorrow, and an absolute /assets/ path would 404
// the moment it is.
//
// The bundle is written into internal/ui/dist rather than ui/dist, because
// `//go:embed` can only see files inside the embedding package's own
// directory. internal/ui/dist/.gitkeep is committed so that
// `//go:embed all:dist` has a file to embed on a checkout that never ran
// npm (internal/ui/embed.go says why). Vite empties dist before every
// build, which would delete it and leave `git status` showing a deletion
// after every `mise run ui`; this plugin puts it back once the bundle is
// written.
const OUT = "../internal/ui/dist";

function keepGitkeep(): Plugin {
  return {
    name: "agentd-keep-gitkeep",
    closeBundle() {
      writeFileSync(fileURLToPath(new URL(OUT + "/.gitkeep", import.meta.url)), "");
    },
  };
}

export default defineConfig({
  plugins: [react(), keepGitkeep()],
  base: "./",
  build: { outDir: OUT, emptyOutDir: true },
  // `npm run dev` only: the API is same-origin in the binary, so the dev
  // server forwards the three API prefixes to a running agentd. The IdP is
  // not proxied — the browser talks to it directly, in both modes.
  server: {
    proxy: {
      "/tasks": process.env.AGENTD_URL ?? "http://127.0.0.1:8090",
      "/runs": process.env.AGENTD_URL ?? "http://127.0.0.1:8090",
      "/agents": process.env.AGENTD_URL ?? "http://127.0.0.1:8090",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
  },
});
