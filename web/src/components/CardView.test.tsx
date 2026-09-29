import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardView, localiseTimestamps } from "./CardView";
import type { Card } from "../api";
import taskOpen from "../fixtures/task-open.json";
import taskAnswered from "../fixtures/task-answered.json";
import runRunning from "../fixtures/run-running.json";
import runCompleted from "../fixtures/run-completed.json";
import start from "../fixtures/start.json";

// The fixtures are the contract with the backend (plan: "The Card JSON
// fixture"); typing them as Card here is the check that they fit the shape
// api.ts declares.
const TASK_OPEN = taskOpen as Card;
const TASK_ANSWERED = taskAnswered as Card;
const RUN_RUNNING = runRunning as Card;
const RUN_COMPLETED = runCompleted as Card;
const START = start as Card;

afterEach(() => vi.restoreAllMocks());

describe("CardView: the open task card", () => {
  it("renders the title, the state, and every fact label and value verbatim in a <dl>", () => {
    const { container } = render(<CardView card={TASK_OPEN} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Initiate a payment");
    expect(screen.getByText("open")).toHaveClass("badge");
    const dls = container.querySelectorAll("dl");
    expect(dls.length).toBe(3);
    for (const [label, value] of [
      ["Owned by", "payments-platform"], ["Contact", "#payments-oncall"],
      ["amount_minor_units", "25000"], ["beneficiary_iban", "GB29NWBK60161331926819"], ["currency_code", "GBP"],
      ["Requested for", "employee:jdoe"], ["Run", "01m3nd9gh2v9pahakp5jmjb4p8"],
    ]) {
      expect(screen.getByText(label).tagName).toBe("DT");
      expect(screen.getByText(value).tagName).toBe("DD");
    }
    // The one timestamp reads in local time, with the sent value on the title.
    expect(screen.getByText("Expires").tagName).toBe("DT");
    expect(screen.getByTitle("2026-09-29T01:58:35Z")).toHaveTextContent(new Date("2026-09-29T01:58:35Z").toLocaleString());
  });

  it("renders a Section as <section><h4> and its subtle Text as a <p>", () => {
    const { container } = render(<CardView card={TASK_OPEN} />);
    const section = container.querySelector("section")!;
    expect(within(section).getByRole("heading", { level: 4 })).toHaveTextContent("Audit trail");
    const p = within(section).getByText(/created by agent:bank.agents.v1.SupportAssistant/);
    expect(p.tagName).toBe("P");
    expect(p).toHaveClass("card-text-subtle");
  });

  it("renders the reason input as a required multiline textarea capped at maxLen", () => {
    render(<CardView card={TASK_OPEN} />);
    const reason = screen.getByLabelText(/^Reason/);
    expect(reason.tagName).toBe("TEXTAREA");
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute("maxlength", "500");
  });

  // A run's card is served by the agent that ran, so the ref names it and
  // the link carries it: the ref alone is enough to fetch the card.
  it("renders the run ref as a link carrying the call and the tool that serves its card", () => {
    render(<CardView card={TASK_OPEN} />);
    const link = screen.getByRole("link", { name: /support-assistant run/ });
    expect(link).toHaveAttribute("href", "#/runs/evt_01m3nd9ca11/bank.agents.v1.support_assistant");
    expect(within(link).getByText("running")).toHaveClass("badge");
  });

  it("keeps both actions disabled until the required input holds more than whitespace", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<CardView card={TASK_OPEN} onAction={onAction} />);
    const approve = screen.getByRole("button", { name: "Approve" });
    const decline = screen.getByRole("button", { name: "Decline" });
    expect(approve).toBeDisabled();
    expect(decline).toBeDisabled();

    await user.type(screen.getByLabelText(/^Reason/), "   ");
    expect(approve).toBeDisabled();

    await user.clear(screen.getByLabelText(/^Reason/));
    await user.type(screen.getByLabelText(/^Reason/), "the customer confirmed by phone");
    expect(approve).toBeEnabled();
    expect(decline).toBeEnabled();
  });

  it("shows confirmText as a confirm dialog and only submits when it is accepted", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<CardView card={TASK_OPEN} onAction={onAction} />);
    await user.type(screen.getByLabelText(/^Reason/), "confirmed");

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(confirm).toHaveBeenCalledWith("Approve the payment of 25000 GBP?");
    expect(onAction).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onAction).toHaveBeenCalledWith("approve", { reason: "confirmed" });
  });

  it("submits an action without confirmText straight away, with the inputs trimmed", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm");
    render(<CardView card={TASK_OPEN} onAction={onAction} />);
    await user.type(screen.getByLabelText(/^Reason/), "  not today  ");
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledWith("decline", { reason: "not today" });
  });

  it("disables every action while one is in flight, so a double click cannot send two", async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const onAction = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<CardView card={TASK_OPEN} onAction={onAction} />);
    await user.type(screen.getByLabelText(/^Reason/), "confirmed");
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decline" })).toBeDisabled();
    resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled());
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("shows the server's refusal as written", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn().mockRejectedValue(new Error("cannot approve as a delegated identity"));
    render(<CardView card={TASK_OPEN} onAction={onAction} />);
    await user.type(screen.getByLabelText(/^Reason/), "confirmed");
    await user.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("cannot approve as a delegated identity"));
  });
});

