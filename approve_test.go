package studio_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/garm-ai/studio"
)

// approveCall is what the fake token service saw.
type approveCall struct {
	Path                string
	Authorization       string
	ClientAssertion     string `json:"client_assertion"`
	ClientAssertionType string `json:"client_assertion_type"`
	Tool                string `json:"tool"`
	Subject             string `json:"subject"`
	TaskID              string `json:"task_id"`
	Material            map[string]string
}

// fakeSTS answers /approve with a grant and records what it was given.
func fakeSTS(t *testing.T, status int) (*httptest.Server, *approveCall) {
	t.Helper()
	seen := &approveCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Path = r.URL.Path
		seen.Authorization = r.Header.Get("Authorization")
		var body struct {
			ClientAssertion     string            `json:"client_assertion"`
			ClientAssertionType string            `json:"client_assertion_type"`
			Tool                string            `json:"tool"`
			Subject             string            `json:"subject"`
			TaskID              string            `json:"task_id"`
			Material            map[string]string `json:"material"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("the token service could not read the body: %v", err)
		}
		seen.ClientAssertion = body.ClientAssertion
		seen.ClientAssertionType = body.ClientAssertionType
		seen.Tool = body.Tool
		seen.Subject = body.Subject
		seen.TaskID = body.TaskID
		seen.Material = body.Material
		if status != http.StatusOK {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":"access_denied"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"grant":"the.grant.jwt","expires_in":900}`))
	}))
	t.Cleanup(srv.Close)
	return srv, seen
}

func aKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func postApprove(t *testing.T, base, bearer, body string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, base+studio.ApprovePath, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp, string(out)
}

const anApproval = `{"task_id":"tsk_d196","tool":"payments.v1.initiate_payment",` +
	`"subject":"employee:jdoe","material":{"amount_minor_units":"25000","currency_code":"GBP"}}`

