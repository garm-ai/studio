import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as api from "./api";
import { signOut, token, whoAmI } from "./auth";
import { CardView } from "./components/CardView";
import { StateBadge } from "./components/StateBadge";
import { Inbox } from "./screens/Inbox";
import { Login } from "./screens/Login";
import { Start } from "./screens/Start";

// A hash router over five routes — #/, #/tasks/:id, #/runs, #/runs/:id,
// #/start — because the bundle is served from a single handler:
// internal/http falls back to index.html for any path, but a plain static
// file server would not, and a URL that works from both is worth more than
// a prettier one.
type Route =
  | { name: "inbox" }
  | { name: "task"; id: string }
  | { name: "runs" }
  | { name: "run"; id: string }
  | { name: "start" };

function parse(hash: string): Route {
  const p = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (p[0] === "tasks" && p[1]) return { name: "task", id: decodeURIComponent(p[1]) };
  if (p[0] === "runs" && p[1]) return { name: "run", id: decodeURIComponent(p[1]) };
  if (p[0] === "runs") return { name: "runs" };
  if (p[0] === "start") return { name: "start" };
  return { name: "inbox" };
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function App() {
  const [signedIn, setSignedIn] = useState(() => token() !== null);
  const route = useHashRoute();

  // A 401 anywhere drops the token (api.ts) and this is what notices: the
  // next render sees no token and shows the picker.
  const [, bump] = useState(0);
  const onUnauthenticated = useCallback(() => {
    setSignedIn(token() !== null);
    bump((n) => n + 1);
  }, []);

  if (!signedIn) {
    return <Login onSignedIn={() => { setSignedIn(true); window.location.hash = "#/"; }} />;
  }

  const who = whoAmI();
  return (
    <div className="shell">
      <nav className="rail" aria-label="Sections">
        <div className="mark">AI</div>
        <a className={`rail-item ${route.name === "inbox" || route.name === "task" ? "active" : ""}`} href="#/">Inbox</a>
        <a className={`rail-item ${route.name === "runs" || route.name === "run" ? "active" : ""}`} href="#/runs">Runs</a>
        <a className={`rail-item ${route.name === "start" ? "active" : ""}`} href="#/start">Start</a>
        <div className="rail-foot">
          {who && <span className="rail-who mono" title={who}>{shortWho(who)}</span>}
          <button className="rail-item" onClick={() => { signOut(); setSignedIn(false); }}>Sign out</button>
        </div>
      </nav>
      <main className="main">
        {route.name === "inbox" && (
          <Inbox load={(v) => api.listTasks(v).catch(rethrow(onUnauthenticated))} />
        )}
        {route.name === "task" && (
          <CardPage
            key={`task:${route.id}`}
            back={{ href: "#/", label: "Inbox" }}
            load={() => api.getTaskCard(route.id)}
            // POST /tasks/{id}/card is the card's form of /approve and
            // /decline; the reload afterwards shows what the server
            // recorded, not what the click assumed.
            onAction={(action, inputs) => api.submitTaskCard(route.id, action, inputs)}
            onUnauthenticated={onUnauthenticated}
          />
        )}
        {route.name === "runs" && <RunsPage onUnauthenticated={onUnauthenticated} />}
        {route.name === "run" && (
          <CardPage
            key={`run:${route.id}`}
            back={{ href: "#/runs", label: "Runs" }}
            load={() => api.getRunCard(route.id)}
            onUnauthenticated={onUnauthenticated}
          >
            <RunSteps id={route.id} onUnauthenticated={onUnauthenticated} />
          </CardPage>
        )}
        {route.name === "start" && (
          <Start
            loadCard={(agent) => api.getStartCard(agent).catch(rethrow(onUnauthenticated))}
            start={(agent, input) => api.startRun(agent, input).catch(rethrow(onUnauthenticated))}
            onStarted={(runId) => { window.location.hash = `#/runs/${encodeURIComponent(runId)}`; }}
          />
        )}
      </main>
    </div>
  );
}

// shortWho is the rail's label for a subject: the handle without its
// "employee:" prefix, because the rail is 76px wide and the prefix is the
// part everybody shares. The full subject stays on the title, and a
// delegated token's "agent for person" shape survives as "agent for person".
function shortWho(who: string): string {
  return who.replace(/[A-Za-z0-9_.-]+:/g, "");
}

// rethrow lets the app react to a 401 (the token is already gone) while the
// screen still gets the error to show.
function rethrow(onUnauthenticated: () => void) {
  return (e: unknown): never => {
    if (e instanceof api.ApiError && e.status === 401) onUnauthenticated();
    throw e;
  };
}

// CardPage is the task page and the run page: one card, loaded from its
// route, rendered by CardView, reloaded after every action and on the
// Reload button — and on nothing else, because a card never refreshes
// itself (spec §1.3). `children` renders inside the card, above its
// footers: the run page's step table, which the spec keeps a table (§2.3).
//
// After a successful action the card is reloaded twice: at once, and again
// SETTLE_MS later. The first shows what the server recorded; the second
// catches what the action set in motion — the run a decision resumed is
// still RUNNING in the first answer and its ref on the answered task card
// would otherwise read "running" until somebody pressed Reload.
//
// The caller keys it by the route's id: `load` closes over that id, and a
// new id must mean a new page (fresh card, fresh form), not a stale one.
export const SETTLE_MS = 1500;

function CardPage({ back, load, onAction, onUnauthenticated, children }: {
  back: { href: string; label: string };
  load: () => Promise<api.Card>;
  onAction?: (action: string, inputs: api.CardInputs) => Promise<void>;
  onUnauthenticated: () => void;
  children?: ReactNode;
}) {
  const [card, setCard] = useState<api.Card | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (settle.current) clearTimeout(settle.current); }, []);

  const refresh = useCallback(async () => {
    try {
      setCard(await load());
      setError(null);
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 401) {
        onUnauthenticated();
        return;
      }
      setError(e instanceof Error ? e.message : "the card could not be loaded");
    }
    // Not [load]: it is a fresh closure every render, and the id it
    // closes over is fixed by the key above.
  }, [onUnauthenticated]);

  useEffect(() => { void refresh(); }, [refresh]);

  const afterAction = async (action: string, inputs: api.CardInputs) => {
    if (!onAction) return;
    await onAction(action, inputs).catch(rethrow(onUnauthenticated));
    await refresh();
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => { settle.current = null; void refresh(); }, SETTLE_MS);
  };

  return (
    <div>
      <div className="pagebar">
        <a className="backlink" href={back.href}>← {back.label}</a>
        <button className="btn btn-ghost" onClick={() => void refresh()}>Reload</button>
      </div>
      {error && <p role="alert" className="alert">{error}</p>}
      {!card && !error && <div className="count">Loading…</div>}
      {card && (
        <CardView card={card} onAction={onAction && afterAction}>
          {children}
        </CardView>
      )}
    </div>
  );
}

