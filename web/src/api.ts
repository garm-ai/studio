// api is Studio's picture of garmd's door: the calls of the design's route
// table (spec 2026-09-29-cards-and-tasks §6), each one an ordinary governed
// RPC made with the person's own bearer.
//
// Three things are worth knowing before reading it.
//
// Studio never filters. garmd has already dropped every element the viewer
// may not see and named what it dropped in `Disclosure` (§3); what arrives
// here is what this person is allowed to read, and the renderer's job is to
// show all of it, including the footer that says something was withheld.
//
// Studio never guesses a path. The two platform contracts — the tasks tool
// and the tool catalogue — are constants below, because they are fixed by
// the spec. Every other path comes from a `ListTools` row.
//
// Studio computes one thing: the material map that a `TaskRef` and the
// token exchange's /approve both take, built from the facts the tasks tool
// served (§2.3). A Studio that got that wrong wastes a click — the digest
// is computed from what the tasks tool stored, never from what Studio sent.
import { APPROVE, ApiError, post, rpc } from "./transport";

export { ApiError };

// ---- Cards (spec §1) ----------------------------------------------------
//
// A Card is protojson of garm.card.v1.Card: lowerCamel names, enums as their
// names, and — because protojson omits every unset field — EVERYTHING here
// is optional. The renderer treats an absent list as empty and an absent
// enum as its zero value (DEFAULT, STYLE_DEFAULT).
export type CardKind = "START" | "TASK" | "RUN" | "ASK";
export type CardState = "OPEN" | "ANSWERED" | "EXPIRED" | "RUNNING" | "COMPLETED" | "FAILED";
export type Emphasis = "DEFAULT" | "HEADING" | "SUBTLE";
export type ActionStyle = "STYLE_DEFAULT" | "POSITIVE" | "DESTRUCTIVE";

// Label is who may see an element. It is set by the tool that served the
// card and read by garmd, which removes what the viewer does not reach
// before the answer leaves the door. Studio reads it for nothing: an
// element that arrived is an element this person may see.
export interface Label { clearance?: string; compartments?: string[] }

export interface CardText { text?: string; emphasis?: Emphasis }
// `field` is the source path of the value, when there is one. It is what
// lets Studio rebuild the material map for a TaskRef (§2.3) without knowing
// what any of the values mean.
export interface Fact { label?: string; value?: string; field?: string; access?: Label }
export interface FactSet { facts?: Fact[] }
export interface Section { title?: string; elements?: Element[] }
export interface Choice { title?: string; value?: string; access?: Label }
export interface Query { tool?: string; minChars?: number; pageSize?: number }
// Input.kind is a oneof: one of text/number/date/toggle/choice is
// present and the rest are absent; an empty message ({}) is how protojson
// says "this one".
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
  access?: Label;
}
export interface Action { id?: string; label?: string; style?: ActionStyle; submit?: { confirmText?: string } }
// A ref points at another card — a task card at its run, a run card at its
// tasks. `toolFqn` names the service that serves it, because a kind and an
// id are not enough to fetch a card: a `ResultCard` or an `ApprovalCard`
// belongs to a tool. With it, any ref is enough on its own and the client
// needs no table of its own (spec §1.3).
export interface CardRef { kind?: CardKind; subjectId?: string; title?: string; state?: CardState; toolFqn?: string }
export interface Card {
  kind?: CardKind; subjectId?: string; title?: string; state?: CardState;
  body?: Element[]; actions?: Action[];
  disclosure?: { withheldFields?: string[] };
  refs?: CardRef[]; catalogueDigest?: string;
  access?: Label;
}

// What the form collected, keyed by Input.id: a string for text, date and a
// single choice, a number for number, a boolean for toggle, string[] for a
// multi choice. The tool coerces each into its message and validates it.
export type CardInputs = Record<string, string | number | boolean | string[]>;

// ---- The tool catalogue (spec §2.5) -------------------------------------

export const LIST_TOOLS = "/garm.v1.ToolCatalogService/ListTools";

// A ListTools row, in the JSON garmd writes (snake_case, hand-spelled
// there because it is a contract and not a serialisation detail).
export interface ToolRow {
  fqn: string;
  method: string;
  title?: string;
  description?: string;
  verb?: string;
  approval_mode?: string;
  material_fields?: string[];
  sets?: string[];
  guidance?: { when_to_use?: string; when_not_to_use?: string; on_error?: string };
}
export interface ToolListing { catalogue_digest?: string; tools: ToolRow[] }

