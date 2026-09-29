import { useCallback, useEffect, useState } from "react";
import type { Card, TaskPage, View } from "../api";
import { RefRow } from "../components/RefRow";

// The queue IS `list_tasks` (spec 2026-09-29-cards-and-tasks §6): the tasks
// tool answers with a page of summary cards, each labelled at its task's
// predicate and already projected by garmd to this viewer. A task this
// person may not see is not in the list; there is nothing here to filter
// and nothing here to hide.
const VIEWS: { id: View; label: string }[] = [
  { id: "QUEUE", label: "Queue" },
  { id: "MINE", label: "Mine" },
  { id: "DONE", label: "Done" },
];

const EMPTY: Record<View, [string, string]> = {
  QUEUE: ["Nothing is waiting", "Approvals addressed to you will appear here."],
  MINE: ["Nothing is waiting for you", "Tasks you claim will appear here."],
  DONE: ["Nothing decided yet", "Tasks you approved or declined will appear here."],
};

// How many of a summary card's facts a row shows. A summary card is small
// by design — title, state, requester, expiry, owner, no material — and the
// row is a place to triage from, not the card.
const FACTS_ON_A_ROW = 4;

export function Inbox({
  load,
}: {
  // A bare list is accepted as a complete page, so a caller that has no
  // notion of paging need not invent one.
  load: (view: View) => Promise<Card[] | TaskPage>;
}) {
  const [view, setView] = useState<View>("QUEUE");
  const [cards, setCards] = useState<Card[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clearing first: a tab switch that kept the previous tab's rows on screen
  // until the new list answered would show approved tasks under "Queue".
  const refresh = useCallback(async (v: View) => {
    setError(null);
    setCards(null);
    try {
      const page = await load(v);
      if (Array.isArray(page)) {
        setCards(page);
        setMore(false);
      } else {
        setCards(page.cards);
        setMore(page.cursor !== "");
      }
    } catch (e) {
      // Never silently empty: an empty list and a failed load look identical
      // on screen and mean opposite things.
      setCards(null);
      setError(e instanceof Error ? e.message : "the queue could not be loaded");
    }
  }, [load]);

  useEffect(() => { void refresh(view); }, [view, refresh]);

  return (
    <div>
      <div className="topline">
        <div>
          <h2>Inbox</h2>
          <div className="sub">Approvals an agent is waiting on</div>
        </div>
        <button className="btn btn-ghost" onClick={() => void refresh(view)}>Reload</button>
      </div>
      <div className="seg" role="tablist">
        {VIEWS.map((v) => (
          <button key={v.id} className={v.id === view ? "active" : ""} onClick={() => setView(v.id)}
                  aria-pressed={v.id === view}>
            {v.label}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="alert" style={{ marginBottom: 14 }}>{error}</p>}
      {!error && more && (
        <div className="banner banner-amber">
          <div className="grow">
            <strong>Not every task is shown.</strong> This is one page of the queue; decide some of these and reload to see the rest.
          </div>
        </div>
      )}
      {!error && cards?.length === 0 && (
        <div className="empty-state">
          <div className="big">{EMPTY[view][0]}</div>
          <div className="small">{EMPTY[view][1]}</div>
        </div>
      )}
      {cards && cards.length > 0 && <div className="count">{cards.length} task{cards.length === 1 ? "" : "s"}</div>}
      {/* Each row is the summary card as a CardRef: its title, its state, a
          link to the task, and the facts the tasks tool put on it — whatever
          they are. Studio does not choose which of them a person sees. */}
      {cards?.map((c, i) => (
        <RefRow key={c.subjectId ?? i} kind="TASK" id={c.subjectId} title={c.title ?? c.subjectId ?? ""} state={c.state ?? ""}>
          {summaryFacts(c).slice(0, FACTS_ON_A_ROW).map((f, j) => (
            <div className="kv" key={j}>
              <span className="k">{f.label ?? ""}</span>
              <span className="v mono">{f.value ?? ""}</span>
            </div>
          ))}
        </RefRow>
      ))}
    </div>
  );
}

// Every fact on a summary card, in the order the tool wrote them, one
// Section deep (spec §1.3: a section never nests).
function summaryFacts(card: Card) {
  const out = [];
  for (const el of card.body ?? []) {
    out.push(...(el.facts?.facts ?? []));
    for (const inner of el.section?.elements ?? []) out.push(...(inner.facts?.facts ?? []));
  }
  return out;
}
