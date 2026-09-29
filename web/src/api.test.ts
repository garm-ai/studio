import { afterEach, describe, expect, it, vi } from "vitest";
import { approve, listTasks, material } from "./api";
import { APPROVE, ApiError } from "./transport";
import { saveToken, signOut } from "./auth";
import taskOpen from "./fixtures/task-open.json";
import type { Card } from "./api";

// These exercise the transport itself — the calls App.test.tsx mocks — so
// that what actually leaves the browser is held somewhere.
function answering(status: number, body: string, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async () => new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  signOut();
});

describe("approve", () => {
  // Studio does not know where the token service is, and must not: a grant
  // is signed by a registered client and a browser cannot hold a key. The
  // page asks its own origin, and studiod adds the half the page cannot.
  it("asks studiod's own route, on this origin, with the person's bearer", async () => {
    saveToken("the-persons-own-token");
    const fetchMock = answering(200, JSON.stringify({ grant: "the.grant.jwt", expires_in: 900 }));

    const grant = await approve(
      "payments.v1.initiate_payment", "employee:jdoe", "tsk_d196",
      { amount_minor_units: "25000", currency_code: "GBP" },
    );

    expect(grant).toBe("the.grant.jwt");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(APPROVE);
    expect(APPROVE).toBe("/studio/approve");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer the-persons-own-token");
    // The four fields the page read off the card the tasks tool served.
    expect(JSON.parse(init.body as string)).toEqual({
      task_id: "tsk_d196",
      tool: "payments.v1.initiate_payment",
      subject: "employee:jdoe",
      material: { amount_minor_units: "25000", currency_code: "GBP" },
    });
  });

  // studiod answers in garmd's refusal shape, so one branch in the browser
  // handles every refusal Studio can receive, and the words are the
  // server's.
  it("shows the refusal as the server wrote it", async () => {
    saveToken("a-token");
    answering(403, JSON.stringify({ code: "approval_refused", message: "the token service refused to sign this approval" }));
    await expect(approve("payments.v1.initiate_payment", "employee:jdoe", "tsk_1", {}))
      .rejects.toThrow("the token service refused to sign this approval");
  });

  it("is a 401 like any other call: the token is dropped and the picker returns", async () => {
    saveToken("an-expired-token");
    answering(401, "");
    await expect(approve("payments.v1.initiate_payment", "employee:jdoe", "tsk_1", {}))
      .rejects.toBeInstanceOf(ApiError);
    expect(sessionStorage.getItem("studio.token")).toBeNull();
  });
});

describe("the calls Studio makes to garmd", () => {
  it("posts a governed method path with the bearer and reads the page back", async () => {
    saveToken("a-token");
    const fetchMock = answering(200, JSON.stringify({ cards: [], cursor: "c2" }));

    expect(await listTasks("QUEUE")).toEqual({ cards: [], cursor: "c2" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/garm.tasks.v1.TasksService/ListTasks");
    expect(JSON.parse(init.body as string)).toEqual({ view: "QUEUE", cursor: "" });
  });
});

describe("material", () => {
  // The one thing Studio computes: every fact that carries a source path,
  // at any depth. A fact the viewer did not reach is absent, and the tool's
  // card is then built from less — which is the point.
  it("reads the facts that carry a source path and nothing else", () => {
    const card: Card = {
      body: [
        { facts: { facts: [{ label: "Owned by", value: "payments-platform" }] } },
        { section: { title: "Material", elements: [
          { facts: { facts: [
            { label: "Amount", value: "25000", field: "amount_minor_units" },
            { label: "Currency", value: "GBP", field: "currency_code" },
          ] } },
        ] } },
      ],
    };
    expect(material(card)).toEqual({ amount_minor_units: "25000", currency_code: "GBP" });
    // The demo fixture carries no source paths yet, and an empty map is the
    // honest answer rather than a guess from the labels.
    expect(material(taskOpen as Card)).toEqual({});
  });
});
