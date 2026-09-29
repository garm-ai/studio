// StateBadge colours a state name. It knows three vocabularies because the
// screens show all three: the task row's lower-case states from GET /tasks,
// the run summary's RunState names from GET /runs, and a card's State (spec
// §1.2). An unknown state is grey rather than unstyled, so a new state is
// still legible before anybody colours it.
export function StateBadge({ state }: { state: string }) {
  const cls: Record<string, string> = {
    open: "badge-amber", claimed: "badge-blue", approved: "badge-green",
    declined: "badge-red", expired: "badge-grey",
    RUNNING: "badge-blue", WAITING_APPROVAL: "badge-amber",
    COMPLETED: "badge-green", FAILED: "badge-red",
    OPEN: "badge-amber", ANSWERED: "badge-green", EXPIRED: "badge-grey",
  };
  return <span className={`badge ${cls[state] ?? "badge-grey"}`}>{state.replace(/_/g, " ").toLowerCase()}</span>;
}
