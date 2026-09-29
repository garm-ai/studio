import type { ReactNode } from "react";
import { StateBadge } from "./StateBadge";

// RefRow is a CardRef as a row: a title, a state badge, and a link to the
// card it points at. The queue's rows and a card's refs are the same shape
// on purpose (spec §6: "the queue stays a list of CardRefs").
//
// The href is built here and only here, from server-issued values, encoded.
// A task is addressed by its id alone, because the tasks tool serves every
// task card. A run's card is served by the agent that ran, so its link
// carries the ref's `tool_fqn` as well (spec §1.3) — a ref without one gets
// no link at all rather than a guessed endpoint, which is the same rule a
// ref of an unknown kind has always had.
export function refHref(kind: string | undefined, id: string | undefined, toolFqn?: string): string | null {
  if (!id) return null;
  if (kind === "TASK") return `#/tasks/${encodeURIComponent(id)}`;
  if (kind === "RUN") {
    return toolFqn ? `#/runs/${encodeURIComponent(id)}/${encodeURIComponent(toolFqn)}` : null;
  }
  return null;
}

export function RefRow({ kind, id, title, state, toolFqn, children }: {
  kind?: string; id?: string; title: string; state: string; toolFqn?: string; children?: ReactNode;
}) {
  const href = refHref(kind, id, toolFqn);
  const body = (
    <>
      <div className="row-head">
        <strong>{title}</strong>
        <StateBadge state={state} />
      </div>
      {children}
    </>
  );
  if (!href) return <div className="panel row-btn">{body}</div>;
  return <a className="panel row-btn" href={href}>{body}</a>;
}
