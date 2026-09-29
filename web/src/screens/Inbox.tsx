import { useCallback, useEffect, useState } from "react";
import type { Task, TaskPage, View } from "../api";
import { RefRow } from "../components/RefRow";

const VIEWS: { id: View; label: string }[] = [
  { id: "queue", label: "Queue" },
  { id: "mine", label: "Mine" },
  { id: "done", label: "Done" },
];

const EMPTY: Record<View, [string, string]> = {
  queue: ["Nothing is waiting", "Approvals addressed to you will appear here."],
  mine: ["Nothing is waiting for you", "Tasks you claim will appear here."],
  done: ["Nothing decided yet", "Tasks you approved or declined will appear here."],
};

export function Inbox({
  load,
}: {
  // A bare list is accepted as a complete page, so a caller that has no
  // notion of truncation need not invent one.
  load: (view: View) => Promise<Task[] | TaskPage>;
}) {
  const [view, setView] = useState<View>("queue");
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clearing first: a tab switch that kept the previous tab's rows on screen
  // until the new list answered would show approved tasks under "Queue".
  const refresh = useCallback(async (v: View) => {
    setError(null);
    setTasks(null);
    try {
      const page = await load(v);
      if (Array.isArray(page)) {
        setTasks(page);
        setTruncated(false);
      } else {
        setTasks(page.tasks);
        setTruncated(page.truncated);
      }
    } catch (e) {
      // Never silently empty: an empty list and a failed load look identical
      // on screen and mean opposite things.
      setTasks(null);
      setError(e instanceof Error ? e.message : "the inbox could not be loaded");
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
      {!error && truncated && (
        <div className="banner banner-amber">
          <div className="grow">
            <strong>Not every task is shown.</strong> The listing is capped; decide some of these and reload to see the rest.
          </div>
        </div>
      )}
      {!error && tasks?.length === 0 && (
        <div className="empty-state">
          <div className="big">{EMPTY[view][0]}</div>
          <div className="small">{EMPTY[view][1]}</div>
        </div>
      )}
      {tasks && tasks.length > 0 && <div className="count">{tasks.length} task{tasks.length === 1 ? "" : "s"}</div>}
      {/* Each row is a CardRef (spec §6): a title, a state, a link to the
          task's card. The subject, the first material values and the
          expiry stay on the row so a person can triage without opening
          one; the card is where the decision is made. */}
      {tasks?.map((t) => (
        <RefRow key={t.id} kind="TASK" id={t.id} title={t.tool_fqn} state={t.state}>
          <div className="kv">
            <span className="k">for</span><span className="mono">{t.subject}</span>
          </div>
          {Object.entries(t.material).slice(0, 3).map(([k, v]) => (
            <div className="kv" key={k}><span className="k mono">{k}</span><span className="v mono">{v}</span></div>
          ))}
          {t.state === "open" && (
            <div className="kv"><span className="k">expires</span><span>{new Date(t.expires_at).toLocaleString()}</span></div>
          )}
          {t.reason && <div className="kv"><span className="k">reason</span><span className="v">{t.reason}</span></div>}
        </RefRow>
      ))}
    </div>
  );
}