function RunsPage({ onUnauthenticated }: { onUnauthenticated: () => void }) {
  const [runs, setRuns] = useState<api.RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.listRuns()
      .then(setRuns)
      .catch((e: unknown) => {
        if (e instanceof api.ApiError && e.status === 401) onUnauthenticated();
        setError(e instanceof Error ? e.message : "runs could not be listed");
      });
  }, [onUnauthenticated]);
  return (
    <div>
      <div className="topline">
        <div>
          <h2>Runs</h2>
          <div className="sub">Runs you started. A run somebody else started, even one you approved a step of, is not listed here.</div>
        </div>
        <a className="btn btn-primary" href="#/start" style={{ textDecoration: "none" }}>Start a run</a>
      </div>
      {error && <p role="alert" className="alert">{error}</p>}
      {runs?.length === 0 && (
        <div className="empty-state">
          <div className="big">No runs yet</div>
          <div className="small">Start one from the Start screen, or through the API (POST /runs) or the governed door.</div>
        </div>
      )}
      {runs?.map((r) => (
        <a key={r.run_id} className="panel row-btn" href={`#/runs/${encodeURIComponent(r.run_id)}`}>
          <div className="row-head">
            <strong className="mono">{r.agent_fqn}</strong>
            <StateBadge state={r.state} />
          </div>
          <div className="kv"><span className="k">run</span><span className="mono">{r.run_id}</span></div>
          <div className="kv"><span className="k">started</span><span>{new Date(r.started_at).toLocaleString()} · {r.door}</span></div>
          <div className="kv"><span className="k">used</span><span>{r.steps_used} steps · {r.tool_calls_used} tool calls · {r.tokens_used} tokens</span></div>
          {r.reason && <div className="kv"><span className="k">reason</span><span className="mono">{r.reason}</span></div>}
        </a>
      ))}
    </div>
  );
}

// RunSteps is the transcript INDEX from GET /runs/{id}: digests and the
// ledger event id, never a body. It stays a table inside the run card
// (spec §2.3: "the run page's step table stays a table").
//
// Rows are numbered 1..n in order, not by `seq`: a task step has no row
// here, so the raw sequence skips a number and reads as a missing row. The
// seq is on the cell's title for anybody matching against the ledger.
function RunSteps({ id, onUnauthenticated }: { id: string; onUnauthenticated: () => void }) {
  const [steps, setSteps] = useState<api.Step[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.getRun(id)
      .then((r) => setSteps(r.steps ?? []))
      .catch((e: unknown) => {
        if (e instanceof api.ApiError && e.status === 401) onUnauthenticated();
        setError(e instanceof Error ? e.message : "the steps could not be loaded");
      });
  }, [id, onUnauthenticated]);
  return (
    <div className="panel">
      <h4>Steps</h4>
      {error && <p role="alert" className="alert">{error}</p>}
      {!steps && !error && <div className="count">Loading…</div>}
      {steps?.length === 0 && <div className="count">No steps recorded yet.</div>}
      {steps && steps.length > 0 && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>#</th><th>kind</th><th>tool</th><th>ledger event</th><th>started</th><th>finished</th></tr>
            </thead>
            <tbody>
              {steps.map((s, i) => (
                <tr key={s.seq}>
                  <td className="mono" title={`seq ${s.seq}`}>{i + 1}</td>
                  <td>{s.kind}</td>
                  <td className="mono">{s.tool_fqn ?? ""}</td>
                  <td className="mono">{s.ledger_event_id ?? ""}</td>
                  <td>{new Date(s.started_at).toLocaleTimeString()}</td>
                  <td>{s.finished_at ? new Date(s.finished_at).toLocaleTimeString() : "…"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
