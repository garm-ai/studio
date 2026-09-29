package studio

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/garm-ai/studio/internal/sts"
)

// ApprovePath is the one route studiod serves that is neither the bundle
// nor a proxy.
const ApprovePath = "/studio/approve"

// approveRequest is what the page sends.
//
// All four fields come from the card the tasks tool served: the page read
// the tool and the subject off the task and built the material map from the
// facts that carry a source path. studiod looks none of it up and checks
// none of it for meaning — it cannot, and should not be able to. What it
// adds is one thing the browser cannot: the proof that this application is
// a registered client.
//
// A page that sent the wrong material buys a wrong context beside the right
// one, never a wrong grant: the digest is computed from what the tasks tool
// stored, and garmd compares it with the request that was actually parked.
type approveRequest struct {
	TaskID   string            `json:"task_id"`
	Tool     string            `json:"tool"`
	Subject  string            `json:"subject"`
	Material map[string]string `json:"material"`
}

// approveHandler is the backend for frontend.
//
// A browser cannot hold a signing key, so it cannot be a registered client
// of the token service, and teaching that service to accept unregistered
// callers would empty the registry that says which application is asking.
// So the browser presents the person's bearer to its own origin, and this
// process presents that bearer as the subject token together with its own
// client assertion. The authority exchanged is still the person's; the
// application asking is now provable.
//
// The grant comes straight back to the page, which hands it to the tasks
// tool through garmd. Nothing here stores it, logs it, or looks at it.
func approveHandler(client *sts.Client, log *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			fail(w, http.StatusMethodNotAllowed, "method_not_allowed", "this route takes a POST")
			return
		}
		if client == nil {
			// A deployment may run Studio with no token service at all —
			// to work on the renderer, or where nothing asks for approval.
			// Saying so is better than a 404 that reads like a typo.
			fail(w, http.StatusNotImplemented, "no_token_exchange",
				"this deployment has no token service configured, so an approval cannot be signed")
			return
		}
		bearer := bearerOf(r)
		if bearer == "" {
			// The person's own token is the whole point of the route. A
			// request without one is not something to forward with only
			// this process's credential on it.
			fail(w, http.StatusUnauthorized, "unauthenticated",
				"an approval is signed for the person making it; sign in and try again")
			return
		}

		var req approveRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, maxApproveBytes)).Decode(&req); err != nil {
			fail(w, http.StatusBadRequest, "invalid_request", "the request body is not the expected JSON")
			return
		}
		if req.TaskID == "" || req.Tool == "" || req.Subject == "" {
			fail(w, http.StatusBadRequest, "invalid_request",
				"a grant names the task, the tool and the subject it is for")
			return
		}

		grant, err := client.Approve(r.Context(), bearer, req.Tool, req.Subject, req.TaskID, req.Material)
		if err != nil {
			// Never the upstream's words. A refusal is the token service's
			// decision, and it answers every one of them the same way so
			// that the endpoint cannot be used to enumerate anything;
			// repeating its body here would undo that.
			switch {
			case errors.Is(err, sts.ErrDenied):
				log.Info("the token service refused an approval", "task_id", req.TaskID, "tool", req.Tool)
				fail(w, http.StatusForbidden, "approval_refused",
					"the token service refused to sign this approval")
			default:
				log.Error("the token service could not be reached", "err", err)
				fail(w, http.StatusBadGateway, "token_exchange_unavailable",
					"the token service could not be reached; try again")
			}
			return
		}

		w.Header().Set("Content-Type", "application/json")
		// A grant is a credential with a life of minutes. Nothing may keep
		// a copy of this answer on the way back to the page.
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"grant":      grant.Token,
			"expires_in": int(grant.ExpiresIn.Seconds()),
		})
	})
}

// maxApproveBytes is a guard, not a policy: a material map is a handful of
// short strings, and nothing here should read a request that is not one.
const maxApproveBytes = 64 << 10

func bearerOf(r *http.Request) string {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if len(h) <= len(prefix) || !equalFold(h[:len(prefix)], prefix) {
		return ""
	}
	return h[len(prefix):]
}

// equalFold over ASCII, which is all an Authorization scheme may be. Worth
// the four lines: a client that sends "bearer " is sending a valid header
// and refusing it would be a bug nobody could see from the browser.
func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range len(a) {
		x, y := a[i], b[i]
		if 'A' <= x && x <= 'Z' {
			x += 'a' - 'A'
		}
		if 'A' <= y && y <= 'Z' {
			y += 'a' - 'A'
		}
		if x != y {
			return false
		}
	}
	return true
}

// fail writes the refusal shape the page already reads: garmd's, so that
// one branch in the browser handles every refusal Studio can receive.
func fail(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "message": message})
}
