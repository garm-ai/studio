import { useState, type ReactNode } from "react";
import type { Action, Card, CardInput, CardInputs, CardRef, Element } from "../api";
import { RefRow } from "./RefRow";
import { StateBadge } from "./StateBadge";

// CardView renders one garm.card.v1.Card, element by element, as the HTML
// column of spec §6 says: Text is a <p>, a FactSet a <dl>, a Section a
// <section><h4>, an Input the HTML input of its kind with `required`
// honoured, an Action a button whose confirmText is a confirm dialog, a
// CardRef a link to the card it names, and Disclosure a footer.
//
// Two rules hold everywhere in this file. Every string the server sent is
// rendered as text — React escapes it, nothing here sets innerHTML, and no
// value is ever parsed as markup or followed as a URL. And a card whose
// state is not OPEN has no form: its inputs and actions are not rendered
// even if the JSON carried some, because the outcome section the server
// put in the body is the whole story of a decided card.
export function CardView({ card, onAction, onRef, children }: {
  card: Card;
  // Rendered inside the card, after its refs and before its footers: the
  // run page's step table lives here so the card's footer stays the last
  // thing on the card rather than a caption for what follows it.
  children?: ReactNode;
  // The action's id and the inputs the form collected, keyed by Input.id.
  // Rejecting is how the server's refusal reaches the screen, as written.
  onAction?: (actionId: string, inputs: CardInputs) => Promise<void>;
  // Called instead of following the link when a ref is clicked; the link
  // stays a real <a href> either way, so a middle click still works.
  onRef?: (ref: CardRef) => void;
}) {
  const open = card.state === "OPEN";
  const inputs = open ? collectInputs(card.body ?? []) : [];
  const actions = open ? (card.actions ?? []) : [];

  const [values, setValues] = useState<CardInputs>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every required input must hold something before any action is enabled:
  // the server refuses a missing one too, and finding that out after a
  // round trip is the worse way to learn it. Whitespace is not a value.
  const missing = inputs.filter((i) => i.required && !filled(values[i.id ?? ""]));
  const ready = missing.length === 0 && !busy;

  async function act(a: Action) {
    if (!a.id || !onAction) return;
    // confirmText is the one dialog a card may open, and it is the
    // browser's, not ours: the text is shown as text.
    if (a.submit?.confirmText && !window.confirm(a.submit.confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      await onAction(a.id, gather(inputs, values));
    } catch (e) {
      setError(e instanceof Error ? e.message : "the action could not be completed");
    } finally {
      setBusy(false);
    }
  }

  const set = (id: string, v: CardInputs[string]) => setValues((prev) => ({ ...prev, [id]: v }));
  const withheld = card.disclosure?.withheldFields ?? [];

  return (
    <article className="card">
      <div className="topline">
        <div style={{ minWidth: 0 }}>
          <h2>{card.title ?? ""}</h2>
          <div className="sub">
            {kindLabel(card.kind)}{card.subjectId && <> · <span className="mono">{card.subjectId}</span></>}
          </div>
        </div>
        {card.state && <StateBadge state={card.state} />}
      </div>

      {(card.body ?? []).map((el, i) => (
        <ElementView key={i} el={el} open={open} values={values} set={set} depth={0} />
      ))}

      {actions.length > 0 && (
        <div className="panel">
          <div className="actions">
            {actions.map((a) => (
              <button key={a.id} type="button" className={`btn ${styleClass(a.style)}`}
                      disabled={!ready} onClick={() => void act(a)}>
                {a.label ?? a.id}
              </button>
            ))}
          </div>
          {error && <p role="alert" className="alert">{error}</p>}
        </div>
      )}

      {(card.refs ?? []).length > 0 && (
        <div className="card-refs">
          {(card.refs ?? []).map((r, i) => (
            <div key={i} onClick={onRef ? (e) => { e.preventDefault(); onRef(r); } : undefined}>
              <RefRow kind={r.kind} id={r.subjectId} toolFqn={r.toolFqn}
                      title={r.title ?? r.subjectId ?? ""} state={r.state ?? ""} />
            </div>
          ))}
        </div>
      )}

      {children}

      {withheld.length > 0 && (
        <footer className="card-foot">withheld from you: {withheld.join(", ")}</footer>
      )}
      {card.catalogueDigest && (
        <footer className="card-foot mono">catalogue {card.catalogueDigest}</footer>
      )}
    </article>
  );
}

function kindLabel(kind: Card["kind"]): string {
  switch (kind) {
    case "TASK": return "Task";
    case "RUN": return "Run";
    case "START": return "Start a run";
    default: return "Card";
  }
}

function styleClass(style: Action["style"]): string {
  switch (style) {
    case "POSITIVE": return "btn-primary";
    case "DESTRUCTIVE": return "btn-danger";
    default: return "btn-ghost";
  }
}

// collectInputs finds every Input in the body, one Section deep (§1.3: a
// section never nests), in document order.
function collectInputs(body: Element[]): CardInput[] {
  const out: CardInput[] = [];
  for (const el of body) {
    if (el.input) out.push(el.input);
    for (const inner of el.section?.elements ?? []) if (inner.input) out.push(inner.input);
  }
  return out;
}

function filled(v: CardInputs[string] | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return !Number.isNaN(v);
  if (typeof v === "boolean") return v;
  return v.length > 0;
}

// gather is what the action carries: only inputs the card declared (an
// unknown one is a 400), only those that hold a value, strings trimmed.
function gather(inputs: CardInput[], values: CardInputs): CardInputs {
  const out: CardInputs = {};
  for (const i of inputs) {
    if (!i.id) continue;
    const v = values[i.id];
    if (!filled(v) || v === undefined) continue;
    out[i.id] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

function ElementView({ el, open, values, set, depth }: {
  el: Element; open: boolean; values: CardInputs;
  set: (id: string, v: CardInputs[string]) => void; depth: number;
}) {
  if (el.text) {
    const em = el.text.emphasis ?? "DEFAULT";
    // Trimmed: .card-text keeps inner line breaks (pre-wrap), and a model's
    // answer that starts with "\n\n" would otherwise open with two blank
    // lines. The backend trims too; this is the renderer's own guarantee.
    const raw = (el.text.text ?? "").trim();
    const shown = em === "SUBTLE" ? localiseTimestamps(raw) : raw;
    return <p className={`card-text card-text-${em.toLowerCase()}`} title={shown !== raw ? raw : undefined}>{shown}</p>;
  }
  if (el.facts) {
    const dl = (
      <dl className="facts">
        {(el.facts.facts ?? []).map((f, i) => (
          <div className="kv" key={i}>
            <dt className="k">{f.label ?? ""}</dt>
            <FactValue value={f.value ?? ""} />
          </div>
        ))}
      </dl>
    );
    return depth === 0 ? <div className="panel">{dl}</div> : dl;
  }
  if (el.divider) return <hr className="card-divider" />;
  if (el.input) {
    // Not OPEN → no form (§1.2). The input is dropped, not disabled.
    if (!open) return null;
    return <InputView input={el.input} value={values[el.input.id ?? ""]} set={set} />;
  }
  if (el.section) {
    // One level only (§1.3). A section that somehow arrives inside a
    // section is flattened to its elements, heading dropped.
    const elements = (el.section.elements ?? []).map((inner, i) => (
      <ElementView key={i} el={inner} open={open} values={values} set={set} depth={depth + 1} />
    ));
    if (depth > 0) return <>{elements}</>;
    return (
      <section className="panel">
        <h4>{el.section.title ?? ""}</h4>
        {elements}
      </section>
    );
  }
  return null;
}

// A timestamp as protojson writes it: RFC 3339, "T", seconds, an optional
// fraction, Z or an offset. Nothing looser — "2026-09" or "25000" must stay
// as sent, because a fact's value is what the person is agreeing to.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const TIMESTAMP_IN_TEXT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;

// localiseTimestamps rewrites every RFC 3339 instant inside a prose line
// ("approved by employee:sam at 2026-09-29T06:33:43Z") to the viewer's
// local time, so the audit trail reads like the facts above it. Anything
// that is not a parseable instant is left as sent.
export function localiseTimestamps(s: string): string {
  return s.replace(TIMESTAMP_IN_TEXT, (m) => {
    const t = Date.parse(m);
    return Number.isNaN(t) ? m : new Date(t).toLocaleString();
  });
}

// FactValue shows a timestamp value in the viewer's local time, the way
// the step table and the run list already do, and every other value as
// sent. The raw value stays on the element's title, so the UTC instant is
// one hover away and never lost.
function FactValue({ value }: { value: string }) {
  if (TIMESTAMP.test(value)) {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) {
      return <dd className="v" title={value}>{new Date(t).toLocaleString()}</dd>;
    }
  }
  return <dd className="v">{value}</dd>;
}

function InputView({ input, value, set }: {
  input: CardInput; value: CardInputs[string] | undefined; set: (id: string, v: CardInputs[string]) => void;
}) {
  const id = input.id ?? "";
  const dom = `card-input-${id}`;
  const label = <label className="lbl" htmlFor={dom}>{input.label ?? id}{input.required && " (required)"}</label>;

  if (input.number) {
    return (
      <div className="card-field">
        {label}
        <input id={dom} type="number" className="field" required={input.required}
               min={input.number.min} max={input.number.max}
               value={typeof value === "number" ? value : ""}
               onChange={(e) => set(id, e.target.value === "" ? "" : Number(e.target.value))} />
      </div>
    );
  }
  if (input.date) {
    return (
      <div className="card-field">
        {label}
        <input id={dom} type="date" className="field" required={input.required}
               value={typeof value === "string" ? value : ""}
               onChange={(e) => set(id, e.target.value)} />
      </div>
    );
  }
  if (input.toggle) {
    return (
      <div className="card-field card-field-toggle">
        <input id={dom} type="checkbox" required={input.required}
               checked={value === true}
               onChange={(e) => set(id, e.target.checked)} />
        {label}
      </div>
    );
  }
  if (input.choice) {
    // A closed list is a <select>. A query-backed choice (a typeahead
    // against /tasks/{id}/query/{input_id}) is out of this slice; until it
    // lands, such an input takes the value as typed.
    if (input.choice.query && !(input.choice.choices ?? []).length) {
      return (
        <div className="card-field">
          {label}
          <input id={dom} type="text" className="field" required={input.required}
                 value={typeof value === "string" ? value : ""}
                 onChange={(e) => set(id, e.target.value)} />
        </div>
      );
    }
    const multi = input.choice.multi === true;
    const selected = multi
      ? (Array.isArray(value) ? value : [])
      : (typeof value === "string" ? value : "");
    return (
      <div className="card-field">
        {label}
        <select id={dom} className="field" required={input.required} multiple={multi}
                value={selected}
                onChange={(e) => set(id, multi
                  ? Array.from(e.target.selectedOptions, (o) => o.value)
                  : e.target.value)}>
          {!multi && <option value="">—</option>}
          {(input.choice.choices ?? []).map((c, i) => (
            <option key={i} value={c.value ?? ""}>{c.title ?? c.value ?? ""}</option>
          ))}
        </select>
      </div>
    );
  }
  // Text is the default and the fallback: an input whose kind this
  // renderer does not know still takes a value rather than vanishing.
  const t = input.text ?? {};
  const maxLength = t.maxLen && t.maxLen > 0 ? t.maxLen : undefined;
  const str = typeof value === "string" ? value : "";
  return (
    <div className="card-field">
      {label}
      {t.multiline
        ? <textarea id={dom} className="comment" rows={3} required={input.required} maxLength={maxLength}
                    value={str} onChange={(e) => set(id, e.target.value)} />
        : <input id={dom} type="text" className="field" required={input.required} maxLength={maxLength}
                 value={str} onChange={(e) => set(id, e.target.value)} />}
    </div>
  );
}
