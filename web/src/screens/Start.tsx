import { useEffect, useState } from "react";
import { ApiError } from "../api";
import type { Card, CardInputs, Started, ToolRow } from "../api";
import { CardView } from "../components/CardView";

// What a person may start is the catalogue's answer, not Studio's.
//
// `ListTools {"audience": "PERSON"}` returns, per persona, the tools that
// persona's claims reach and whose contract says a person may be offered
// them (spec §2.5). The agents among them are the rows in the `agents` set.
// There is no list of names in this file, and that is the point: the old
// inbox kept one because agentd had no listing, and a hard-coded list is a
// second place the truth is written down.
//
// A tool whose input card cannot be fetched is simply not offered. A 404 is
// not an error here: a caller who could not start a tool must not learn it
// exists from its form. Anything else IS an error — an expired session, a
// plane that is down — and is shown as one.
export interface Offer { tool: ToolRow; card: Card }

export function Start({ listAgents, loadCard, start, onStarted }: {
  listAgents: () => Promise<ToolRow[]>;
  loadCard: (tool: ToolRow) => Promise<Card>;
  start: (tool: ToolRow, input: CardInputs) => Promise<Started>;
  // The started run, as garmd answered it: the run id in the body and the
  // call id on the header, which is the CallRef its result card is fetched
  // by (spec §1.3).
  onStarted: (started: Started) => void;
}) {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOffers(null);
    setChosen(null);
    setError(null);
    listAgents()
      .then((rows) => Promise.all(rows.map((t) =>
        loadCard(t).then(
          (card): Offer | null => ({ tool: t, card }),
          (e: unknown) => {
            if (e instanceof ApiError && e.status === 404) return null;
            throw e;
          },
        ),
      )))
      .then((results) => {
        if (cancelled) return;
        const offered = results.filter((r): r is Offer => r !== null);
        setOffers(offered);
        setChosen(offered[0]?.tool.fqn ?? null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "the start card could not be loaded");
      });
    return () => { cancelled = true; };
  }, [listAgents, loadCard]);

  const selected = offers?.find((o) => o.tool.fqn === chosen) ?? null;

  return (
    <div>
      <div className="topline">
        <div>
          <h2>Start a run</h2>
          <div className="sub">Fill in what the agent needs and start it. Approvals it asks for will appear in the inbox.</div>
        </div>
      </div>
      {offers && offers.length > 1 && (
        <div className="seg" role="tablist">
          {offers.map((o) => (
            <button key={o.tool.fqn} className={o.tool.fqn === chosen ? "active" : ""}
                    aria-pressed={o.tool.fqn === chosen} onClick={() => setChosen(o.tool.fqn)}>
              {o.tool.title || o.tool.fqn}
            </button>
          ))}
        </div>
      )}
      {error && <p role="alert" className="alert">{error}</p>}
      {!offers && !error && <div className="count">Loading…</div>}
      {offers && offers.length === 0 && <div className="count">This persona may not start any agent</div>}
      {selected && (
        <CardView
          key={selected.tool.fqn}
          card={selected.card}
          onAction={async (_action, inputs) => {
            onStarted(await start(selected.tool, inputs));
          }}
        />
      )}
    </div>
  );
}