describe("CardView: cards that are not OPEN", () => {
  it("renders the answered task's outcome section with no input and no action", () => {
    const { container } = render(<CardView card={TASK_ANSWERED} />);
    expect(screen.getByText("answered")).toHaveClass("badge");
    expect(screen.getByRole("heading", { level: 4, name: "Outcome" })).toBeInTheDocument();
    expect(screen.getByText("the customer confirmed by phone").tagName).toBe("DD");
    expect(screen.getByText("grn_01m3ndb2q4x8k7v9p2wz5r3h6c")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelectorAll("input, textarea, select").length).toBe(0);
  });

  // Review Focus / §1.2: the renderer, not only the server, guarantees
  // that a decided card has no form. A card that arrives with inputs and
  // actions but a non-OPEN state renders neither.
  it("drops inputs and actions a non-OPEN card wrongly carries", () => {
    const rogue: Card = { ...TASK_OPEN, state: "EXPIRED" };
    const { container } = render(<CardView card={rogue} onAction={vi.fn()} />);
    expect(screen.getByText("expired")).toHaveClass("badge");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelectorAll("input, textarea, select").length).toBe(0);
    // The facts are still there: the outcome is shown, the form is not.
    expect(screen.getByText("GB29NWBK60161331926819")).toBeInTheDocument();
  });

  it("renders the running run card with its owner and a link to the open task", () => {
    render(<CardView card={RUN_RUNNING} />);
    expect(screen.getByText("running")).toHaveClass("badge");
    expect(screen.getByText("agent-platform").tagName).toBe("DD");
    expect(screen.getByText("Waiting on a decision.")).toHaveClass("card-text-subtle");
    const link = screen.getByRole("link", { name: /Initiate a payment/ });
    expect(link).toHaveAttribute("href", "#/tasks/tsk_d1960dcd5d421088d02f66cf");
    expect(within(link).getByText("open")).toHaveClass("badge");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders the completed run card's result text and the answered task ref", () => {
    render(<CardView card={RUN_COMPLETED} />);
    expect(screen.getByText("completed")).toHaveClass("badge");
    expect(screen.getByRole("heading", { level: 4, name: "Result" })).toBeInTheDocument();
    expect(screen.getByText(/PAY-2026-0929-0001/).tagName).toBe("P");
    const link = screen.getByRole("link", { name: /Initiate a payment/ });
    expect(within(link).getByText("answered")).toHaveClass("badge");
  });
});

describe("CardView: the start card", () => {
  it("renders one input per field and submits the form values under their ids", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<CardView card={START} onAction={onAction} />);
    const customer = screen.getByLabelText(/The customer this run is about/);
    const request = screen.getByLabelText(/What the member of staff is asking for/);
    expect(customer.tagName).toBe("INPUT");
    expect(customer).toHaveAttribute("type", "text");
    expect(customer).not.toHaveAttribute("maxlength");
    expect(request.tagName).toBe("TEXTAREA");
    expect(request).toHaveAttribute("maxlength", "2000");

    const startBtn = screen.getByRole("button", { name: "Start" });
    expect(startBtn).toBeDisabled();
    await user.type(customer, "cust_a1b2c3d4");
    expect(startBtn).toBeDisabled();
    await user.type(request, "Please pay the plumber");
    expect(startBtn).toBeEnabled();
    await user.click(startBtn);
    expect(onAction).toHaveBeenCalledWith("start", { customer_id: "cust_a1b2c3d4", request: "Please pay the plumber" });
  });
});

