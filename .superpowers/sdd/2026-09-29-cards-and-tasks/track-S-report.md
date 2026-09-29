# Track S — Studio

**Date:** 2026-09-29
**Status:** done — `garm-ai/studio` exists, `main` pushed, tagged `v0.1.0` and `v0.2.0`
**Spec:** `spec/docs/superpowers/specs/2026-09-29-cards-and-tasks-as-tools-design.md`
(§1 vocabulary, §2 card endpoints, §2.5 audience, §3 projection, §4 the tasks
tool, §6 Studio over garmd, §7 the STS binding, §9 the migration)

## What was built

`github.com/garm-ai/studio`, public, five commits on `main`.

```
web/                the application: Vite, React 19, TypeScript, vitest
  src/transport.ts  the only file that knows a URL
  src/api.ts        the calls of §6's route table, typed against the spec
  src/App.tsx       the routes, the task page's two cards, the run page
  src/screens/      Login, Inbox (the queue), Start
  src/components/   CardView, RefRow, StateBadge — unchanged from the move
  src/fixtures/     five card fixtures from agentd, plus queue and tools
studio.go           Serve(ctx, Config) — the exported entry point
mount.go            where a request goes; IsAPIPath; the two proxies
cmd/studiod/        flag parsing and a call to Serve
internal/ui/        the built bundle, embedded
mise.toml           ui, ui-test, ui-typecheck, build, test, lint, fmt, dev, run, ci
.github/workflows/  one job: mise run ci
```

`go.mod` is `github.com/garm-ai/studio`, Go 1.26, **no dependencies at all**:
the Go side is standard library only, so `go.sum` does not exist and CI has
nothing to resolve.

## The move (brief item 1)

`agentd/ui` was copied into `web/` verbatim as its own commit
(`c8f4be7`), before any retarget, so that the second commit is reviewable as
a diff. The 42 tests passed on the copy before a line was changed. The
persona picker, the `sessionStorage` bearer, the 401-to-picker behaviour,
`CardView` with every element kind and state, the queue, the start screen,
and the task and run pages all came across. `agentd` was not touched.

`CardView.tsx`, `RefRow.tsx`, `StateBadge.tsx` and their 24 tests are
**byte-identical** to agentd's: the renderer did not need retargeting, which
is the useful evidence that the card vocabulary was the right boundary.

## The retarget (brief item 2)

`transport.ts` holds one base URL (`VITE_GARMD_URL`, empty = this origin,
which is what `studiod` serves) and one function. It POSTs to
`<base>/<package>.<Service>/<Method>` with the person's bearer, reads
garmd's `{code, message}` refusal shape as written, drops the token and
returns to the picker on 401, and hands back `Garm-Event-Id` and
`Garm-Catalogue-Digest` with every answer.

| §6 row | What Studio calls |
|---|---|
| lists agents to start | `ListTools {"audience":"PERSON"}`, rows whose `sets` include `agents` |
| shows a start form | the row's `<tool>_input_card` endpoint, found in the same listing |
| starts a run | the agent's own `Invoke`; the call id off `Garm-Event-Id` |
| shows a run | `<agent>/ResultCard {callId}`, then `<agent>/GetRun {runId}` for the steps |
| the queue | `TasksService/ListTasks {view}` → a page of summary cards |
| opens a task | `TasksService/GetTask`, then `<tool>/ApprovalCard {taskId, material}` |
| claims, releases | `ClaimTask`, `ReleaseTask` |
| approves | `POST <sts>/approve` with the person's bearer, then `DecideTask` with the grant |
| declines, answers | `DecideTask {DECLINE\|ANSWER, reason, answer?}` |
| triages | `TriageTask` |

The hard-coded `AGENTS` array is gone. The material map is built from the
facts carrying `field`, at any depth (§2.3). `merge()` is §6's "one page,
two cards": the tool's body stands in for the frame's Material section and
the two disclosures join into one footer; a missing tool card adds a line to
the footer rather than failing the page.

Three decisions the spec left open, made here and named in the README:

1. **Card endpoints are found, not built.** §2.5 makes every card
   person-facing, so the three synthesised endpoints come back in the same
   `PERSON` listing. Studio looks up `<tool>_input_card` and so on rather
   than composing a service path. A different suffix costs one constant.
2. **A run is addressed by call id *and* tool.** `ResultCard(CallRef)` needs
   the call; a card endpoint belongs to a service, so it also needs the tool.
   Studio has both when it starts a run, and its route carries both. A run
   reached from another card's `CardRef` carries one id and no tool: that
   page says what it cannot address rather than guessing an endpoint. The fix
   belongs in the ref.
3. **`GetTask`, not `ApprovalCard`, for the frame.** §6's table names
   `ApprovalCard`; `GetTask` returns the same card *and* the `tool` and
   `subject` that the grant is minted against, so the task page makes one
   call instead of two. `taskCard()` is in `api.ts` for the other shape.

## `studiod` (brief item 3) — and the exported entry point

