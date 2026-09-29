import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Inbox } from "./Inbox";
import type { Task } from "../api";

const open = (id: string, overrides: Partial<Task> = {}): Task => ({
  id, run_id: "01j8run", tool_fqn: "payments.v1.initiate_payment",
  subject: "employee:jdoe", material: { amount_minor_units: "250000" },
  state: "open",
  predicate: { min_clearance: "CLEARANCE_RESTRICTED", compartments: ["financial"] },
  created_at: "2026-09-28T10:00:00Z", expires_at: "2026-09-28T10:15:00Z",
  ...overrides,
});

describe("Inbox", () => {
  it("loads the queue first and switches view when a filter is clicked", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async (view: string) => {
      if (view === "queue") return [open("tsk_q1"), open("tsk_q2")];
      if (view === "mine") return [open("tsk_m1", { state: "claimed", claimant: "employee:sam" })];
      return [open("tsk_d1", { state: "approved", reason: "confirmed" })];
    });
    render(<Inbox load={load} />);

    await waitFor(() => expect(screen.getAllByText("payments.v1.initiate_payment")).toHaveLength(2));
    expect(load).toHaveBeenCalledWith("queue");

    await user.click(screen.getByRole("button", { name: /^mine$/i }));
    await waitFor(() => expect(load).toHaveBeenCalledWith("mine"));
    await waitFor(() => expect(screen.getAllByText("payments.v1.initiate_payment")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: /^done$/i }));
    await waitFor(() => expect(load).toHaveBeenCalledWith("done"));
    expect(await screen.findByText("approved")).toBeInTheDocument();
  });

  // An empty queue is the normal state, not an error, and it must say so —
  // a blank panel reads as a page that failed to load.
  it("says the queue is empty rather than showing nothing", async () => {
    render(<Inbox load={vi.fn().mockResolvedValue([])} />);
    expect(await screen.findByText(/nothing is waiting/i)).toBeInTheDocument();
  });

  it("shows the amount on each row, so a person can triage without opening one", async () => {
    render(<Inbox load={vi.fn().mockResolvedValue([open("tsk_1")])} />);
    expect(await screen.findByText(/250000/)).toBeInTheDocument();
  });

  // Each row is a CardRef: it links to the task's card, and the id in the
  // link is the server's, encoded.
  it("links each row to the task card, with the id encoded", async () => {
    render(<Inbox load={vi.fn().mockResolvedValue([open("tsk 1/a")])} />);
    const link = await screen.findByRole("link", { name: /payments.v1.initiate_payment/ });
    expect(link).toHaveAttribute("href", "#/tasks/tsk%201%2Fa");
  });

  it("surfaces a load failure instead of an empty list", async () => {
    render(<Inbox load={vi.fn().mockRejectedValue(new Error("your session has expired"))} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("your session has expired"));
  });

  // GET /tasks caps the listing and says so with `truncated`. A cut list
  // that said nothing would be indistinguishable from a complete one, and
  // the person triaging it would believe they had seen everything.
  it("says when the listing was cut short", async () => {
    render(
      <Inbox
        load={vi.fn().mockResolvedValue({ tasks: [open("tsk_1")], truncated: true })}
       
      />,
    );
    expect(await screen.findByText(/not every task is shown/i)).toBeInTheDocument();
  });
});
