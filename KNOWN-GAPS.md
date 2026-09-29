# Known gaps

## Built

- **The application**, moved from `agentd/ui` and retargeted at garmd's
  door. The persona picker, the bearer held in `sessionStorage` and nowhere
  else, a 401 anywhere back to the picker, `CardView` with every element
  kind and every state, the queue, the start screen, the task page and the
  run page. 43 component tests.
- **`transport.ts`** — one base URL and one function, so the endpoints can
  land without anything above it moving. The bearer on every call; the
  ledger id and the catalogue digest read off every answer.
- **`api.ts`** — the calls of the design's route table, typed against its
  shapes: the tool listing for a person, the card endpoints, the task
  service's seven methods, an agent's `Invoke` and `GetRun`, the grant.
- **`studiod`** — the bundle, a reverse proxy in front of garmd, two
  development login routes, a drain on `SIGTERM`. Exported as
  `studio.Serve(ctx, studio.Config)`; the binary is flag parsing and a call
  to it. Six Go tests, all through that exported entry point.

## Not built, and why

- **Every endpoint Studio calls.** The card endpoints are synthesised by a
  generator that is not released; the task service is a repository that does
  not exist yet; `sets` and `audience` on a tool listing are not served.
  This repository holds a client written against the design and driven by
  fixtures. Nothing here can be proved against a running plane until those
  land, and the screens are therefore tested against card fixtures rather
  than an integration.
- **The switch.** The agent runner still serves its own copy of this
  application against its own HTTP routes, and that is what the current
  demo runs on. Nothing in this repository is wired into that deployment,
  on purpose: the switch is a later step and it removes the runner's routes
  in the same release.
- **Minting the approval grant.** The design has the deciding person's own
  client mint it at the token exchange with the person's own bearer. That
  exchange is a different origin, sends no cross-origin headers, and
  expects a registered client with an assertion — which a browser cannot
  be. `studiod` does not proxy it, because its brief is the bundle and the
  daemon. Until the exchange accepts a public client, an approval refuses
  with a message saying it cannot be signed, and the exchange's address is
  a build-time setting (`VITE_STS_URL`) rather than a default.
- **Addressing a run from a link.** A result card is fetched by the call
  that started the run; a card endpoint belongs to a service. Studio
  therefore needs a call id and a tool, and its run route carries both. It
  has both when it starts the run. A run reached from another card's link
  carries one id and no tool, and that page says so. The fix is for a run
  reference to name the service that serves its card.
- **The step table's source.** The design keeps the run's transcript index
  on `GetRun`. The run status message has no step list today, so the table
  reads one if it is there and says "no steps recorded yet" otherwise.
- **Listing a person's runs.** No call in the design does it. The Runs page
  is a place to start one.
- **Typeahead queries.** A card input backed by a query takes the value as
  typed. Running the query as the viewer, bound to the task, with one call
  in flight and a minimum length, is the next piece of the renderer.
- **Triage from Studio.** The task page dispatches `comment`,
  `recommend_approve` and `recommend_decline` to the task service, but no
  card serves those actions yet, so they are untested against anything real.
- **Paging the queue.** `ListTasks` returns a cursor. Studio shows the first
  page and says there is more; it does not yet fetch the next one.
- **Accessibility and keyboard work.** The application was built for a demo.
  Focus order, live regions for an action's result, and a keyboard path
  through the queue have not been gone over.
- **No end-to-end test.** There is nothing to run one against. When the
  endpoints land, the browser scenario belongs here.