Per the coordinator's mid-task note, the server is an exported package and
the binary is a shim.

- **Package `studio`**, at the module root, imported as
  `github.com/garm-ai/studio`. That reads as `studio.Serve(ctx,
  studio.Config{...})` at the call site, which is why it is the root package
  and not `pkg/server` or similar.
- **`type Config struct { Listen, GarmdURL, DevIdPURL string; Assets fs.FS;
  Log *slog.Logger; OnListen func(string) }`**. Nothing is read from a flag
  or the environment inside it. `Assets` defaults to the embedded bundle;
  `OnListen` is how a caller that asked for port 0 learns which port it got.
- **`func Serve(ctx context.Context, cfg Config) error`** blocks until the
  context is cancelled, then closes the listener, gives in-flight requests
  fifteen seconds, and returns nil. Every refusal an operator can fix — no
  garmd URL, a malformed one, a binary with no bundle — happens before the
  listener opens.
- `cmd/studiod/main.go` is flag parsing, a signal context, and one call.
- **Every Go test starts the server through `Serve`**, so the exported path
  is the tested one.

Routing: `/idp/personas` and `/idp/token` to the dev IdP when configured
(GET only, `Authorization` and `Cookie` stripped, everything else under
`/idp` a 404, loud `WARN` at startup); a two-segment path whose first
segment carries a dot to garmd, bearer and all; everything else the bundle
with a single-page fallback and no directory listings. No per-package list
and no configuration, so a catalogue that gains a service is reachable the
day it is published.

## Tests

| Suite | Count | Result |
|---|---|---|
| `web` (vitest) | 43 | pass |
| `tsc --noEmit` | — | clean |
| bundle build | — | 219 kB js, 9.6 kB css |
| Go (`-race`) | 7 | pass |

43 rather than 42: one test was added for approve, which is now two calls in
one click (mint at the exchange, then decide with the grant). The six
`Inbox` and six `Start` tests kept their count and their intent; their
fixtures moved from agentd's task rows and agent-name array to summary cards
and a tool listing, because that is what those screens are now fed. The 24
`CardView` tests are untouched.

## What is not connected, and why

Nothing Studio calls exists yet: Track G tags `garm` v0.17.0, Track D tags
`garmd` v0.3.0, Track K builds `tasksd`. The client is written against the
spec's shapes and every screen is driven by fixtures, so the transport is
the only thing that moves when they land. Named in `README.md` and
`KNOWN-GAPS.md`:

- the three card endpoints on every tool, and their `<tool>_<kind>_card`
  names in a listing;
- the whole of `garm.tasks.v1.TasksService`;
- `sets` and `audience` on a `ListTools` row;
- a step list on `RunStatus` (§6 keeps the step table on `GetRun`; the
  message has no such field);
- a `CardRef` to a run that names the service serving its card;
- the token exchange accepting a browser. §7 has the deciding person's own
  client mint the grant with their own bearer, but today `/approve` expects a
  registered client with an assertion, is a different origin, and sends no
  CORS headers. `studiod` does not proxy it — its brief is the bundle and
  garmd. Until that is settled an approve refuses with a message saying it
  cannot be signed, and the exchange's address is a build-time setting
  (`VITE_STS_URL`) with no default;
- listing a person's runs — no call in the design does it, so the Runs page
  is a place to start one;
- typeahead queries on a card input (§4 of v1) — the value is taken as typed.

## Concerns

1. **The grant path is the one place the design and the world disagree.**
   Everything else here is "the endpoint does not exist yet"; this is "the
   endpoint exists and does not admit this caller". Either the exchange grows
   a public-client flow with CORS for Studio's origin, or `studiod` grows a
   third proxy route and the brief's "no business logic" gets an asterisk.
   Worth a decision before Track K wires `decide_task`.
2. **Addressing a run needs a shape decision** (point 2 above). It is small
   and it is visible in the product today: a link from a task card to its run
   lands on a page that explains itself instead of showing the run.
3. **Nothing here has met a real answer.** Fixtures are hand-written from the
   spec. The first integration will move field names — protojson casing on
   the tasks messages, the exact `ListTools` row for a card endpoint — and
   that is expected; it should land as one commit against `api.ts`.
4. **No end-to-end test**, because there is nothing to run one against. When
   the endpoints land, the browser scenario of 2026-09-29 belongs in this
   repository and not in `agentd/e2e`.
5. **The switch is not scheduled here.** agentd still serves its copy and the
   demo runs on it. Deleting agentd's inbox routes, `internal/card` and its
   bundle is §9 step 4 and belongs to whoever owns that release.


---

# v0.2.0 — the backend for frontend, and a ref that names its tool

Both concerns from v0.1.0 came back with answers, and both were already in
the architecture rather than gaps in it. Amended spec: §7 (`ddb14ec`) and
§1.3 (`e680eb6`).

## `studiod` mints the grant

