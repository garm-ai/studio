package ui_test

import (
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/garm-ai/studio/internal/ui"
)

// Whatever `mise run ui` produced is embedded and served. It SKIPS when the
// bundle is absent, because a Go-only checkout is a normal state and
// failing here would make `go test ./...` require npm. It runs wherever
// `mise run ui` ran first, which in CI is every job.
func TestTheEmbeddedBundleServesItsIndex(t *testing.T) {
	assets, err := ui.Assets()
	if err != nil {
		if !errors.Is(err, ui.ErrNoBundle) {
			t.Fatalf("Assets() = %v, want ErrNoBundle when nothing is built", err)
		}
		t.Skip("no bundle is embedded; run `mise run ui` first")
	}
	body, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `<div id="root">`) {
		t.Errorf("index.html does not look like Studio: %.200s", body)
	}
	// Relative asset paths (vite `base: "./"`): the bundle must not assume
	// it is mounted at the origin's root, because a bank may serve it from
	// a prefix in its own web tier.
	if strings.Contains(string(body), `src="/assets/`) || strings.Contains(string(body), `href="/assets/`) {
		t.Errorf("index.html references /assets/ absolutely; vite base must be \"./\": %.400s", body)
	}
	// And the assets it names must exist in the same tree — a bundle whose
	// index points at a hash that was not embedded would 404 its own script.
	for _, ref := range assetRefs(string(body)) {
		if _, err := fs.Stat(assets, ref); err != nil {
			t.Errorf("index.html references %q, which is not in the bundle: %v", ref, err)
		}
	}

	srv := httptest.NewServer(http.FileServerFS(assets))
	defer srv.Close()
	resp, err := srv.Client().Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET / = %d", resp.StatusCode)
	}
}

// assetRefs pulls every `./assets/…` reference out of index.html.
func assetRefs(html string) []string {
	var out []string
	for _, marker := range []string{`src="./`, `href="./`} {
		rest := html
		for {
			i := strings.Index(rest, marker)
			if i < 0 {
				break
			}
			rest = rest[i+len(marker):]
			j := strings.IndexByte(rest, '"')
			if j < 0 {
				break
			}
			out = append(out, rest[:j])
		}
	}
	return out
}
