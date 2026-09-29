import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AGENTS, Start } from "./Start";
import { ApiError } from "../api";
import type { Card } from "../api";
import start from "../fixtures/start.json";

const START = start as Card;
const notOffered = () => Promise.reject(new ApiError(404, "not_found", "no such agent"));

describe("Start", () => {
  it("asks for every agent's start card and turns the first one's action into a run", async () => {
    const user = userEvent.setup();
    const loadCard = vi.fn().mockResolvedValue(START);
    const startRun = vi.fn().mockResolvedValue({ run_id: "01m3run" });
    const onStarted = vi.fn();
    render(<Start loadCard={loadCard} start={startRun} onStarted={onStarted} />);

    expect(AGENTS).toEqual(["support-assistant", "card-guardian", "concierge", "compliance-screen"]);
    await waitFor(() => { for (const a of AGENTS) expect(loadCard).toHaveBeenCalledWith(a); });
    const button = await screen.findByRole("button", { name: "Start" });
    expect(button).toBeDisabled();
    // Every agent answered, so every agent is offered.
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "card-guardian" })).toHaveAttribute("aria-pressed", "false");

    await user.type(screen.getByLabelText(/The customer this run is about/), "cust_a1b2c3d4");
    await user.type(screen.getByLabelText(/What the member of staff is asking for/), "Pay the plumber 250 GBP");
    await user.click(button);

    // The form values ARE the agent's input message (spec §9.3 step 6).
    expect(startRun).toHaveBeenCalledWith("support-assistant", {
      customer_id: "cust_a1b2c3d4", request: "Pay the plumber 250 GBP",
    });
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("01m3run"));
  });

  it("offers only the agents this persona may start: a 404 is by design, not an error", async () => {
    const user = userEvent.setup();
    // The persona reaches card-guardian and nothing else — what jdoe would
    // see if the assistant were not theirs to start.
    const loadCard = vi.fn((agent: string) => agent === "card-guardian" ? Promise.resolve(START) : notOffered());
    const startRun = vi.fn().mockResolvedValue({ run_id: "01m3run" });
    render(<Start loadCard={loadCard} start={startRun} onStarted={vi.fn()} />);

    const button = await screen.findByRole("button", { name: "Start" });
    // One agent is no choice, so no picker; and no alert, because nothing
    // went wrong.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/The customer this run is about/), "cust_a1b2c3d4");
    await user.type(screen.getByLabelText(/What the member of staff is asking for/), "card ending 1111 stolen");
    await user.click(button);
    expect(startRun).toHaveBeenCalledWith("card-guardian", {
      customer_id: "cust_a1b2c3d4", request: "card ending 1111 stolen",
    });
  });

  it("says so when the persona may start no agent at all, instead of an error", async () => {
    render(<Start loadCard={vi.fn(notOffered)} start={vi.fn()} onStarted={vi.fn()} />);
    await screen.findByText("This persona may not start any agent");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
  });

  it("selecting an agent renders its start card", async () => {
    const user = userEvent.setup();
    const guardian: Card = { ...START, subjectId: "card-guardian", title: "Start card-guardian" };
    const loadCard = vi.fn((agent: string) => Promise.resolve(agent === "card-guardian" ? guardian : START));
    render(<Start loadCard={loadCard} start={vi.fn()} onStarted={vi.fn()} />);

    await screen.findByRole("button", { name: "Start" });
    await user.click(screen.getByRole("button", { name: "card-guardian" }));
    expect(screen.getByRole("button", { name: "card-guardian" })).toHaveAttribute("aria-pressed", "true");
    await screen.findByText("Start card-guardian");
  });

  it("shows the server's refusal when the run cannot be started", async () => {
    const user = userEvent.setup();
    const startRun = vi.fn().mockRejectedValue(new Error("the agent cannot be invoked by this caller"));
    render(<Start loadCard={vi.fn().mockResolvedValue(START)} start={startRun} onStarted={vi.fn()} />);
    await user.type(await screen.findByLabelText(/The customer this run is about/), "cust_a1b2c3d4");
    await user.type(screen.getByLabelText(/What the member of staff is asking for/), "hello");
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("the agent cannot be invoked by this caller"));
  });

  it("surfaces a card that could not be loaded for any reason other than 404", async () => {
    render(<Start loadCard={vi.fn().mockRejectedValue(new Error("the tool plane is unavailable; try again"))} start={vi.fn()} onStarted={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("the tool plane is unavailable; try again"));
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
  });
});
