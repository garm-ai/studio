import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Inbox } from "./Inbox";
import type { Card } from "../api";
import queue from "../fixtures/queue.json";

// The fixture is a `list_tasks` answer: a page of summary cards, each one
// already projected to this viewer by garmd (spec §3.2 rule 1).
const [PAYMENT, ASK] = (queue.cards as Card[]);

const at = (card: Card, over: Partial<Card>): Card => ({ ...card, ...over });

describe("Inbox", () => {
  it("loads the queue first and switches view when a filter is clicked", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async (view: string) => {
      if (view === "QUEUE") return [PAYMENT, ASK];
      if (view === "MINE") return [at(PAYMENT, { subjectId: "tsk_m1", state: "OPEN" })];
      return [at(PAYMENT, { subjectId: "tsk_d1", state: "ANSWERED" })];
    });
    render(<Inbox load={load} />);

    await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(2));
    expect(load).toHaveBeenCalledWith("QUEUE");

    await user.click(screen.getByRole("button", { name: /^mine$/i }));
    await waitFor(() => expect(load).toHaveBeenCalledWith("MINE"));
    await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: /^done$/i }));
    await waitFor(() => expect(load).toHaveBeenCalledWith("DONE"));
    expect(await screen.findByText("answered")).toBeInTheDocument();
  });

  // An empty queue is the normal state, not an error, and it must say so —
  // a blank panel reads as a page that failed to load.
  it("says the queue is empty rather than showing nothing", async () => {
    render(<Inbox load={vi.fn().mockResolvedValue([])} />);
    expect(await screen.findByText(/nothing is waiting/i)).toBeInTheDocument();
  });

  // Studio shows the facts the tasks tool put on the summary card, whatever
  // they are; it does not decide which of them matter.
  it("shows the card's own facts on the row, so a person can triage without opening one", async () => {
    render(<Inbox load={vi.fn().mockResolvedValue([PAYMENT])} />);
    expect(await screen.findByText("Amount")).toBeInTheDocument();
    expect(screen.getByText("25000")).toBeInTheDocument();
  });

  // Each row is a CardRef: it links to the task, and the id in the link is
  // the server's, encoded.
  it("links each row to the task, with the id encoded", async () => {
    render(<Inbox load={vi.fn().mockResolvedValue([at(PAYMENT, { subjectId: "tsk 1/a" })])} />);
    const link = await screen.findByRole("link", { name: /Initiate a payment/ });
    expect(link).toHaveAttribute("href", "#/tasks/tsk%201%2Fa");
  });

  it("surfaces a load failure instead of an empty list", async () => {
    render(<Inbox load={vi.fn().mockRejectedValue(new Error("your session has expired"))} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("your session has expired"));
  });

  // `list_tasks` pages with a cursor. A cut list that said nothing would be
  // indistinguishable from a complete one, and the person triaging it would
  // believe they had seen everything.
  it("says when there is another page", async () => {
    render(<Inbox load={vi.fn().mockResolvedValue({ cards: [PAYMENT], cursor: "c2" })} />);
    expect(await screen.findByText(/not every task is shown/i)).toBeInTheDocument();
  });
});
