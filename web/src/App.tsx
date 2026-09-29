import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as api from "./api";
import { signOut, token, whoAmI } from "./auth";
import { CardView } from "./components/CardView";
import { Inbox } from "./screens/Inbox";
import { Login } from "./screens/Login";
import { Start } from "./screens/Start";

// A hash router over five routes — #/, #/tasks/:id, #/runs,
// #/runs/:callId/:tool, #/start — because the bundle is served from a
// single handler: studiod falls back to index.html for any path, but a
// plain static file server would not, and a URL that works from both is
// worth more than a prettier one.
//
// A run is addressed by the call id, because that is what a result card is
// fetched by, and by the tool whose endpoint serves it, because a card
// endpoint belongs to a service (spec 2026-09-29-cards-and-tasks §1.3).
// Studio has both when it starts a run, and a ref to a run carries both,
// so every link into this route is complete.
type Route =
  | { name: "inbox" }
  | { name: "task"; id: string }
  | { name: "runs" }
  | { name: "run"; callId: string; tool: string | null }
  | { name: "start" };

function parse(hash: string): Route {
  const p = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (p[0] === "tasks" && p[1]) return { name: "task", id: decodeURIComponent(p[1]) };
  if (p[0] === "runs" && p[1]) {
    return { name: "run", callId: decodeURIComponent(p[1]), tool: p[2] ? decodeURIComponent(p[2]) : null };
  }
  if (p[0] === "runs") return { name: "runs" };
  if (p[0] === "start") return { name: "start" };
  return { name: "inbox" };
}

export function runHref(started: api.Started, tool: string): string {
  const id = started.callId ?? started.runId;
  return `#/runs/${encodeURIComponent(id)}/${encodeURIComponent(tool)}`;
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

// The tool listing is fetched once per sign-in and held for the session.
//
// It is what a person may be offered — `ListTools {"audience": "PERSON"}`,
// projected by garmd to this viewer (spec §2.5) — and it is also how Studio
// addresses a card endpoint without building a path from parts it guessed.
// A listing that failed is not an empty listing: the screens say so.
function useTools(signedIn: boolean): { tools: api.ToolRow[] | null; error: string | null } {
  const [tools, setTools] = useState<api.ToolRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!signedIn) { setTools(null); setError(null); return; }
    let cancelled = false;
    api.listTools()
      .then((l) => { if (!cancelled) { setTools(l.tools); setError(null); } })
      .catch((e: unknown) => {
        if (cancelled) return;
        setTools(null);
        setError(e instanceof Error ? e.message : "the catalogue could not be read");
      });
    return () => { cancelled = true; };
  }, [signedIn]);
  return { tools, error };
}

export function App() {
  const [signedIn, setSignedIn] = useState(() => token() !== null);
  const route = useHashRoute();
  const { tools, error: toolsError } = useTools(signedIn);

  // A 401 anywhere drops the token (transport.ts) and this is what notices:
  // the next render sees no token and shows the picker.
  const [, bump] = useState(0);
  const onUnauthenticated = useCallback(() => {
    setSignedIn(token() !== null);
    bump((n) => n + 1);
  }, []);

  // The tool Start last submitted, so the hash it lands on names the
  // service whose result card serves the run.
  const startedFrom = useRef<string | null>(null);

  const listAgents = useCallback(
    () => api.listTools().then((l) => l.tools.filter(api.isAgent).filter(isInvoke)).catch(rethrow(onUnauthenticated)),
    [onUnauthenticated],
  );
  const loadStartCard = useCallback((t: api.ToolRow) => {
    const method = api.cardMethod(tools ?? [], t.fqn, "input_card");
    if (!method) return Promise.reject(new api.ApiError(404, "not_found", "this tool serves no form"));
    return api.getCard(method).catch(rethrow(onUnauthenticated));
  }, [tools, onUnauthenticated]);

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
        {toolsError && <p role="alert" className="alert">{toolsError}</p>}
        {route.name === "inbox" && (
          <Inbox load={(v) => api.listTasks(v).catch(rethrow(onUnauthenticated))} />
        )}
        {route.name === "task" && (
          <TaskPage key={`task:${route.id}`} id={route.id} tools={tools ?? []} onUnauthenticated={onUnauthenticated} />
        )}
        {route.name === "runs" && <RunsPage />}
        {route.name === "run" && (
          <RunPage
            key={`run:${route.callId}:${route.tool ?? ""}`}
            callId={route.callId}
            tool={route.tool}
            tools={tools ?? []}
            onUnauthenticated={onUnauthenticated}
          />
        )}
        {route.name === "start" && (
          <Start
            listAgents={listAgents}
            loadCard={loadStartCard}
            start={(t, input) => {
              startedFrom.current = t.fqn;
              return api.invoke(t.method, input).catch(rethrow(onUnauthenticated));
            }}
            onStarted={(s) => { window.location.hash = runHref(s, startedFrom.current ?? ""); }}
          />
        )}
      </main>
    </div>
  );
}