describe("CardView: every element kind", () => {
  const kinds: Card = {
    kind: "TASK", subjectId: "tsk_k", title: "Kinds", state: "OPEN",
    body: [
      { text: { text: "A heading", emphasis: "HEADING" } },
      { text: { text: "Plain" } },
      { divider: {} },
      { input: { id: "limit", label: "Limit", number: { min: 1, max: 10 } } },
      { input: { id: "when", label: "When", date: {} } },
      { input: { id: "agree", label: "Agree", toggle: {} } },
      { input: { id: "tier", label: "Tier", choice: { choices: [
        { title: "Gold", value: "gold" }, { title: "Silver", value: "silver" } ] } } },
      { input: { id: "tags", label: "Tags", choice: { multi: true, choices: [
        { title: "A", value: "a" }, { title: "B", value: "b" } ] } } },
      { section: { title: "Inner", elements: [
        { input: { id: "note", label: "Note", text: {} } },
        { facts: { facts: [ { label: "k", value: "v" } ] } } ] } },
    ],
    actions: [ { id: "go", label: "Go", submit: {} } ],
  };

  it("maps each kind to its HTML element", () => {
    const { container } = render(<CardView card={kinds} />);
    expect(screen.getByText("A heading")).toHaveClass("card-text-heading");
    expect(screen.getByText("Plain")).toHaveClass("card-text-default");
    expect(container.querySelector("hr")).not.toBeNull();
    const limit = screen.getByLabelText("Limit");
    expect(limit).toHaveAttribute("type", "number");
    expect(limit).toHaveAttribute("min", "1");
    expect(limit).toHaveAttribute("max", "10");
    expect(screen.getByLabelText("When")).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("Agree")).toHaveAttribute("type", "checkbox");
    const tier = screen.getByLabelText("Tier");
    expect(tier.tagName).toBe("SELECT");
    expect(within(tier).getByRole("option", { name: "Gold" })).toHaveValue("gold");
    expect(screen.getByLabelText("Tags")).toHaveAttribute("multiple");
    // An input inside a Section is part of the same form, and the
    // section's facts are still a <dl>.
    expect(screen.getByLabelText("Note")).toHaveAttribute("type", "text");
    expect(screen.getByText("v").tagName).toBe("DD");
    // Nothing is required here, so the action is live at once.
    expect(screen.getByRole("button", { name: "Go" })).toBeEnabled();
  });

  it("submits each value in its own type, and leaves untouched inputs out", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<CardView card={kinds} onAction={onAction} />);
    await user.type(screen.getByLabelText("Limit"), "7");
    await user.type(screen.getByLabelText("When"), "2026-10-01");
    await user.click(screen.getByLabelText("Agree"));
    await user.selectOptions(screen.getByLabelText("Tier"), "silver");
    await user.selectOptions(screen.getByLabelText("Tags"), ["a", "b"]);
    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(onAction).toHaveBeenCalledWith("go", {
      limit: 7, when: "2026-10-01", agree: true, tier: "silver", tags: ["a", "b"],
    });
  });
});

describe("CardView: what the server sent is text, never markup", () => {
  // Review Focus 3. A value that looks like HTML is shown character for
  // character; nothing in the page is created from it.
  it("renders a Fact value and a Text containing markup as literal text", () => {
    const hostile: Card = {
      kind: "TASK", subjectId: "tsk_h", title: "<img src=x onerror=alert(1)>", state: "ANSWERED",
      body: [
        { facts: { facts: [ { label: "<i>label</i>", value: "<b>bold</b> & <script>alert(1)</script>" } ] } },
        { text: { text: "<a href=\"https://evil.example\">click</a>" } },
      ],
      refs: [ { kind: "TASK", subjectId: "<x>", title: "<u>ref</u>", state: "OPEN" } ],
    };
    const { container } = render(<CardView card={hostile} />);
    expect(screen.getByText("<b>bold</b> & <script>alert(1)</script>")).toBeInTheDocument();
    expect(screen.getByText("<i>label</i>")).toBeInTheDocument();
    expect(screen.getByText('<a href="https://evil.example">click</a>')).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(container.querySelector("b, i, u, img, script")).toBeNull();
    // The only <a> is the ref, and its href is ours, built from the id.
    const links = container.querySelectorAll("a");
    expect(links.length).toBe(1);
    expect(links[0]).toHaveAttribute("href", "#/tasks/%3Cx%3E");
  });

  it("URL-encodes a ref's id and links nothing it cannot address", () => {
    const card: Card = {
      kind: "RUN", subjectId: "r", title: "Refs", state: "COMPLETED",
      refs: [
        { kind: "TASK", subjectId: "a/b c", title: "slashed", state: "OPEN" },
        { kind: "START", subjectId: "support-assistant", title: "not a link", state: "OPEN" },
        // A run ref that names no tool: its card cannot be fetched, so the
        // row is a row and not a link to a page that would fail.
        { kind: "RUN", subjectId: "evt_x", title: "toolless run", state: "RUNNING" },
      ],
    };
    render(<CardView card={card} />);
    expect(screen.getByRole("link", { name: /slashed/ })).toHaveAttribute("href", "#/tasks/a%2Fb%20c");
    expect(screen.queryByRole("link", { name: /not a link/ })).not.toBeInTheDocument();
    expect(screen.getByText("not a link")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /toolless run/ })).not.toBeInTheDocument();
    expect(screen.getByText("toolless run")).toBeInTheDocument();
  });

  it("lists withheld fields in a footer, and no footer when nothing was withheld", () => {
    const { rerender } = render(<CardView card={{ ...TASK_OPEN, disclosure: { withheldFields: ["beneficiary_name", "memo"] } }} />);
    expect(screen.getByText("withheld from you: beneficiary_name, memo")).toBeInTheDocument();
    rerender(<CardView card={TASK_OPEN} />);
    expect(screen.queryByText(/withheld from you/)).not.toBeInTheDocument();
  });
});

