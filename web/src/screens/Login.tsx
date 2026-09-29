import { useEffect, useState } from "react";
import { idpURL, listPersonas, mint, saveToken, type Persona } from "../auth";

// Login is the devkit persona picker: a list of the people the dev IdP knows,
// one click each. No password, and none pretended.
//
// The picker talks to the IdP from the browser, and the IdP sends no CORS
// headers on purpose (devkit/internal/idp/ui.go says why). When the
// browser refuses the cross-origin answer, this screen says so and takes a
// token minted at the terminal instead — the same token the picker would
// have fetched, arriving by paste. Either way it is held in sessionStorage
// and nowhere else.
export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");

  useEffect(() => {
    let cancelled = false;
    listPersonas()
      .then((p) => { if (!cancelled) setPersonas(p); })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPersonas([]);
        setError(e instanceof Error
          ? `the identity provider at ${idpURL} could not be read (${e.message})`
          : `the identity provider at ${idpURL} could not be read`);
      });
    return () => { cancelled = true; };
  }, []);

  async function pick(handle: string) {
    setBusy(handle);
    setError(null);
    try {
      saveToken(await mint(handle));
      onSignedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "the token could not be minted");
    } finally {
      setBusy(null);
    }
  }

  function usePasted() {
    const t = pasted.trim();
    if (!t) return;
    saveToken(t);
    setPasted("");
    onSignedIn();
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="mark">AI</div>
        <h1>Studio</h1>
        <p>Pick who you are. This is the development identity provider: it mints any persona it is asked for, and there is no password because there is nothing here worth one.</p>

        {personas === null && <div className="count">Asking the identity provider who it knows…</div>}
        {personas?.map((p) => (
          <button key={p.handle} className="persona" disabled={busy !== null} onClick={() => void pick(p.handle)}>
            <span className="h">{p.handle}</span>
            <span className="s mono">{p.subject}{p.roles.length > 0 && ` · ${p.roles.join(", ")}`}</span>
          </button>
        ))}
        {error && <p role="alert" className="alert">{error}</p>}

        {personas !== null && (
          <details open={personas.length === 0} style={{ marginTop: 16 }}>
            <summary className="lbl" style={{ cursor: "pointer" }}>Paste a token instead</summary>
            <p style={{ marginBottom: 8 }}>
              Mint one at the terminal — <code className="mono">curl -s '{idpURL}/token?user=alice'</code> — and paste it here. It is kept for this tab only.
            </p>
            <label className="lbl" htmlFor="pasted-token">Token</label>
            <textarea id="pasted-token" className="comment" rows={3} value={pasted}
                      onChange={(e) => setPasted(e.target.value)} autoComplete="off" spellCheck={false} />
            <button className="btn btn-primary" disabled={pasted.trim().length === 0} onClick={usePasted}>
              Sign in with this token
            </button>
          </details>
        )}
        <div className="login-foot">Development identity provider · {idpURL}</div>
      </div>
    </div>
  );
}
