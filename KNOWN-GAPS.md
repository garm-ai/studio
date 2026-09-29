# Known gaps

## Built

- **The application**, moved from `agentd/ui` and retargeted at garmd's
  door. The persona picker, the bearer held in `sessionStorage` and nowhere
  else, a 401 anywhere back to the picker, `CardView` with every element
  kind and every state, the queue, the start screen, the task page and the
  run page. 48 component and transport tests.
- **`transport.ts`** — one base URL and one function, so the endpoints can
  land without anything above it moving. The bearer on every call; the
  ledger id and the catalogue digest read off every answer.
- **`api.ts`** — the calls of the design's route table, typed against its
  shapes: the tool listing for a person, the card endpoints, the task
  service's seven methods, an agent's `Invoke` and `GetRun`, the grant.
- **`studiod`** — the bundle, a reverse proxy in front of garmd, the
  approve route below, two development login routes, a drain on `SIGTERM`.
  Exported as `studio.Serve(ctx, studio.Config)`; the binary is flag parsing
  and a call to it. Thirteen Go tests, all through that exported entry point.
- **The backend for frontend.** `studiod` is a registered client of the
  token service with its own P-256 key, and serves `POST /studio/approve`:
  the person's bearer arrives in the header, `studiod` passes it on as the
  subject token with its own client assertion, and hands the grant back to
  the page. A browser cannot hold a signing key, which is the whole reason
  this route exists and the reason `studiod` is a server rather than a
  static host.

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
- **The grant's task binding.** `POST /studio/approve` asks the token
  service for a grant bound to the task, which is what stops the same
  payment asked twice from sharing one grant. The service does not read that
  field yet, so today the binding is asked for and not enforced.
- **`tool_fqn` on a card reference.** A run reached from a task card is
  fetched through the tool the reference names. The field is in the design
  and not yet in the generated code, so a reference that arrives without one
  renders as a row rather than a link to a page that would fail. When the
  contract ships, every reference is complete and that branch is dead code
  worth deleting.
- **No registered client in any deployment yet.** `studiod` can sign, but
  nothing has registered it: there is no client id and no key for it in a
  running token service, and no compose service runs it. The first
  end-to-end approval needs both.
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
