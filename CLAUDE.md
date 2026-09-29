# studio — garm's front end

The renderer for every tool's cards, and `studiod`, which serves it. The
design record is in `../spec`
(`docs/superpowers/specs/2026-09-29-cards-and-tasks-as-tools-design.md`,
§1 the card vocabulary, §2 the card endpoints, §3 projection, §4 the tasks
tool, §6 Studio's route table, §7 the grant, §9 the migration).

## The invariants

- **Studio is a client.** It serves no governed method, holds no store, and
  is not in anybody's catalogue. One credential: the signed-in person's own
  bearer.
- **One door.** Every card, every listing and every decision is a call to
  garmd. Nothing here talks to agentd, to `tasksd`, or to any tool service
  directly.
- **Studio never filters.** garmd dropped what the viewer may not see before
  the answer left the door and named it in `Disclosure`. The renderer shows
  the whole card and shows that list. A line of code here that hides an
  element is a bug, not a feature.
- **Studio never decides.** Four-eyes, clearance, who may claim and who may
  approve are the tasks tool's and garmd's answers. A refusal is rendered in
  the words the server used.
- **Studio never guesses a path.** Two platform contracts are constants
  (`garm.tasks.v1.TasksService`, the tool catalogue); every other method
  comes from a `ListTools` row.
- **Studio computes one thing:** the material map for a `TaskRef` and for
  the grant, read from the facts the tasks tool served. Getting it wrong
  wastes a click and can never buy a wrong grant.
- **`studiod` has no business logic.** The bundle, a reverse proxy, two
  development login routes. It knows nothing about cards.

## Working here

```
mise install     the toolchain
mise run ci      everything CI runs
```

Do not change `agentd`, `garmd`, or anything under `agentd/deploy` from
here. The runner keeps its own copy of this application until the switch
(spec §9 step 4), and the demo runs on it.

Documentation is updated in the same commit as the fact it states: this
file, `README.md`, `KNOWN-GAPS.md`.

## Public repository

This repository is public. No customer, tenant or hostname anywhere — not
in a README, not in a comment, not in a fixture. Fixtures use generic
subjects and documentation values.
