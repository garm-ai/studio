import { useEffect, useState } from "react";
import { ApiError } from "../api";
import type { Card, CardInputs } from "../api";
import { CardView } from "../components/CardView";

// The agents a person can start from the inbox. A constant, because agentd
// has no agents listing today: the start card is GET /agents/{name}/card,
// one name at a time, and nothing answers "which names?" — the persona's
// reach is checked by that route (404 for an agent they cannot invoke), not
// by a list. When a listing lands, this becomes a fetch and the picker
// below stays as it is.
export const AGENTS = ["support-assistant", "card-guardian", "concierge", "compliance-screen"];

// One agent's start card as this persona sees it. A 404 is not an error: it
// is the server saying this persona may not start this agent (a caller who
// could not start it must not learn it exists from its form), so the agent
// is simply not offered. Anything else IS an error — an expired session, a
// tool plane that is down — and is shown as one.
type Offer = { agent: string; card: Card };

export function Start({ loadCard, start, onStarted }: {
  loadCard: (agent: string) => Promise<Card>;
  start: (agent: string, input: CardInputs) => Promise<{ run_id: string }>;
  onStarted: (runId: string) => void;
}) {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOffers(null);
    setAgent(null);
    setError(null);
    Promise.all(AGENTS.map((a) =>
      loadCard(a).then(
        (card): Offer | null => ({ agent: a, card }),
        (e: unknown) => {
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        },
      ),
    ))
      .then((results) => {
        if (cancelled) return;
        const offered = results.filter((r): r is Offer => r !== null);
        setOffers(offered);
        setAgent(offered[0]?.agent ?? null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "the start card could not be loaded");
      });
    return () => { cancelled = true; };
  }, [loadCard]);

  const selected = offers?.find((o) => o.agent === agent) ?? null;

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
            <button key={o.agent} className={o.agent === agent ? "active" : ""} aria-pressed={o.agent === agent} onClick={() => setAgent(o.agent)}>
              {o.agent}
            </button>
          ))}
        </div>
      )}
      {error && <p role="alert" className="alert">{error}</p>}
      {!offers && !error && <div className="count">Loading…</div>}
      {offers && offers.length === 0 && <div className="count">This persona may not start any agent</div>}
      {selected && (
        <CardView
          key={selected.agent}
          card={selected.card}
          onAction={async (_action, inputs) => {
            const r = await start(selected.agent, inputs);
            onStarted(r.run_id);
          }}
        />
      )}
    </div>
  );
}
