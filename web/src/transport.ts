// transport is the only place in Studio that knows a URL.
//
// Studio is a client of garmd's door and nothing else: every card, every
// listing and every decision is an ordinary RPC to `POST
// <base>/<package>.<Service>/<Method>` with the person's own bearer on it
// (spec 2026-09-29-cards-and-tasks §6). One base URL, one function, so the
// day garmd serves the endpoints the spec describes, nothing above this
// file moves.
//
// The base is empty by default, which means "this origin". `studiod` serves
// the bundle and reverse-proxies the garm API to garmd, so the browser sees
// one origin and garmd needs no CORS. A build that points the bundle
// somewhere else sets VITE_GARMD_URL at build time.
import { signOut, token } from "./auth";

export const garmdBase = trimSlash(import.meta.env.VITE_GARMD_URL ?? "");

// The token exchange is a different server and is NOT proxied by studiod.
// Studio calls it once, to mint the grant that travels with an approval
// (spec §7): the person's own bearer is what the exchange sees, and no tool
// may present it on their behalf. Unset means "no exchange configured", and
// an approve then refuses with a message that says so rather than posting
// into the void.
export const stsBase = trimSlash(import.meta.env.VITE_STS_URL ?? "");

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// Answer is what a governed call returns: the body, plus the two headers
// garmd puts on every answer. callId is the ledger row this call produced
// and the `CallRef` a result card is fetched by (spec §1.3); digest names
// the catalogue generation that answered, which is what a cache of tool
// rows is keyed by (spec §6, "cached per (viewer, catalogue digest)").
export interface Answer<T> {
  value: T;
  callId: string | null;
  digest: string | null;
}

export const EVENT_HEADER = "Garm-Event-Id";
export const DIGEST_HEADER = "Garm-Catalogue-Digest";

// method is a garmd path: "/garm.tasks.v1.TasksService/ListTasks". Studio
// never builds one from parts it guessed — the platform contracts are
// constants in api.ts and every other path comes from a ListTools row.
export async function rpc<T>(method: string, body: unknown = {}): Promise<Answer<T>> {
  const resp = await fetch(garmdBase + path(method), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token() ?? ""}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  return read<T>(resp);
}

// post is the one call Studio makes that is not to garmd: the token
// exchange's /approve. Same bearer, same refusal handling, a different
// origin.
export async function post<T>(base: string, route: string, body: unknown): Promise<Answer<T>> {
  const resp = await fetch(base + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token() ?? ""}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  return read<T>(resp);
}

async function read<T>(resp: Response): Promise<Answer<T>> {
  if (resp.status === 401) {
    // The token expired or the issuer rotated. Dropping it sends the person
    // back to the picker rather than leaving every screen showing an error
    // they cannot act on.
    signOut();
    throw new ApiError(401, "unauthenticated", "your session has expired");
  }
  const callId = resp.headers.get(EVENT_HEADER);
  const digest = resp.headers.get(DIGEST_HEADER);
  const text = await resp.text();
  if (!resp.ok) {
    // garmd writes every refusal in Connect's shape, `{code, message}`,
    // with the message already scrubbed of anything the caller may not
    // read. There is nothing here to reword: "a human grant is required"
    // tells the person exactly what happens next.
    let code = "internal";
    let message = "the call was refused";
    try {
      const parsed = JSON.parse(text);
      code = parsed.code ?? code;
      message = parsed.message ?? message;
    } catch {
      /* a proxy answered with HTML; the status is what survives */
    }
    throw new ApiError(resp.status, code, message);
  }
  const value = (text.length === 0 ? {} : JSON.parse(text)) as T;
  return { value, callId, digest };
}

function path(method: string): string {
  return method.startsWith("/") ? method : "/" + method;
}
