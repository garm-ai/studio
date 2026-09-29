package studio_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/garm-ai/studio"
)

// bundle is a stand-in for what `mise run ui` builds: an index and one
// asset, enough to tell "served the application" from "served a file" from
// "fell back to the application".
func bundle() fstest.MapFS {
	return fstest.MapFS{
		"index.html":             {Data: []byte(`<!doctype html><div id="root"></div>`)},
		"assets/index-a1b2c3.js": {Data: []byte(`console.log("studio")`)},
	}
}

// start runs Serve on a free port and returns its base URL. The server is
// started through the EXPORTED entry point, because that is the one a
// development harness calls and the one that has to keep working.
func start(t *testing.T, cfg studio.Config) string {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	addr := make(chan string, 1)
	done := make(chan error, 1)
	cfg.Listen = "127.0.0.1:0"
	cfg.Assets = bundle()
	cfg.OnListen = func(a string) { addr <- a }
	go func() { done <- studio.Serve(ctx, cfg) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("Serve returned %v; a cancelled context is a clean stop", err)
			}
		case <-time.After(10 * time.Second):
			t.Error("Serve did not return within ten seconds of the context being cancelled")
		}
	})
	select {
	case a := <-addr:
		return "http://" + a
	case err := <-done:
		t.Fatalf("Serve returned before listening: %v", err)
		return ""
	case <-time.After(10 * time.Second):
		t.Fatal("Serve never listened")
		return ""
	}
}

func get(t *testing.T, url string) (*http.Response, string) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp, string(body)
}

func TestServeServesTheBundleAndFallsBackToItForAClientSideRoute(t *testing.T) {
	base := start(t, studio.Config{GarmdURL: "http://127.0.0.1:1"})

	if resp, body := get(t, base+"/"); resp.StatusCode != http.StatusOK || body != `<!doctype html><div id="root"></div>` {
		t.Errorf("GET / = %d %q", resp.StatusCode, body)
	}
	if resp, body := get(t, base+"/assets/index-a1b2c3.js"); resp.StatusCode != http.StatusOK || body != `console.log("studio")` {
		t.Errorf("GET an asset = %d %q", resp.StatusCode, body)
	}
	// A reload on a path Studio routes client-side must get the
	// application, not a not-found.
	if resp, body := get(t, base+"/tasks/tsk_1"); resp.StatusCode != http.StatusOK || body != `<!doctype html><div id="root"></div>` {
		t.Errorf("GET a client-side route = %d %q; want the application", resp.StatusCode, body)
	}
	// And a directory is the application too, never a listing of the
	// application's files.
	if _, body := get(t, base+"/assets/"); body != `<!doctype html><div id="root"></div>` {
		t.Errorf("GET a directory = %q; want the application and never a listing", body)
	}
}

