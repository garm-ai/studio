import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Start } from "./Start";
import { ApiError, isAgent } from "../api";
import type { Card, ToolRow } from "../api";
import start from "../fixtures/start.json";
import tools from "../fixtures/tools.json";

const START = start as Card;
const AGENTS = (tools.tools as ToolRow[]).filter(isAgent).filter((t) => t.method.endsWith("/Invoke"));
const [ASSISTANT, GUARDIAN] = AGENTS;

const notOffered = () => Promise.reject(new ApiError(404, "not_found", "no such tool"));
const started = { runId: "01m3run", callId: "evt_01m3call" };

describe("Start", () => {
  it("asks the catalogue what this persona may start, fetches each form, and turns the first one's action into a run", async () => {
    const user = userEvent.setup();
    const listAgents = vi.fn().mockResolvedValue(AGENTS);
    const loadCard = vi.fn().mockResolvedValue(START);
    const startRun = vi.fn().mockResolvedValue(started);
    const onStarted = vi.fn();
    render(<Start listAgents={listAgents} loadCard={loadCard} start={startRun} onStarted={onStarted} />);

    await waitFor(() => { for (const a of AGENTS) expect(loadCard).toHaveBeenCalledWith(a); });
    const button = await screen.findByRole("button", { name: "Start" });
    expect(button).toBeDisabled();
    // Two agents came back, so both are offered.
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "card-guardian" })).toHaveAttribute("aria-pressed", "false");

    await user.type(screen.getByLabelText(/The customer this run is about/), "cust_a1b2c3d4");
    await user.type(screen.getByLabelText(/What the member of staff is asking for/), "Pay the plumber 250 GBP");
    await user.click(button);

    // The form values ARE the agent's input message: `Invoke` takes them as
    // sent, and the tool validates them against its own contract.
    expect(startRun).toHaveBeenCalledWith(ASSISTANT, {
      customer_id: "cust_a1b2c3d4", request: "Pay the plumber 250 GBP",
    });
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(started));
  });

  it("offers only what answers with a form: a 404 is by design, not an error", async () => {
    const user = userEvent.setup();
    // The persona reaches card-guardian's form and nothing else.
    const loadCard = vi.fn((t: ToolRow) => t.fqn === GUARDIAN.fqn ? Promise.resolve(START) : notOffered());
    const startRun = vi.fn().mockResolvedValue(started);
    render(<Start listAgents={vi.fn().mockResolvedValue(AGENTS)} loadCard={loadCard} start={startRun} onStarted={vi.fn()} />);

    const button = await screen.findByRole("button", { name: "Start" });
    // One agent is no choice, so no picker; and no alert, because nothing
    // went wrong.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/The customer this run is about/), "cust_a1b2c3d4");
    await user.type(screen.getByLabelText(/What the member of staff is asking for/), "card ending 1111 stolen");
    await user.click(button);
    expect(startRun).toHaveBeenCalledWith(GUARDIAN, {
      customer_id: "cust_a1b2c3d4", request: "card ending 1111 stolen",
    });
  });

  it("says so when the catalogue offers this persona no agent at all, instead of an error", async () => {
    render(<Start listAgents={vi.fn().mockResolvedValue([])} loadCard={vi.fn(notOffered)} start={vi.fn()} onStarted={vi.fn()} />);
    await screen.findByText("This persona may not start any agent");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
  });

  it("selecting an agent renders its start card", async () => {
    const user = userEvent.setup();
    const guardian: Card = { ...START, subjectId: "card-guardian", title: "Start card-guardian" };
    const loadCard = vi.fn((t: ToolRow) => Promise.resolve(t.fqn === GUARDIAN.fqn ? guardian : START));
    render(<Start listAgents={vi.fn().mockResolvedValue(AGENTS)} loadCard={loadCard} start={vi.fn()} onStarted={vi.fn()} />);

    await screen.findByRole("button", { name: "Start" });
    await user.click(screen.getByRole("button", { name: "card-guardian" }));
    expect(screen.getByRole("button", { name: "card-guardian" })).toHaveAttribute("aria-pressed", "true");
    await screen.findByText("Start card-guardian");
  });

  it("shows the server's refusal when the run cannot be started", async () => {
    const user = userEvent.setup();
    const startRun = vi.fn().mockRejectedValue(new Error("the agent cannot be invoked by this caller"));
    render(<Start listAgents={vi.fn().mockResolvedValue([ASSISTANT])} loadCard={vi.fn().mockResolvedValue(START)}
                  start={startRun} onStarted={vi.fn()} />);
    await user.type(await screen.findByLabelText(/The customer this run is about/), "cust_a1b2c3d4");
    await user.type(screen.getByLabelText(/What the member of staff is asking for/), "hello");
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("the agent cannot be invoked by this caller"));
  });

  it("surfaces a listing or a card that could not be loaded for any reason other than 404", async () => {
    render(<Start listAgents={vi.fn().mockResolvedValue([ASSISTANT])}
                  loadCard={vi.fn().mockRejectedValue(new Error("the tool plane is unavailable; try again"))}
                  start={vi.fn()} onStarted={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("the tool plane is unavailable; try again"));
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
  });
});