// AUDIENCE is what makes a person's listing a person's listing. A tool
// declares who it is for; Studio asks for PERSON and gets, per persona,
// the agents and tools that persona may start — which is where a hard-coded
// list of agent names goes away (§2.5).
export const PERSON = "PERSON";

export async function listTools(audience = PERSON): Promise<ToolListing> {
  const { value } = await rpc<ToolListing>(LIST_TOOLS, { audience });
  return { catalogue_digest: value.catalogue_digest, tools: value.tools ?? [] };
}

// The set that groups the agents a person may start. A set says who holds a
// tool, so this is the catalogue's own grouping and not a rule Studio
// invented (§2.5).
export const AGENTS_SET = "agents";

export const isAgent = (t: ToolRow) => (t.sets ?? []).includes(AGENTS_SET);

// Card endpoints are synthesised onto the tool's own service and carry the
// name of the parent tool with a suffix (§2.1: `initiate_payment` gets
// `initiate_payment_input_card`). They are person-facing whatever their
// parent is, so they come back in the same PERSON listing, and Studio
// addresses them by looking the row up rather than by building a path.
export type CardEndpoint = "input_card" | "result_card" | "approval_card";

export function cardMethod(tools: ToolRow[], parentFQN: string, which: CardEndpoint): string | null {
  const fqn = `${parentFQN}_${which}`;
  return tools.find((t) => t.fqn === fqn)?.method ?? null;
}

// A tool's own method path, for starting it.
export function methodOf(tools: ToolRow[], fqn: string): string | null {
  return tools.find((t) => t.fqn === fqn)?.method ?? null;
}

export const getCard = (method: string, body: unknown = {}) => rpc<Card>(method, body).then((a) => a.value);

// ---- The tasks tool (spec §4) -------------------------------------------
//
// `garm.tasks.v1.TasksService` is a tool like any other: every method below
// is a governed call with a ledger row, and the queue IS `list_tasks`.
const TASKS = "/garm.tasks.v1.TasksService";
export const TASKS_METHODS = {
  list: `${TASKS}/ListTasks`,
  get: `${TASKS}/GetTask`,
  approvalCard: `${TASKS}/ApprovalCard`,
  claim: `${TASKS}/ClaimTask`,
  release: `${TASKS}/ReleaseTask`,
  decide: `${TASKS}/DecideTask`,
  triage: `${TASKS}/TriageTask`,
} as const;

export type View = "QUEUE" | "MINE" | "DONE";
export type TaskState = "OPEN" | "CLAIMED" | "APPROVED" | "DECLINED" | "ANSWERED" | "EXPIRED";
export type TaskKind = "APPROVAL" | "ASK";
export type Decision = "APPROVE" | "DECLINE" | "ANSWER";

export interface Predicate { minClearance?: string; compartments?: string[] }
export interface TaskEvent { seq?: number; at?: string; actor?: string; kind?: string; detail?: string }
export interface Triage { actor?: string; action?: string; recommendation?: Decision; reason?: string; at?: string }

export interface Task {
  taskId?: string; kind?: TaskKind; state?: TaskState;
  tool?: string; subject?: string; requester?: string; runId?: string;
  predicate?: Predicate;
  claimant?: string; decidedBy?: string; decision?: Decision; reason?: string; grantJti?: string;
  createdAt?: string; expiresAt?: string; decidedAt?: string;
  events?: TaskEvent[]; triage?: Triage[];
  card?: Card;
  answer?: Record<string, unknown>;
}

// The queue: a page of summary cards, each already projected to this
// viewer. A card the viewer does not reach is not in the list — the tasks
// tool labelled it at the task's predicate and garmd dropped it (§3.2).
export interface TaskPage { cards: Card[]; cursor: string }

export async function listTasks(view: View, cursor = ""): Promise<TaskPage> {
  const { value } = await rpc<{ cards?: Card[]; cursor?: string }>(TASKS_METHODS.list, { view, cursor });
  return { cards: value.cards ?? [], cursor: value.cursor ?? "" };
}

export const getTask = (taskId: string) =>
  rpc<Task>(TASKS_METHODS.get, { taskId }).then((a) => a.value);

export const taskCard = (taskId: string) =>
  rpc<Card>(TASKS_METHODS.approvalCard, { taskId }).then((a) => a.value);

export const claimTask = (taskId: string) =>
  rpc<Task>(TASKS_METHODS.claim, { taskId }).then((a) => a.value);

export const releaseTask = (taskId: string) =>
  rpc<Task>(TASKS_METHODS.release, { taskId }).then((a) => a.value);