func TestServeForwardsAGovernedCallToGarmdWithTheBearerAndTheLedgerHeader(t *testing.T) {
	var (
		gotPath string
		gotAuth string
		gotBody string
	)
	garmd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Garm-Event-Id", "evt_01m3")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"cards":[],"cursor":""}`))
	}))
	defer garmd.Close()

	base := start(t, studio.Config{GarmdURL: garmd.URL})

	req, err := http.NewRequest(http.MethodPost,
		base+"/garm.tasks.v1.TasksService/ListTasks", strings.NewReader(`{"view":"QUEUE"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer the-persons-own-token")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if gotPath != "/garm.tasks.v1.TasksService/ListTasks" {
		t.Errorf("garmd saw %q; the path is forwarded as sent", gotPath)
	}
	// The bearer is the person's own and garmd's first step folds it. A
	// proxy that dropped it would turn every call into a 401.
	if gotAuth != "Bearer the-persons-own-token" {
		t.Errorf("garmd saw Authorization %q", gotAuth)
	}
	if gotBody != `{"view":"QUEUE"}` {
		t.Errorf("garmd saw body %q", gotBody)
	}
	// Garm-Event-Id names the ledger row and is the call id a result card
	// is fetched by; losing it would cost Studio the run it just started.
	if got := resp.Header.Get("Garm-Event-Id"); got != "evt_01m3" {
		t.Errorf("Garm-Event-Id = %q, want it forwarded back", got)
	}
	if string(body) != `{"cards":[],"cursor":""}` {
		t.Errorf("body = %q", body)
	}
}

func TestServeForwardsOnlyTheTwoDevLoginRoutes(t *testing.T) {
	idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("the identity provider saw Authorization %q; Studio's bearer is not its business", got)
		}
		_, _ = w.Write([]byte("from the idp: " + r.URL.Path))
	}))
	defer idp.Close()

	base := start(t, studio.Config{GarmdURL: "http://127.0.0.1:1", DevIdPURL: idp.URL})

	if resp, body := get(t, base+"/idp/personas"); resp.StatusCode != http.StatusOK || body != "from the idp: /personas" {
		t.Errorf("GET /idp/personas = %d %q", resp.StatusCode, body)
	}
	if resp, body := get(t, base+"/idp/token?user=alice"); resp.StatusCode != http.StatusOK || body != "from the idp: /token" {
		t.Errorf("GET /idp/token = %d %q", resp.StatusCode, body)
	}
	// Nothing else of the provider is reachable through this.
	if resp, _ := get(t, base+"/idp/.well-known/jwks.json"); resp.StatusCode != http.StatusNotFound {
		t.Errorf("GET /idp/.well-known/jwks.json = %d, want 404: only the two login routes are forwarded", resp.StatusCode)
	}
	resp, err := http.Post(base+"/idp/token", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST /idp/token = %d, want 405", resp.StatusCode)
	}
}

func TestWithoutADevIdentityProviderTheLoginRoutesAreTheApplication(t *testing.T) {
	base := start(t, studio.Config{GarmdURL: "http://127.0.0.1:1"})
	// No proxy, so /idp/personas is a path like any other and Studio's
	// single-page fallback answers it. The login screen then offers the
	// paste-a-token way in, which is what it is for.
	if _, body := get(t, base+"/idp/personas"); body != `<!doctype html><div id="root"></div>` {
		t.Errorf("GET /idp/personas with no provider = %q", body)
	}
}

func TestServeRefusesAConfigurationItCannotServe(t *testing.T) {
	for _, tc := range []struct {
		name string
		cfg  studio.Config
	}{
		{"no garmd", studio.Config{}},
		{"a garmd URL that is not a URL", studio.Config{GarmdURL: "garmd:7440"}},
		{"a dev identity provider that is not a URL", studio.Config{GarmdURL: "http://garmd:7440", DevIdPURL: "127.0.0.1:7450"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := tc.cfg
			cfg.Listen = "127.0.0.1:0"
			cfg.Assets = bundle()
			if err := studio.Serve(context.Background(), cfg); err == nil {
				t.Fatal("Serve returned nil; a configuration that cannot be served is refused before the listener opens")
			}
		})
	}
}

func TestIsAPIPath(t *testing.T) {
	// The rule is the shape of a garm method path, so a catalogue that
	// gains a service is reachable without telling this proxy anything.
	for _, p := range []string{
		"/garm.tasks.v1.TasksService/ListTasks",
		"/garm.v1.ToolCatalogService/ListTools",
		"/bank.agents.v1.SupportAssistant/Invoke",
	} {
		if !studio.IsAPIPath(p) {
			t.Errorf("IsAPIPath(%q) = false, want true", p)
		}
	}
	for _, p := range []string{
		"/", "/index.html", "/assets/index-a1b2c3.js", "/idp/personas",
		"/garm.tasks.v1.TasksService", "/garm.tasks.v1.TasksService/ListTasks/extra",
	} {
		if studio.IsAPIPath(p) {
			t.Errorf("IsAPIPath(%q) = true, want false", p)
		}
	}
}
