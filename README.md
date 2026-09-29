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
- **It serves no governed method.** Nothing here is in anybody's catalogue,
  nothing holds a database, and there is nothing an agent can call.
- **The page talks to one place.** Every card, every listing and every
  decision is a call to the daemon, made with the signed-in person's own
  token. The page never calls the agent runner, the task service, or the
  token service.

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

`studiod` is the reference way to serve Studio. It serves the built bundle,
forwards every garm method call to the daemon so the browser sees one
origin, and signs approvals.

```
studiod --garmd http://garmd:7440 [--listen 127.0.0.1:7480]
        [--sts-url URL --sts-client-id ID --sts-client-key-file PEM]
        [--dev-idp-url URL]
```

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--garmd` | `STUDIOD_GARMD` | — (required) |
| `--listen` | `STUDIOD_LISTEN` | `127.0.0.1:7480` |
| `--sts-url` | `STUDIOD_STS_URL` | unset |
| `--sts-client-id` | `STUDIOD_STS_CLIENT_ID` | unset |
| `--sts-client-key-file` | `STUDIOD_STS_CLIENT_KEY_FILE` | unset |
| `--sts-token-audience` | `STUDIOD_STS_TOKEN_AUDIENCE` | `--sts-url` + `/token` |
| `--dev-idp-url` | `STUDIOD_DEV_IDP_URL` | unset. **Development only** |
| `--log-level` | `STUDIOD_LOG_LEVEL` | `info` |

The three token-service flags go together or not at all; with none of them,
approvals refuse with a message saying so and the rest of Studio works,
which is what somebody working on the renderer wants.

A path with two segments whose first carries a dot —
`/garm.tasks.v1.TasksService/ListTasks` — is a method call and goes to the
daemon, bearer and all. Everything else is the bundle, with a fallback to
the index so that reloading a page inside the application works. `SIGTERM`
closes the listener and gives what is in flight fifteen seconds.

### `studiod` holds a key, so it is a server and not a file host

There is one route `studiod` answers itself: `POST /studio/approve`.

When a person approves, their decision has to be signed into a grant by the
token service, and that service authenticates the *application* asking with
a signature over a registered private key. A browser cannot hold such a key.
Letting the token service accept callers that hold no key would empty the
register that says which application is asking, so the answer is the one the
token service's own architecture already draws: a backend for frontend
presents both credentials. `studiod` is that backend.

The page posts the task, the tool, the subject and the material to its own
origin with the person's bearer on it. `studiod` passes that bearer to the
token service as the subject token and adds its own client assertion, then
hands the grant back to the page, which puts it in the `DecideTask` call
that carries the decision. The authority exchanged is still the person's;
what `studiod` adds is proof of which application asked. Nothing is looked
up, stored or logged on the way through, and the page never learns where the
token service is.

That is the honest reason **a bank replacing `studiod` with its own web tier
has to do this job too**: serving the files and proxying to the daemon is
not enough, because something on the server side has to hold the client key.

`--dev-idp-url` forwards exactly two routes, `GET /idp/personas` and
`GET /idp/token`, to the development identity provider that the persona
picker uses. That provider mints any identity it is asked for, so the flag
says so at startup and must never be set in a real deployment. Without it
those paths are the application, and the login screen offers a token pasted
from a terminal instead.

**A bank does not have to run `studiod`.** The bundle in `internal/ui/dist`
is a folder of static files; serving them from an existing web tier and
pointing that tier's proxy at the daemon is how this is expected to be
deployed. What that tier cannot skip is the approve route above — a browser
cannot hold the client key, so the server side signs. `studiod` exists so
that a developer and a demo have one command, and so that there is a
reference for what the web tier has to do.

### Serving it from another program

`Serve` is exported, takes a context and a config, and drains when the
context is cancelled:

```go
err := studio.Serve(ctx, studio.Config{
    Listen:           "127.0.0.1:7480",
    GarmdURL:         "http://garmd:7440",
    STSURL:           "http://sts:8080",
    STSClientID:      "studiod",
    STSClientKeyFile: "/etc/studio/client.pem",
})
```

`STSClientKey` takes an already-loaded key instead of a path, for a caller
that holds one.

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
- **The grant's task binding.** `POST /approve` is asked for a grant bound
  to the task, which is what stops the same payment asked twice from sharing
  one. The token service does not read that field yet.
- **`tool_fqn` on a card reference.** A run reached from a task card is
  fetched through the tool the reference names. The field is in the design
  and not yet in the generated code, so a reference that arrives without one
  is rendered as a row rather than a link.
- **Listing a person's runs.** There is no call for it in the design, so
  the Runs page is a way to start one rather than a list.
- **Typeahead queries on a card input.** A query-backed choice takes the
  value as typed. Resolving it against the tool the card names is the next
  piece of the renderer.

`KNOWN-GAPS.md` keeps the same list with the reasons.

## Licence

MIT. See `LICENSE`.
