import { token, signOut } from "./auth";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token() ?? ""}`,
      ...(init?.headers ?? {}),
    },
  });
  if (resp.status === 401) {
    // The token expired or the issuer rotated. Dropping it sends the person
    // back to the picker rather than leaving every screen showing an error
    // they cannot act on.
    signOut();
    throw new ApiError(401, "unauthenticated", "your session has expired");
  }
  if (resp.status === 204) return undefined as T;
  const body = await resp.text();
  if (!resp.ok) {
    // The server's own message, as written. internal/http writes every
    // refusal for a person and never quotes an upstream error, so there is
    // nothing here to scrub and nothing to reword: "cannot approve as a
    // delegated identity" tells them exactly what to do.
    let code = "internal";
    let message = "request failed";
    try {
      const parsed = JSON.parse(body);
      code = parsed.code ?? code;
      message = parsed.message ?? message;
    } catch { /* a proxy answered with HTML; the status is what survives */ }
    throw new ApiError(resp.status, code, message);
  }
  return JSON.parse(body) as T;
}

export type TaskState = "open" | "claimed" | "approved" | "declined" | "expired";

// UNSET is what material extraction records for a field the request did not
// set (internal/garmd.Materialise). It is a value like any other and the
// screens show it as one: an absent field is part of what a person is being
// asked to approve, and hiding it would be approving a shape.
export const UNSET = "<unset>";

export interface Task {
  id: string; run_id: string; tool_fqn: string; subject: string;
  material: Record<string, string>; state: TaskState;
  predicate: { min_clearance: string; compartments: string[] };
  created_at: string; expires_at: string;
  claimant?: string; claimed_at?: string;
  decision?: string; decided_by?: string; decided_at?: string;
  reason?: string; grant_jti?: string;
}
export interface TaskEvent { seq: number; at: string; actor: string; kind: string; detail?: Record<string, unknown>; }
export interface RunSummary {
  run_id: string; agent_fqn: string; state: string; door: string;
  started_at: string; reason?: string; finished_at?: string;
  steps_used: number; tool_calls_used: number; tokens_used: number;
}
export interface Step {
  run_id: string; seq: number; kind: string; tool_fqn?: string;
  request_digest?: string; response_digest?: string; ledger_event_id?: string;
  started_at: string; finished_at?: string;
}
// RunStatus is garm.agent.v1.RunStatus in protojson: lowerCamel names, the
// state as its enum name, and the result an Any around a StringValue.
export interface RunStatus {
  runId?: string; state?: string; startedAt?: string; finishedAt?: string;
  error?: string;
  result?: { "@type"?: string; value?: string };
}

export type View = "mine" | "queue" | "done";
export interface TaskPage { tasks: Task[]; truncated: boolean; }

export const listTasks = (view: View) =>
  call<{ tasks?: Task[]; truncated?: boolean }>(`/tasks?view=${view}`)
    .then((r): TaskPage => ({ tasks: r.tasks ?? [], truncated: r.truncated ?? false }));
export const getTask = (id: string) =>
  call<{ task: Task; events: TaskEvent[] }>(`/tasks/${encodeURIComponent(id)}`);
export const listRuns = () =>
  call<{ runs?: RunSummary[] }>("/runs?scope=mine").then((r) => r.runs ?? []);
export const getRun = (id: string) =>
  call<{ status: RunStatus; steps: Step[]; tasks: Task[] }>(`/runs/${encodeURIComponent(id)}`);

// ---- Cards (spec 2026-09-29-studio-cards-design §1.1, §5.1) -------------
//
// A Card is protojson of garm.card.v1.Card: lowerCamel names, enums as their
// names, and — because protojson omits every unset field — EVERYTHING here
// is optional. The renderer treats an absent list as empty and an absent
// enum as its zero value (DEFAULT, STYLE_DEFAULT).
export type CardKind = "START" | "TASK" | "RUN";
export type CardState = "OPEN" | "ANSWERED" | "EXPIRED" | "RUNNING" | "COMPLETED" | "FAILED";
export type Emphasis = "DEFAULT" | "HEADING" | "SUBTLE";
export type ActionStyle = "STYLE_DEFAULT" | "POSITIVE" | "DESTRUCTIVE";

export interface CardText { text?: string; emphasis?: Emphasis }
export interface Fact { label?: string; value?: string }
export interface FactSet { facts?: Fact[] }
export interface Section { title?: string; elements?: Element[] }
export interface Choice { title?: string; value?: string }
export interface Query { tool?: string; minChars?: number; pageSize?: number }
// Input.kind is a oneof: exactly one of text/number/date/toggle/choice is
// present, and an empty message ({}) is how protojson says "this one".
export interface CardInput {
  id?: string; label?: string; required?: boolean;
  text?: { maxLen?: number; multiline?: boolean };
  number?: { min?: number; max?: number };
  date?: Record<string, never>;
  toggle?: Record<string, never>;
  choice?: { choices?: Choice[]; query?: Query; multi?: boolean };
}
export interface Element {
  text?: CardText; facts?: FactSet; divider?: Record<string, never>;
  input?: CardInput; section?: Section;
}
export interface Action { id?: string; label?: string; style?: ActionStyle; submit?: { confirmText?: string } }
export interface CardRef { kind?: CardKind; subjectId?: string; title?: string; state?: CardState }
export interface Card {
  kind?: CardKind; subjectId?: string; title?: string; state?: CardState;
  body?: Element[]; actions?: Action[];
  disclosure?: { withheldFields?: string[] };
  refs?: CardRef[]; catalogueDigest?: string;
}

// What the form collected, keyed by Input.id: a string for text, date and a
// single choice, a number for number, a boolean for toggle, string[] for a
// multi choice. The server coerces each into the decision message (§7).
export type CardInputs = Record<string, string | number | boolean | string[]>;

export const getTaskCard = (id: string) =>
  call<Card>(`/tasks/${encodeURIComponent(id)}/card`);
// The card's form of /approve and /decline: the same service call, the
// inputs validated against the decision message on the server (§5.1).
export const submitTaskCard = (id: string, action: string, inputs: CardInputs) =>
  call<void>(`/tasks/${encodeURIComponent(id)}/card`, { method: "POST", body: JSON.stringify({ action, inputs }) });
export const getRunCard = (id: string) =>
  call<Card>(`/runs/${encodeURIComponent(id)}/card`);
export const getStartCard = (agent: string) =>
  call<Card>(`/agents/${encodeURIComponent(agent)}/card`);
// A start card's single action is POST /runs, the route that already exists
// (§9.3 step 6): the form values ARE the agent's input message.
export const startRun = (agent: string, input: CardInputs) =>
  call<{ run_id: string }>("/runs", { method: "POST", body: JSON.stringify({ agent, input }) });
