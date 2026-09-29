import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, SETTLE_MS } from "./App";
import * as api from "./api";
import { saveToken, signOut } from "./auth";
import type { Card } from "./api";
import taskOpen from "./fixtures/task-open.json";
import runRunning from "./fixtures/run-running.json";
import start from "./fixtures/start.json";

// The wiring: which route calls which api function with which arguments,
// and that a decision reloads the card. api is mocked at the module edge;
// ApiError stays real so the 401 path is the real one.
vi.mock("./api", async (importOriginal) => {
  const real = await importOriginal<typeof import("./api")>();
  return {
    ...real,
    listTasks: vi.fn(), getTaskCard: vi.fn(), submitTaskCard: vi.fn(),
    getRunCard: vi.fn(), getRun: vi.fn(), getStartCard: vi.fn(), startRun: vi.fn(), listRuns: vi.fn(),
  };
});
vi.mock("./auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("./auth")>();
  return { ...real, listPersonas: vi.fn().mockResolvedValue([]) };
});

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  saveToken("dev-token");
  window.location.hash = "#/";
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
  it("renders #/tasks/{id} from GET /tasks/{id}/card and decides through POST /tasks/{id}/card, then reloads", async () => {
    const user = userEvent.setup();
    mocked.getTaskCard.mockResolvedValue(taskOpen as Card);
    mocked.submitTaskCard.mockResolvedValue(undefined);
    window.location.hash = "#/tasks/tsk%20d1";
    render(<App />);

    expect(await screen.findByRole("heading", { level: 2, name: "Initiate a payment" })).toBeInTheDocument();
    expect(mocked.getTaskCard).toHaveBeenCalledWith("tsk d1");

    await user.type(screen.getByLabelText(/^Reason/), "not today");
    await user.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(mocked.submitTaskCard).toHaveBeenCalledWith("tsk d1", "decline", { reason: "not today" }));
    await waitFor(() => expect(mocked.getTaskCard).toHaveBeenCalledTimes(2));
  });

  // The run a decision resumed is still RUNNING in the reload right after
  // the submit, so the answered card is fetched once more SETTLE_MS later
  // and its ref reads the settled state without a Reload click.
  it("re-fetches the card once more after a settle delay following a submit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocked.getTaskCard.mockResolvedValue(taskOpen as Card);
    mocked.submitTaskCard.mockResolvedValue(undefined);
    window.location.hash = "#/tasks/tsk_settle";
    render(<App />);
    await user.type(await screen.findByLabelText(/^Reason/), "ok");
    await user.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(mocked.getTaskCard).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 100);
    expect(mocked.getTaskCard).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() => expect(mocked.getTaskCard).toHaveBeenCalledTimes(3));
  });

  it("numbers step rows in order, with the raw seq on the title, inside the card above its footer", async () => {
    mocked.getRunCard.mockResolvedValue(runRunning as Card);
    mocked.getRun.mockResolvedValue({ status: {}, tasks: [], steps: [
      { run_id: "r", seq: 1, kind: "generate", started_at: "2026-09-29T06:36:26Z" },
      { run_id: "r", seq: 3, kind: "dispatch", tool_fqn: "payments.v1.initiate_payment", started_at: "2026-09-29T06:36:28Z" },
    ] });
    window.location.hash = "#/runs/r";
    const { container } = render(<App />);
    const cells = await screen.findAllByTitle(/^seq \d+$/);
    expect(cells.map((c) => c.textContent)).toEqual(["1", "2"]);
    expect(cells.map((c) => c.getAttribute("title"))).toEqual(["seq 1", "seq 3"]);
    const article = container.querySelector("article.card")!;
    expect(article.contains(cells[0])).toBe(true);
    const footer = article.querySelector("footer.card-foot")!;
    expect(cells[0].compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("labels the rail with the handle, keeping the full subject on the title", async () => {
    saveToken(tokenFor("employee:jdoe"));
    mocked.listTasks.mockResolvedValue({ tasks: [], truncated: false });
    render(<App />);
    const who = await screen.findByTitle("employee:jdoe");
    expect(who).toHaveTextContent(/^jdoe$/);
  });

  it("starts a run from #/start and lands on the run's card", async () => {
    const user = userEvent.setup();
    mocked.getStartCard.mockResolvedValue(start as Card);
    mocked.startRun.mockResolvedValue({ run_id: "01m3run/x" });
    mocked.getRunCard.mockResolvedValue(runRunning as Card);
    mocked.getRun.mockResolvedValue({ status: {}, steps: [], tasks: [] });
    window.location.hash = "#/start";
    render(<App />);

    await user.type(await screen.findByLabelText(/The customer this run is about/), "cust_a1b2c3d4");
    await user.type(screen.getByLabelText(/What the member of staff is asking for/), "hello");
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(mocked.getStartCard).toHaveBeenCalledWith("support-assistant");
    await waitFor(() => expect(mocked.startRun).toHaveBeenCalledWith("support-assistant", { customer_id: "cust_a1b2c3d4", request: "hello" }));
    await waitFor(() => expect(window.location.hash).toBe("#/runs/01m3run%2Fx"));
    expect(await screen.findByRole("heading", { level: 2, name: "support-assistant run" })).toBeInTheDocument();
    expect(mocked.getRunCard).toHaveBeenCalledWith("01m3run/x");
    expect(mocked.getRun).toHaveBeenCalledWith("01m3run/x");
    expect(await screen.findByText("No steps recorded yet.")).toBeInTheDocument();
  });

  it("returns to the persona picker when a card route answers 401", async () => {
    mocked.getTaskCard.mockImplementation(async () => {
      signOut(); // what api.call does before throwing
      throw new api.ApiError(401, "unauthenticated", "your session has expired");
    });
    window.location.hash = "#/tasks/tsk_x";
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Agent inbox" })).toBeInTheDocument();
  });
});