export interface DecideArgs {
  taskId: string;
  decision: Decision;
  reason: string;
  grant?: string;
  answer?: Record<string, unknown>;
}
export const decideTask = (args: DecideArgs) =>
  rpc<Task>(TASKS_METHODS.decide, args).then((a) => a.value);

export type TriageAction = "RECOMMEND" | "COMMENT" | "REASSIGN" | "DECLINE";
export const triageTask = (taskId: string, action: TriageAction, reason: string, recommendation?: Decision) =>
  rpc<Task>(TASKS_METHODS.triage, { taskId, action, reason, recommendation }).then((a) => a.value);

// ---- Agents (spec §6) ---------------------------------------------------

// RunStatus is garm.agent.v1.RunStatus in protojson: lowerCamel names, the
// state as its enum name, and the result an Any around the agent's declared
// output message.
export interface RunStatus {
  runId?: string; state?: string; startedAt?: string; finishedAt?: string;
  error?: string;
  result?: { "@type"?: string; value?: string };
  steps?: Step[];
}
// The transcript INDEX: digests and the ledger event id, never a body.
export interface Step {
  seq?: number; kind?: string; toolFqn?: string;
  requestDigest?: string; responseDigest?: string; ledgerEventId?: string;
  startedAt?: string; finishedAt?: string;
}

// Starting a run is calling the agent's own tool. The form values ARE the
// agent's input message; the answer is a RunRef, and the call id garmd put
// on the response is the CallRef its result card is fetched by (§1.3).
export interface Started { runId: string; callId: string | null }

export async function invoke(method: string, input: CardInputs): Promise<Started> {
  const { value, callId } = await rpc<{ runId?: string }>(method, input);
  return { runId: value.runId ?? "", callId };
}

export const getRun = (method: string, runId: string) =>
  rpc<RunStatus>(method, { runId }).then((a) => a.value);

// ---- The grant (spec §7) ------------------------------------------------

// approve asks studiod to sign this person's decision.
//
// The authority exchanged is the person's: their own bearer goes on this
// request and studiod passes it to the token service as the subject token.
// What the page cannot supply is the other half — the proof of which
// application is asking, which is a signature over a registered key — so
// studiod adds it. That is the whole reason studiod is a server.
//
// The four fields are read off the card the tasks tool served. Studio does
// not know what any of them mean, and neither does studiod. The grant comes
// back for one use: it is handed to `decide_task` in the request that
// carries the decision, and nothing keeps it.
export interface Grant { grant: string; expires_in?: number }

export async function approve(tool: string, subject: string, taskId: string, material: Record<string, string>): Promise<string> {
  const { value } = await post<Grant>(APPROVE, { task_id: taskId, tool, subject, material });
  if (!value.grant) {
    throw new ApiError(502, "no_grant", "the approval was signed without a grant");
  }
  return value.grant;
}

// ---- The material map (spec §2.3) ---------------------------------------

// material reads the map a TaskRef and /approve both take out of the card
// the tasks tool served: every fact that carries a source path, at any
// depth. A fact the viewer did not reach is absent, and the tool's card is
// then built from less — which is the point.
export function material(card: Card | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  walk(card?.body ?? [], (f) => {
    if (f.field) out[f.field] = f.value ?? "";
  });
  return out;
}

function walk(body: Element[], visit: (f: Fact) => void) {
  for (const el of body) {
    for (const f of el.facts?.facts ?? []) visit(f);
    if (el.section) walk(el.section.elements ?? [], visit);
  }
}

// merge is the task page's "one page, two cards" (§6): the frame the tasks
// tool served, with the target tool's card standing in for the frame's
// Material section, and the two Disclosures joined into one footer. A page
// is never failed because the tool's card was missing — that is what the
// footer is for.
export const MATERIAL_SECTION = "Material";

export function merge(frame: Card, tool: Card | null, missing?: string): Card {
  if (!tool) {
    if (!missing) return frame;
    return {
      ...frame,
      disclosure: { withheldFields: [...(frame.disclosure?.withheldFields ?? []), missing] },
    };
  }
  const body: Element[] = [];
  for (const el of frame.body ?? []) {
    if (el.section?.title === MATERIAL_SECTION) {
      body.push(...(tool.body ?? []));
      continue;
    }
    body.push(el);
  }
  const withheld = [
    ...(frame.disclosure?.withheldFields ?? []),
    ...(tool.disclosure?.withheldFields ?? []),
  ];
  return {
    ...frame,
    body,
    disclosure: withheld.length > 0 ? { withheldFields: withheld } : frame.disclosure,
  };
}