// An agent's row among the card endpoints of the same service: the one
// whose method is the agent's own Invoke.
export const isInvoke = (t: api.ToolRow) => t.method.endsWith("/Invoke");

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
// itself. `children` renders inside the card, above its footers: the run
// page's step table, which stays a table.
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
  children?: (card: api.Card) => ReactNode;
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
          {children?.(card)}
        </CardView>
      )}
    </div>
  );
}

// TaskPage is one page from two cards (spec §2.3, §6).
//
// The tasks tool serves the frame — the values the digest is computed from,
// the audit trail, the decision message's inputs, the actions. The target
// tool serves its own rendering of the same material plus whatever it adds
// at its own labels, and its body stands in for the frame's Material
// section. When the tool's card is refused, unreachable, or does not exist,
// the frame's Material section stands and the footer names what is missing.
// A page is never failed because help was missing.
function TaskPage({ id, tools, onUnauthenticated }: {
  id: string; tools: api.ToolRow[]; onUnauthenticated: () => void;
}) {
  const task = useRef<api.Task | null>(null);

  const load = async () => {
    const t = await api.getTask(id).catch(rethrow(onUnauthenticated));
    task.current = t;
    const frame: api.Card = t.card ?? { kind: "TASK", subjectId: id, title: id };
    const method = t.tool ? api.cardMethod(tools, t.tool, "approval_card") : null;
    if (!method) return frame;
    const toolCard = await api.getCard(method, { taskId: id, material: api.material(frame) }).catch(() => null);
    return api.merge(frame, toolCard, toolCard ? undefined : `${t.tool} approval card`);
  };

  const onAction = async (action: string, inputs: api.CardInputs) => {
    const t = task.current;
    if (!t) throw new Error("the task is not loaded");
    const reason = typeof inputs.reason === "string" ? inputs.reason : "";
    const answer = decisionAnswer(inputs);
    switch (action) {
      case "claim": await api.claimTask(id); return;
      case "release": await api.releaseTask(id); return;
      case "approve": {
        // The grant is minted by the deciding person's own client with the
        // person's own bearer, and travels to the tasks tool in the request
        // that carries the decision (spec §7). Studio holds it for exactly
        // that one call and never stores it.
        const grant = await api.approve(t.tool ?? "", t.subject ?? "", id, api.material(t.card));
        await api.decideTask({ taskId: id, decision: "APPROVE", reason, grant, answer });
        return;
      }
      case "decline": await api.decideTask({ taskId: id, decision: "DECLINE", reason }); return;
      case "answer": await api.decideTask({ taskId: id, decision: "ANSWER", reason, answer }); return;
      case "comment": await api.triageTask(id, "COMMENT", reason); return;
      case "recommend_approve": await api.triageTask(id, "RECOMMEND", reason, "APPROVE"); return;
      case "recommend_decline": await api.triageTask(id, "RECOMMEND", reason, "DECLINE"); return;
      default:
        throw new Error(`this version of Studio does not know the action "${action}"`);
    }
  };

  return (
    <CardPage
      back={{ href: "#/", label: "Inbox" }}
      load={load}
      onAction={onAction}
      onUnauthenticated={onUnauthenticated}
    />
  );
}