describe("CardView: polish from the rehearsal", () => {
  // A protojson timestamp reads in the viewer's local time, as the step
  // table and the run list already do; the UTC value stays on the title.
  it("shows a timestamp fact value in local time with the raw value on the title, and leaves other values as sent", () => {
    const card: Card = {
      kind: "RUN", subjectId: "r", title: "Times", state: "RUNNING",
      body: [ { facts: { facts: [
        { label: "Started", value: "2026-09-29T06:36:26Z" },
        { label: "Fraction", value: "2026-09-29T06:36:26.123456+02:00" },
        { label: "Amount", value: "25000" },
        { label: "Month", value: "2026-09" },
        { label: "Date only", value: "2026-09-29" },
        { label: "Loose", value: "2026-09-29T06:36:26Z trailing" },
      ] } } ],
    };
    render(<CardView card={card} />);
    const started = screen.getByTitle("2026-09-29T06:36:26Z");
    expect(started.tagName).toBe("DD");
    expect(started).toHaveTextContent(new Date("2026-09-29T06:36:26Z").toLocaleString());
    expect(screen.getByTitle("2026-09-29T06:36:26.123456+02:00"))
      .toHaveTextContent(new Date("2026-09-29T06:36:26.123456+02:00").toLocaleString());
    for (const raw of ["25000", "2026-09", "2026-09-29", "2026-09-29T06:36:26Z trailing"]) {
      const dd = screen.getByText(raw);
      expect(dd.tagName).toBe("DD");
      expect(dd).not.toHaveAttribute("title");
    }
  });

  it("trims a Text so a result that starts with blank lines does not open with them", () => {
    const card: Card = {
      kind: "RUN", subjectId: "r", title: "T", state: "COMPLETED",
      body: [ { text: { text: "\n\nI have looked up the customer.\nDone.\n" } } ],
    };
    const { container } = render(<CardView card={card} />);
    expect(container.querySelector("p.card-text")!.textContent).toBe("I have looked up the customer.\nDone.");
  });

  it("renders children inside the card, after the refs and before the footers", () => {
    const { container } = render(
      <CardView card={RUN_COMPLETED}><div data-testid="steps">steps</div></CardView>,
    );
    const article = container.querySelector("article.card")!;
    const order = Array.from(article.querySelectorAll(".card-refs, [data-testid=steps], footer")).map((e) =>
      e.tagName === "FOOTER" ? "footer" : e.className || e.getAttribute("data-testid"));
    expect(order).toEqual(["card-refs", "steps", "footer"]);
  });
});

describe("localiseTimestamps", () => {
  it("rewrites every RFC 3339 instant in a prose line to local time and leaves the rest", () => {
    const line = "approved by employee:sam at 2026-09-29T06:33:43Z after 2026-09-29T06:33:16.5Z";
    const out = localiseTimestamps(line);
    expect(out).not.toContain("2026-09-29T06:33:43Z");
    expect(out).not.toContain("2026-09-29T06:33:16.5Z");
    expect(out.startsWith("approved by employee:sam at ")).toBe(true);
    expect(out).toContain(new Date(Date.parse("2026-09-29T06:33:43Z")).toLocaleString());
    expect(localiseTimestamps("no instant here 2026-09-29")).toBe("no instant here 2026-09-29");
  });

  it("renders a subtle audit-trail line localised, with the raw line on the title", () => {
    const card = {
      ...(taskOpen as Card),
      body: [{ section: { title: "Audit trail", elements: [
        { text: { text: "created by agent:x at 2026-09-29T06:33:16Z", emphasis: "SUBTLE" } } ] } }],
    } as Card;
    render(<CardView card={card} onAction={vi.fn()} />);
    const p = screen.getByText(/created by agent:x at /);
    expect(p.textContent).not.toContain("2026-09-29T06:33:16Z");
    expect(p.getAttribute("title")).toContain("2026-09-29T06:33:16Z");
  });
});