The hole was real and the fix is not a compromise. A browser cannot hold a
signing key, so it cannot be a registered client of the token service;
teaching that service to accept callers that hold no key would empty the
register that says *which application* is asking. The token service's own
diagram already has a backend for frontend calling the direct door, and
`studiod` is that backend.

- **`internal/sts`** — the client, shaped like `agentd/internal/sts`:
  `private_key_jwt` over P-256, two-minute TTL, single-use `jti`, audience
  defaulting to `--sts-url` + `/token`. The key is unexported and `String`
  and `LogValue` redact it on **value** receivers, so formatting a `Client`
  and a `*Client` both redact. 4xx and 5xx are separate errors: a caller
  that filed a 503 as a refusal would tell a person they may not approve
  when the truth is "try again". One dependency added, `go-jose/v4` at
  agentd's version — hand-rolling ES256 JWS to keep the module
  dependency-free was the wrong trade for a signing path.
- **`POST /studio/approve`**, the only route `studiod` answers itself. The
  person's bearer in the header becomes the subject token; `studiod` adds
  its own assertion in the body; the grant goes straight back to the page,
  which puts it in `DecideTask`. Nothing is looked up, stored, logged or
  read on the way through, and the answer carries `Cache-Control: no-store`.
- **Body carries four fields, not two.** The brief said "the task id and the
  material map"; `/approve` also needs `tool` and `subject`. Rather than
  have `studiod` look a task up — which would give it card knowledge and a
  reason to call garmd — the page sends all four off the card the tasks tool
  served. A page that sends the wrong material buys a wrong context beside
  the right one, never a wrong grant.
- **Flags:** `--sts-url`, `--sts-client-id`, `--sts-client-key-file`, plus
  `--sts-token-audience` mirroring agentd's. All three or none, checked at
  startup: two of the three is a deployment that meant to sign approvals and
  would find out at the first click. With none, the route answers `501
  no_token_exchange` and the rest of Studio works.
- **`Config` gains `STSClientKey *ecdsa.PrivateKey`** beside the file path,
  for a test or a harness that already holds one. It wins over the path.
- Six tests, all through `Serve` against a fake token service: the assertion
  is a signed JWT naming the registered client with the right `aud` and a
  `jti`; the bearer is the person's; a request with no bearer never reaches
  the service at all; an incomplete approval is refused before it leaves;
  the upstream's `access_denied` body never reaches the browser; and a
  deployment with no token service says so.

The SPA no longer knows the token service exists: `VITE_STS_URL` is gone
along with the refusal that stood in for it, and the call sits behind
`transport.ts` with the rest. `api.test.ts` is new and holds what actually
leaves the browser — the route, the bearer, the four fields, the refusal
shown as written, the 401 — plus the material reader.

`studiod` answers in garmd's `{code, message}` shape, so one branch in the
browser still handles every refusal Studio can receive.

## A `CardRef` names the tool that serves its card

`tool_fqn` closes it exactly. `refHref` builds `#/runs/<call>/<tool>` from
the ref, the run page's "cannot be addressed" state is gone, and a ref that
arrives without a tool gets no link — the rule an unknown kind always had
here: a row, not a link to a page that would fail. When Track G ships the
field, that branch is dead code worth deleting.

## Tests

| Suite | v0.1.0 | v0.2.0 |
|---|---|---|
| web (vitest) | 43 | **48** (new `api.test.ts`) |
| Go (`-race`) | 7 | **13** |
| `tsc --noEmit`, bundle, `vet`, `gofmt` | clean | clean |

One CI fix on the way: `ui`, `ui-test` and `ui-typecheck` each ran `npm ci`,
and mise runs them in parallel — three processes deleting and rewriting one
`node_modules` is an `ENOTEMPTY` that reads like a broken lockfile. A single
`deps` task installs and the three wait for it. Latent since v0.1.0; it only
bit once the suite grew enough to overlap.

## What is left

- The token service does not read `task_id` yet, so the binding that stops
  the same payment asked twice from sharing a grant is asked for and not
  enforced.
- `tool_fqn` is in the design and not yet in the generated code.
- **Nothing has registered `studiod` as a client anywhere**: no client id, no
  key in a running token service, no compose service. The first end-to-end
  approval needs all three, and that is the next thing to ask for.

## Concerns

1. **`studiod` now holds authority**, and that changes what this repository
   is. It is one key, it is never the person's, and it cannot approve
   anything on its own — the token service still refuses without a person's
   bearer, and the tasks tool and garmd each refuse a grant from a chain
   carrying `act`. But a repository that held nothing now holds something,
   and the deployment story (where the key lives, who rotates it) is not
   written down anywhere yet.
2. **A bank's web tier is no longer a static host.** The README says so
   plainly, but it is a real change to what "replace `studiod`" costs, and
   anyone who read the v0.1.0 README will have the old picture.
3. The rest of v0.1.0's concerns stand: no endpoint Studio calls exists yet,
   the fixtures are hand-written from the spec, and there is no end-to-end
   test because there is nothing to run one against.