// The decision message, coerced from the card's inputs (spec §4.3).
//
// `reason` is on every decision and travels as its own field, so it is not
// repeated here; a task whose decision message is the default carries no
// answer at all. Everything else the form collected is the message, and the
// tasks tool validates it against the descriptor the task pinned.
export function decisionAnswer(inputs: api.CardInputs): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (k === "reason") continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function RunsPage() {
  return (
    <div>
      <div className="topline">
        <div>
          <h2>Runs</h2>
          <div className="sub">A run is opened from the task that asked about it, or from the run you just started.</div>
        </div>
        <a className="btn btn-primary" href="#/start" style={{ textDecoration: "none" }}>Start a run</a>
      </div>
      <div className="empty-state">
        <div className="big">No listing of your runs</div>
        <div className="small">
          There is no call that lists a person's runs. Until there is, this page is a way to start one.
        </div>
      </div>
    </div>
  );
}

// RunPage is the agent's result card, fetched by the call id, with the step
// table under it.
//
// The card endpoint belongs to the agent's own service, so the route names
// the tool as well as the call — from the start form when Studio ran the
// agent, from the ref's `tool_fqn` when the run was reached from a task
// card. The only way to arrive without an endpoint now is a catalogue that
// serves this tool no result card, which is a refusal and not a gap.
function RunPage({ callId, tool, tools, onUnauthenticated }: {
  callId: string; tool: string | null; tools: api.ToolRow[]; onUnauthenticated: () => void;
}) {
  const method = tool ? api.cardMethod(tools, tool, "result_card") : null;
  if (!method) {
    return (
      <div>
        <div className="pagebar"><a className="backlink" href="#/runs">← Runs</a></div>
        <p role="alert" className="alert">
          {tool
            ? `the catalogue offers you no result card for ${tool}`
            : "this link does not name the agent whose card would show the run"}
        </p>
      </div>
    );
  }
  return (
    <CardPage
      back={{ href: "#/runs", label: "Runs" }}
      load={() => api.getCard(method, { callId }).catch(rethrow(onUnauthenticated))}
      onUnauthenticated={onUnauthenticated}
    >
      {(card) => (
        <RunSteps
          method={getRunMethod(tools, tool!)}
          runId={card.subjectId ?? ""}
          onUnauthenticated={onUnauthenticated}
        />
      )}
    </CardPage>
  );
}

// GetRun is the agent's own method, on the same service as its Invoke.
export function getRunMethod(tools: api.ToolRow[], tool: string): string | null {
  const invoke = api.methodOf(tools, tool);
  if (!invoke) return null;
  const service = invoke.slice(0, invoke.lastIndexOf("/"));
  return service ? `${service}/GetRun` : null;
}

// RunSteps is the transcript INDEX from GetRun: digests and the ledger
// event id, never a body. It stays a table inside the run card.
//
// Rows are numbered 1..n in order, not by `seq`: a task step has no row
// here, so the raw sequence skips a number and reads as a missing row. The
// seq is on the cell's title for anybody matching against the ledger.
function RunSteps({ method, runId, onUnauthenticated }: {
  method: string | null; runId: string; onUnauthenticated: () => void;
}) {
  const [steps, setSteps] = useState<api.Step[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!method || !runId) { setSteps([]); return; }
    api.getRun(method, runId)
      .then((r) => setSteps(r.steps ?? []))
      .catch((e: unknown) => {
        if (e instanceof api.ApiError && e.status === 401) onUnauthenticated();
        setError(e instanceof Error ? e.message : "the steps could not be loaded");
      });
  }, [method, runId, onUnauthenticated]);
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
                <tr key={s.seq ?? i}>
                  <td className="mono" title={`seq ${s.seq}`}>{i + 1}</td>
                  <td>{s.kind}</td>
                  <td className="mono">{s.toolFqn ?? ""}</td>
                  <td className="mono">{s.ledgerEventId ?? ""}</td>
                  <td>{s.startedAt ? new Date(s.startedAt).toLocaleTimeString() : ""}</td>
                  <td>{s.finishedAt ? new Date(s.finishedAt).toLocaleTimeString() : "…"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
