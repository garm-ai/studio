import type { ReactNode } from "react";
import { StateBadge } from "./StateBadge";

// RefRow is a CardRef as a row: a title, a state badge, and a link to the
// card it points at. The queue's rows and a card's refs are the same shape
// on purpose (spec §6: "the queue stays a list of CardRefs").
//
// The href is built here and only here, from a server-issued id, encoded:
// "#/tasks/{id}" or "#/runs/{id}". A ref of any other kind gets no link at
// all rather than a guessed one.
export function refHref(kind: string | undefined, id: string | undefined): string | null {
  if (!id) return null;
  if (kind === "TASK") return `#/tasks/${encodeURIComponent(id)}`;
  if (kind === "RUN") return `#/runs/${encodeURIComponent(id)}`;
  return null;
}

export function RefRow({ kind, id, title, state, children }: {
  kind?: string; id?: string; title: string; state: string; children?: ReactNode;
}) {
  const href = refHref(kind, id);
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