// This is the whole reason studiod is a server and not a file host: a
// browser cannot hold a signing key, so it cannot be a registered client of
// the token service. The person's authority and the application's identity
// arrive separately and stay separate — the bearer in the header, the
// assertion in the body — and both reach the token service.
func TestApprovePresentsThePersonsBearerAndStudiodsOwnClientAssertion(t *testing.T) {
	ts, seen := fakeSTS(t, http.StatusOK)
	base := start(t, studio.Config{
		GarmdURL:     "http://127.0.0.1:1",
		STSURL:       ts.URL,
		STSClientID:  "studiod",
		STSClientKey: aKey(t),
	})

	resp, body := postApprove(t, base, "the-persons-own-token", anApproval)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST %s = %d %s", studio.ApprovePath, resp.StatusCode, body)
	}
	if seen.Path != "/approve" {
		t.Errorf("the token service saw %q", seen.Path)
	}
	// The approver is the person. Sending anything else here would be the
	// application approving on its own authority.
	if seen.Authorization != "Bearer the-persons-own-token" {
		t.Errorf("the token service saw Authorization %q; it must be the person's own bearer", seen.Authorization)
	}
	// And the assertion says which application is asking. It is signed
	// here, travels in the body, and is a JWT rather than the key itself.
	if seen.ClientAssertionType != "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" {
		t.Errorf("client_assertion_type = %q", seen.ClientAssertionType)
	}
	if got := strings.Count(seen.ClientAssertion, "."); got != 2 {
		t.Fatalf("client_assertion = %q; want a signed JWT", seen.ClientAssertion)
	}
	claims := assertionClaims(t, seen.ClientAssertion)
	if claims["iss"] != "studiod" || claims["sub"] != "studiod" {
		t.Errorf("the assertion names %v/%v, not the registered client", claims["iss"], claims["sub"])
	}
	if claims["aud"] != ts.URL+"/token" {
		t.Errorf("aud = %v; it defaults to the token endpoint of --sts-url", claims["aud"])
	}
	if claims["jti"] == nil || claims["jti"] == "" {
		t.Error("the assertion carries no jti; the token service checks it is single use")
	}

	// The four fields came from the page, which read them off the card the
	// tasks tool served. studiod looked none of them up.
	if seen.TaskID != "tsk_d196" || seen.Tool != "payments.v1.initiate_payment" || seen.Subject != "employee:jdoe" {
		t.Errorf("the token service saw task %q tool %q subject %q", seen.TaskID, seen.Tool, seen.Subject)
	}
	if seen.Material["amount_minor_units"] != "25000" || seen.Material["currency_code"] != "GBP" {
		t.Errorf("material = %v; values are canonical text and travel as sent", seen.Material)
	}

	// And the grant comes back to the page, which hands it to the tasks
	// tool through garmd. Nothing here keeps a copy.
	var out struct {
		Grant     string `json:"grant"`
		ExpiresIn int    `json:"expires_in"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	if out.Grant != "the.grant.jwt" || out.ExpiresIn != 900 {
		t.Errorf("answered %q", body)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q; a grant lives for minutes and must not be cached", got)
	}
}

func TestApproveRefusesWithoutThePersonsBearer(t *testing.T) {
	ts, seen := fakeSTS(t, http.StatusOK)
	base := start(t, studio.Config{
		GarmdURL:     "http://127.0.0.1:1",
		STSURL:       ts.URL,
		STSClientID:  "studiod",
		STSClientKey: aKey(t),
	})

	resp, body := postApprove(t, base, "", anApproval)

	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("POST with no bearer = %d %s, want 401", resp.StatusCode, body)
	}
	// Nothing was forwarded. A request with only this process's credential
	// on it is not an approval anybody made.
	if seen.Path != "" {
		t.Errorf("the token service was called anyway (%q); an unsigned-in caller never reaches it", seen.Path)
	}
	if strings.Contains(body, "client_assertion") {
		t.Errorf("the refusal mentions the assertion: %s", body)
	}
}

func TestApproveRefusesARequestThatNamesNoTask(t *testing.T) {
	ts, seen := fakeSTS(t, http.StatusOK)
	base := start(t, studio.Config{
		GarmdURL: "http://127.0.0.1:1", STSURL: ts.URL,
		STSClientID: "studiod", STSClientKey: aKey(t),
	})
	for _, body := range []string{
		`{"tool":"payments.v1.initiate_payment","subject":"employee:jdoe"}`,
		`{"task_id":"tsk_1","subject":"employee:jdoe"}`,
		`{"task_id":"tsk_1","tool":"payments.v1.initiate_payment"}`,
		`not json`,
	} {
		resp, out := postApprove(t, base, "a-token", body)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("POST %s = %d %s, want 400", body, resp.StatusCode, out)
		}
	}
	if seen.Path != "" {
		t.Errorf("the token service was called with an incomplete approval (%q)", seen.Path)
	}
}

// The token service answers every refusal the same way so that the endpoint
// cannot be used to enumerate anything. Repeating its body to the browser
// would undo that, so the page gets this process's own words.
func TestApproveDoesNotRepeatTheTokenServicesRefusal(t *testing.T) {
	ts, _ := fakeSTS(t, http.StatusForbidden)
	base := start(t, studio.Config{
		GarmdURL: "http://127.0.0.1:1", STSURL: ts.URL,
		STSClientID: "studiod", STSClientKey: aKey(t),
	})

	resp, body := postApprove(t, base, "a-token", anApproval)

	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("a refused approval = %d, want 403", resp.StatusCode)
	}
	if strings.Contains(body, "access_denied") {
		t.Errorf("the upstream's body reached the browser: %s", body)
	}
	if !strings.Contains(body, "approval_refused") {
		t.Errorf("answered %q; the page reads a code and a message", body)
	}
}

// A deployment may run Studio with no token service at all — to work on the
// renderer, or where nothing asks for approval. Saying so beats a 404 that
// reads like a typo.
func TestWithNoTokenServiceTheApproveRouteSaysSo(t *testing.T) {
	base := start(t, studio.Config{GarmdURL: "http://127.0.0.1:1"})
	resp, body := postApprove(t, base, "a-token", anApproval)
	if resp.StatusCode != http.StatusNotImplemented {
		t.Errorf("POST %s = %d %s, want 501", studio.ApprovePath, resp.StatusCode, body)
	}
	if !strings.Contains(body, "no_token_exchange") {
		t.Errorf("answered %q", body)
	}
}

// Two of the three is a deployment that meant to sign approvals and would
// find out at the first click, which is the wrong moment.
func TestServeRefusesHalfATokenServiceConfiguration(t *testing.T) {
	for _, cfg := range []studio.Config{
		{GarmdURL: "http://garmd:7440", STSURL: "http://sts:8080"},
		{GarmdURL: "http://garmd:7440", STSURL: "http://sts:8080", STSClientID: "studiod"},
		{GarmdURL: "http://garmd:7440", STSClientID: "studiod", STSClientKeyFile: "/dev/null"},
	} {
		cfg.Listen = "127.0.0.1:0"
		cfg.Assets = bundle()
		if err := studio.Serve(t.Context(), cfg); err == nil {
			t.Errorf("Serve(%+v) returned nil; all three or none", cfg)
		}
	}
}

// assertionClaims reads the assertion's payload WITHOUT verifying it. The
// token service verifies; this test is asserting what was sent.
func assertionClaims(t *testing.T, jwt string) map[string]any {
	t.Helper()
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		t.Fatalf("not a compact JWS: %q", jwt)
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatal(err)
	}
	return claims
}
