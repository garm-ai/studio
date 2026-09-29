import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, SETTLE_MS } from "./App";
import * as api from "./api";
import { saveToken, signOut } from "./auth";
import type { Card, Task, ToolRow } from "./api";
import taskOpen from "./fixtures/task-open.json";
import runRunning from "./fixtures/run-running.json";
import start from "./fixtures/start.json";
import tools from "./fixtures/tools.json";
import queue from "./fixtures/queue.json";

// The wiring: which route calls which garmd method with which arguments,
// and that a decision reloads the card. api is mocked at the module edge;
// ApiError, the tool index helpers and the material reader stay real, so
// the paths Studio addresses are the ones the catalogue named.
vi.mock("./api", async (importOriginal) => {
  const real = await importOriginal<typeof import("./api")>();
  return {
    ...real,
    listTools: vi.fn(), listTasks: vi.fn(), getTask: vi.fn(), getCard: vi.fn(),
    claimTask: vi.fn(), decideTask: vi.fn(), approve: vi.fn(),
    invoke: vi.fn(), getRun: vi.fn(),
  };
});
vi.mock("./auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("./auth")>();
  return { ...real, listPersonas: vi.fn().mockResolvedValue([]) };
});

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const TOOLS = tools.tools as ToolRow[];
const LISTING = { catalogue_digest: tools.catalogue_digest, tools: TOOLS };

// The task the tasks tool answers with: the frame card plus the tool and
// subject an approval's grant is minted against (spec §7).
const TASK: Task = {
  taskId: "tsk d1",
  kind: "APPROVAL",
  state: "CLAIMED",
  tool: "payments.v1.initiate_payment",
  subject: "employee:jdoe",
  requester: "employee:jdoe",
  runId: "01m3nd9gh2v9pahakp5jmjb4p8",
  card: taskOpen as Card,
};

