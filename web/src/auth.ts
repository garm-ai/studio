// Login is the devkit IdP's persona picker (spec, decision 3). There is no
// password and there is not meant to be: this is a development identity
// provider, the token is minted by a GET, and pretending otherwise would
// teach people that this flow is one to keep.
//
// The IdP's URL is fixed at BUILD time rather than fetched from the server,
// because the browser talks to the IdP directly and the server has no reason
// to know where it is.
const IDP = import.meta.env.VITE_IDP_URL ?? "http://127.0.0.1:7450";

export const idpURL = IDP;

export interface Persona { handle: string; subject: string; roles: string[]; }

export async function listPersonas(): Promise<Persona[]> {
  const resp = await fetch(`${IDP}/personas`);
  if (!resp.ok) throw new Error(`the identity provider answered ${resp.status}`);
  const body = await resp.json();
  // devkit's persona struct carries YAML tags only, so its JSON uses the Go
  // field names (`Subject`, `Roles`); a devkit that adds json tags will use
  // the lower-case ones. Read both, prefer the lower-case.
  return Object.entries(body.users ?? {}).map(([handle, u]) => {
    const p = u as { subject?: string; Subject?: string; roles?: string[]; Roles?: string[] };
    return { handle, subject: p.subject ?? p.Subject ?? "", roles: p.roles ?? p.Roles ?? [] };
  });
}

export async function mint(handle: string): Promise<string> {
  const resp = await fetch(`${IDP}/token?user=${encodeURIComponent(handle)}`);
  if (!resp.ok) throw new Error(`the identity provider refused: ${resp.status}`);
  return (await resp.text()).trim();
}

const KEY = "agentd.token";

export function saveToken(t: string) { sessionStorage.setItem(KEY, t); }
export function token(): string | null { return sessionStorage.getItem(KEY); }
export function signOut() { sessionStorage.removeItem(KEY); }

// sessionStorage rather than localStorage: a development token that
// survives closing the tab is one somebody finds in a browser months later
// and wonders about. It expires anyway; this makes that visible.

// whoAmI names the signed-in subject for the rail, and the agent acting for
// them when the token is delegated — the one case a person needs to see,
// because it is why an approve will be refused. Read from the token's
// payload without verifying it (the server verifies; this is a label), and
// never the token itself: nothing here returns or renders the bearer.
export function whoAmI(): string | null {
  const t = token();
  if (!t) return null;
  try {
    const payload = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    const act = typeof payload.act?.sub === "string" ? payload.act.sub : null;
    if (!sub) return null;
    return act ? `${act} for ${sub}` : sub;
  } catch {
    return null;
  }
}
