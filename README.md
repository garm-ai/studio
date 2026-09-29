# studio

Studio is the front end for garm. It is one screen for the people who work
alongside agents: the queue of approvals waiting on them, the form that
starts a run, the page where a decision is made, and the answer when it is
done.

It draws all of that from **cards**. A card is what a tool sends to be shown
to a person — a form, an answer, or an approval — and every tool serves its
own. Studio asks the daemon for a card and renders what comes back. It has
no screen for payments, none for cards, none for anything else: a new tool
appears in Studio the day it is published, with no change here.

## What Studio does not do

- **It does not decide anything.** Who may see a task, who may approve it,
  and whether an approval is allowed are the daemon's and the task
  service's answers. Studio shows what came back, including a refusal, in
  the words the server used.
- **It does not hide anything.** By the time a card reaches the browser the
  daemon has already removed what this person may not see and listed what it
  removed. Studio renders the whole card and shows that list in the footer.
  There is no filtering in this repository.
- **It is not a service.** It serves no governed method, holds no database,
  and has nothing an agent can call. It is a client with one credential: the
  signed-in person's own token.
- **It talks to one place.** Every card, every listing and every decision is
  a call to the daemon. Studio never calls the agent runner or the task
  service directly.

## What is in here

```
web/        the application: Vite, React, TypeScript, vitest
studio.go   Serve(ctx, Config) — the importable entry point
mount.go    where a request goes: the daemon, the dev login, or the bundle
cmd/studiod flag parsing and a call to Serve
internal/ui the built bundle, embedded
```

## Running it

```
mise install          the toolchain
mise run ui           build the bundle
mise run ui-test      the component tests
mise run test         the Go tests
mise run ci           everything CI runs
mise run run          build the bundle and serve it
```

`studiod` is the reference way to serve Studio. It does two things: serves
the built bundle, and forwards every garm method call to the daemon, so the
browser sees one origin and the daemon needs no cross-origin configuration.

```
studiod --garmd http://garmd:7440 [--listen 127.0.0.1:7480] [--dev-idp-url URL]
```

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--garmd` | `STUDIOD_GARMD` | — (required) |
| `--listen` | `STUDIOD_LISTEN` | `127.0.0.1:7480` |
| `--dev-idp-url` | `STUDIOD_DEV_IDP_URL` | unset. **Development only** |
| `--log-level` | `STUDIOD_LOG_LEVEL` | `info` |

A path with two segments whose first carries a dot —
`/garm.tasks.v1.TasksService/ListTasks` — is a method call and goes to the
daemon, bearer and all. Everything else is the bundle, with a fallback to
the index so that reloading a page inside the application works. `SIGTERM`
closes the listener and gives what is in flight fifteen seconds.

`--dev-idp-url` forwards exactly two routes, `GET /idp/personas` and
`GET /idp/token`, to the development identity provider that the persona
picker uses. That provider mints any identity it is asked for, so the flag
says so at startup and must never be set in a real deployment. Without it
those paths are the application, and the login screen offers a token pasted
from a terminal instead.

**A bank does not have to run `studiod`.** The bundle in `internal/ui/dist`
is a folder of static files. Serving it from an existing web tier and
pointing that tier's proxy at the daemon gives exactly the same result, and
is how this is expected to be deployed. `studiod` exists so that a developer
and a demo have one command.

### Serving it from another program

`Serve` is exported, takes a context and a config, and drains when the
context is cancelled:

```go
err := studio.Serve(ctx, studio.Config{
    Listen:   "127.0.0.1:7480",
    GarmdURL: "http://garmd:7440",
})
```

`cmd/studiod` is flag parsing and a call to that. A development harness that
runs several components in one process calls it the same way, and the tests
in this repository start the server through it, so the exported path is the
tested one.

## Building on it

The application is ordinary Vite and React. Three files carry the shape of
the system:

- `web/src/transport.ts` — the only place that knows a URL. One base, one
  function, the bearer on every call, a 401 back to the picker.
- `web/src/api.ts` — the calls Studio makes and the shape of a card.
- `web/src/components/CardView.tsx` — the renderer: every element kind, the
  form, the actions, the footer that names what was withheld.

Every screen is driven by card fixtures in its tests, so the rendering can
be worked on without a running plane.

## Where it came from, and what happens next

The application moved here from the agent runner, which served it as an
embedded inbox against its own HTTP routes. **The runner keeps its copy
until the switch**; this one is the future. The switch is a step in the
migration the design sets out, and after it the runner serves no HTML and
Studio talks only to the daemon.

## Not yet connected

The endpoints Studio calls are being built in three other repositories. The
client here is written against the design's shapes and every screen is
driven by fixtures, so nothing above the transport moves when the real
endpoints arrive. These are the places where the design does not yet fix a
shape, and what this repository assumed:

- **The card endpoints on every tool.** Studio expects `InputCard`,
  `ResultCard` and `ApprovalCard` on a tool's own service, listed for a
  person as `<tool>_input_card` and so on. It looks each one up in the tool
  listing rather than building a path, so a different suffix costs one
  constant here.
- **The task service.** `ListTasks`, `GetTask`, `ApprovalCard`,
  `ClaimTask`, `ReleaseTask`, `DecideTask` and `TriageTask` on
  `garm.tasks.v1.TasksService`. The queue, the task page and every decision
  are written against these and do not exist yet.
- **`sets` and `audience` on a tool listing.** Studio asks for the tools a
  person may be offered and reads the groups on each row to find the agents.
  Neither field is served today.
- **The step table.** The design keeps the run's transcript index on
  `GetRun`; the run status message has no such field yet, so the table reads
  one if it is there and shows "no steps recorded yet" if it is not.
- **Addressing a run.** A result card is fetched by the call that started
  the run, and a card endpoint belongs to a service, so Studio's run page
  needs both the call and the tool. It has both when it starts a run itself.
  A run reached from a link on another card arrives with one id and no tool,
  and that page says what it cannot address rather than guessing.
- **Minting the approval.** The grant that travels with an approval is
  minted by the signed-in person's own client at the token exchange. That
  exchange is a different origin, is not proxied here, and today expects a
  registered client rather than a browser. Until that is settled, an
  approval says it cannot be signed rather than posting into the void; the
  exchange's address is a build-time setting (`VITE_STS_URL`).
- **Listing a person's runs.** There is no call for it in the design, so
  the Runs page is a way to start one rather than a list.
- **Typeahead queries on a card input.** A query-backed choice takes the
  value as typed. Resolving it against the tool the card names is the next
  piece of the renderer.

`KNOWN-GAPS.md` keeps the same list with the reasons.

## Licence

MIT. See `LICENSE`.