beforeEach(() => {
  saveToken("dev-token");
  window.location.hash = "#/";
  mocked.listTools.mockResolvedValue(LISTING);
  mocked.listTasks.mockResolvedValue({ cards: queue.cards as Card[], cursor: "" });
});
afterEach(() => {
  signOut();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// A token whose payload names a subject: whoAmI reads it without verifying.
function tokenFor(sub: string): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64({ sub })}.sig`;
}

describe("App", () => {
  it("renders #/tasks/{id} from the tasks tool and decides through DecideTask, then reloads", async () => {
    const user = userEvent.setup();
    mocked.getTask.mockResolvedValue(TASK);
    // No approval card for this tool in the fixture listing under that fqn,
    // so the frame stands on its own (spec §2.3).
    mocked.getCard.mockResolvedValue(taskOpen as Card);
    mocked.decideTask.mockResolvedValue(TASK);
    window.location.hash = "#/tasks/tsk%20d1";
    render(<App />);

    expect(await screen.findByRole("heading", { level: 2, name: "Initiate a payment" })).toBeInTheDocument();
    expect(mocked.getTask).toHaveBeenCalledWith("tsk d1");

    await user.type(screen.getByLabelText(/^Reason/), "not today");
    await user.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(mocked.decideTask).toHaveBeenCalledWith({
      taskId: "tsk d1", decision: "DECLINE", reason: "not today",
    }));
    await waitFor(() => expect(mocked.getTask).toHaveBeenCalledTimes(2));
  });

  // Approving is two calls in one click: the person's own client mints the
  // grant at the token exchange, and the grant travels to the tasks tool in
  // the request that carries the decision (spec §7).
  it("mints the grant from the card's material before deciding APPROVE", async () => {
    const user = userEvent.setup();
    mocked.getTask.mockResolvedValue(TASK);
    mocked.getCard.mockResolvedValue(taskOpen as Card);
    mocked.approve.mockResolvedValue("grant.jwt.value");
    mocked.decideTask.mockResolvedValue(TASK);
    window.location.hash = "#/tasks/tsk%20d1";
    render(<App />);

    await user.type(await screen.findByLabelText(/^Reason/), "the customer confirmed by phone");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(mocked.approve).toHaveBeenCalledWith(
      "payments.v1.initiate_payment", "employee:jdoe", "tsk d1", api.material(taskOpen as Card),
    ));
    await waitFor(() => expect(mocked.decideTask).toHaveBeenCalledWith({
      taskId: "tsk d1", decision: "APPROVE", reason: "the customer confirmed by phone",
      grant: "grant.jwt.value", answer: undefined,
    }));
  });

  // The run a decision resumed is still RUNNING in the reload right after
  // the submit, so the answered card is fetched once more SETTLE_MS later
  // and its ref reads the settled state without a Reload click.
  it("re-fetches the card once more after a settle delay following a submit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocked.getTask.mockResolvedValue(TASK);
    mocked.getCard.mockResolvedValue(taskOpen as Card);
    mocked.decideTask.mockResolvedValue(TASK);
    window.location.hash = "#/tasks/tsk_settle";
    render(<App />);
    await user.type(await screen.findByLabelText(/^Reason/), "ok");
    await user.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(mocked.getTask).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 100);
    expect(mocked.getTask).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() => expect(mocked.getTask).toHaveBeenCalledTimes(3));
  });

  it("numbers step rows in order, with the raw seq on the title, inside the card above its footer", async () => {
    mocked.getCard.mockResolvedValue(runRunning as Card);
    mocked.getRun.mockResolvedValue({ steps: [
      { seq: 1, kind: "generate", startedAt: "2026-09-29T06:36:26Z" },
      { seq: 3, kind: "dispatch", toolFqn: "payments.v1.initiate_payment", startedAt: "2026-09-29T06:36:28Z" },
    ] });
    window.location.hash = "#/runs/evt_1/bank.agents.v1.support_assistant";
    const { container } = render(<App />);
    const cells = await screen.findAllByTitle(/^seq \d+$/);
    expect(cells.map((c) => c.textContent)).toEqual(["1", "2"]);
    expect(cells.map((c) => c.getAttribute("title"))).toEqual(["seq 1", "seq 3"]);
    // The card came from the agent's own result card endpoint, addressed by
    // the call id; the steps came from GetRun on the same service, addressed
    // by the run id the card names.
    expect(mocked.getCard).toHaveBeenCalledWith("/bank.agents.v1.SupportAssistant/ResultCard", { callId: "evt_1" });
    expect(mocked.getRun).toHaveBeenCalledWith("/bank.agents.v1.SupportAssistant/GetRun", runRunning.subjectId);
    const article = container.querySelector("article.card")!;
    expect(article.contains(cells[0])).toBe(true);
    const footer = article.querySelector("footer.card-foot")!;
    expect(cells[0].compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("labels the rail with the handle, keeping the full subject on the title", async () => {
    saveToken(tokenFor("employee:jdoe"));
    mocked.listTasks.mockResolvedValue({ cards: [], cursor: "" });
    render(<App />);
    const who = await screen.findByTitle("employee:jdoe");
    expect(who).toHaveTextContent(/^jdoe$/);
  });

  it("starts a run by calling the agent's own tool and lands on its result card", async () => {
    const user = userEvent.setup();
    mocked.getCard.mockImplementation(async (method: string) =>
      (method.endsWith("/InputCard") ? start : runRunning) as Card);
    mocked.invoke.mockResolvedValue({ runId: "01m3run", callId: "evt_01m3call" });
    mocked.getRun.mockResolvedValue({ steps: [] });
    window.location.hash = "#/start";
    render(<App />);

    await user.type(await screen.findByLabelText(/The customer this run is about/), "cust_a1b2c3d4");
    await user.type(screen.getByLabelText(/What the member of staff is asking for/), "hello");
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(mocked.getCard).toHaveBeenCalledWith("/bank.agents.v1.SupportAssistant/InputCard");
    await waitFor(() => expect(mocked.invoke).toHaveBeenCalledWith(
      "/bank.agents.v1.SupportAssistant/Invoke", { customer_id: "cust_a1b2c3d4", request: "hello" },
    ));
    await waitFor(() => expect(window.location.hash)
      .toBe("#/runs/evt_01m3call/bank.agents.v1.support_assistant"));
    expect(await screen.findByRole("heading", { level: 2, name: "support-assistant run" })).toBeInTheDocument();
    expect(await screen.findByText("No steps recorded yet.")).toBeInTheDocument();
  });

  it("returns to the persona picker when a card route answers 401", async () => {
    mocked.getTask.mockImplementation(async () => {
      signOut(); // what transport.read does before throwing
      throw new api.ApiError(401, "unauthenticated", "your session has expired");
    });
    window.location.hash = "#/tasks/tsk_x";
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Studio" })).toBeInTheDocument();
  });
});
