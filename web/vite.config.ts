/// <reference types="vitest" />
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The bundle is embedded in studiod, so it is built with relative asset
// paths: Studio is served from the binary's root today and could be served
// from a prefix tomorrow, and an absolute /assets/ path would 404 the
// moment it is.
//
// The bundle is written into internal/ui/dist rather than web/dist, because
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
    name: "studio-keep-gitkeep",
    closeBundle() {
      writeFileSync(fileURLToPath(new URL(OUT + "/.gitkeep", import.meta.url)), "");
    },
  };
}

// `npm run dev` only. In the binary everything is same-origin: studiod
// serves the bundle, reverse-proxies the garm API to garmd, and forwards
// the two dev login routes to the devkit IdP. The dev server forwards the
// same prefixes to a running studiod so that `npm run dev` and the binary
// behave alike.
//
// The prefixes are the garm packages Studio calls (spec §6) plus /idp. A
// path is a governed method — `/garm.tasks.v1.TasksService/ListTasks` — so
// the prefix is the package, and a deployment that serves other packages
// adds them here or points STUDIOD_URL at something that already does.
const studiod = process.env.STUDIOD_URL ?? "http://127.0.0.1:7480";

export default defineConfig({
  plugins: [react(), keepGitkeep()],
  base: "./",
  build: { outDir: OUT, emptyOutDir: true },
  server: {
    proxy: {
      "/garm.": studiod,
      "/bank.": studiod,
      "/payments.": studiod,
      "/idp": studiod,
      "/studio": studiod,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
  },
});
