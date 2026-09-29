package studio

import (
	"io/fs"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// mount is the one place that decides where a request goes.
//
// Three destinations and no fourth. A garm method path goes to garmd,
// unchanged, with the browser's bearer on it — that is the whole reason
// this binary exists, because a browser talking to garmd across origins
// would need CORS there and Studio would need a second origin to trust. The
// two dev login routes go to the devkit identity provider when one is
// configured. Everything else is the bundle.
func mount(api, bundle, devIdP http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case devIdP != nil && strings.HasPrefix(r.URL.Path, "/idp/"):
			devIdP.ServeHTTP(w, r)
		case IsAPIPath(r.URL.Path):
			api.ServeHTTP(w, r)
		default:
			bundle.ServeHTTP(w, r)
		}
	})
}

// IsAPIPath says whether a path is a garm method call.
//
// Every call Studio makes is `/<proto package>.<Service>/<Method>`: two
// segments, the first carrying the package's dots. That shape is what the
// daemon routes on, so this proxy needs no list of packages and no
// configuration — a catalogue that gains a service is reachable the day it
// is published, and nothing here has to be told.
//
// A bundle path never looks like that: `/index.html` is one segment and
// `/assets/index-a1b2c3.js` is two with no dot in the first.
func IsAPIPath(p string) bool {
	seg := strings.Split(strings.TrimPrefix(p, "/"), "/")
	if len(seg) != 2 || seg[0] == "" || seg[1] == "" {
		return false
	}
	return strings.Contains(seg[0], ".")
}

// garmdProxy forwards a governed call to garmd, as sent.
//
// The bearer travels: it is the person's own token and garmd's first step is
// to fold it. Nothing here reads it, rewrites it or stores it. The response
// travels back whole, headers included — `Garm-Event-Id` names the ledger
// row the call produced and is the id a result card is fetched by, so a
// proxy that dropped it would cost Studio the run it just started.
//
// The upstream Host is garmd's own, not the browser's: a proxy that
// forwarded the browser's Host teaches a habit that breaks the first time
// there is a virtual host on the other side.
func garmdProxy(raw string) (http.Handler, error) {
	target, err := parseBaseURL("--garmd", raw)
	if err != nil {
		return nil, err
	}
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.URL.Path = singleJoin(target.Path, pr.In.URL.Path)
			pr.Out.URL.RawPath = ""
			pr.Out.Host = target.Host
			pr.SetXForwarded()
		},
	}, nil
}

// devIdPProxy forwards Studio's two login calls to the devkit IdP.
//
// DEV ONLY. The devkit IdP mints any identity asked of it and sends no CORS
// headers, on purpose, so a browser holding Studio on this origin cannot
// call it. This lends the origin to exactly two GETs — /personas and /token
// — and nothing else: not the JWKS, not a POST, not a path that merely
// starts the same way. Everything under /idp/ that is not one of the two is
// a 404, and a method that is not GET is a 405, so nothing else of the
// provider becomes reachable by being behind this.
func devIdPProxy(raw string) (http.Handler, error) {
	target, err := parseBaseURL("--dev-idp-url", raw)
	if err != nil {
		return nil, err
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.URL.Path = singleJoin(target.Path, strings.TrimPrefix(pr.In.URL.Path, "/idp"))
			pr.Out.URL.RawPath = ""
			pr.Out.Host = target.Host
			// Studio's bearer, if the browser sent one, is garmd's business
			// and not the IdP's.
			pr.Out.Header.Del("Authorization")
			pr.Out.Header.Del("Cookie")
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/idp/personas", "/idp/token":
		default:
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		proxy.ServeHTTP(w, r)
	}), nil
}

// bundleHandler serves the built assets with a single-page fallback.
//
// A path that names no file falls back to index.html rather than 404ing,
// because Studio routes client-side: a person who reloads on
// #/tasks/tsk_1 must get the application, not a not-found.
//
// A DIRECTORY falls back too, rather than being listed: a listing hands
// anybody who asks a map of the application's files and is never what a
// client wanted.
func bundleHandler(assets fs.FS) http.Handler {
	files := http.FileServerFS(assets)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		// fs.Stat refuses a path that escapes the tree (fs.ValidPath), so
		// "../../etc/passwd" falls back to index.html rather than being
		// looked up; http.FileServerFS would refuse it too, and this is the
		// belt to that brace.
		if info, err := fs.Stat(assets, p); err != nil || info.IsDir() {
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		}
		files.ServeHTTP(w, r)
	})
}

// parseBaseURL accepts an absolute http(s) base URL and nothing else. A
// typo here is a browser that cannot reach the daemon, which is worth
// refusing at startup rather than discovering one request at a time.
func parseBaseURL(flag, raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, &ConfigError{Flag: flag, Value: raw, Reason: err.Error()}
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, &ConfigError{Flag: flag, Value: raw,
			Reason: "want an absolute http(s) URL such as http://127.0.0.1:7440"}
	}
	if u.Host == "" {
		return nil, &ConfigError{Flag: flag, Value: raw, Reason: "no host"}
	}
	return u, nil
}

func singleJoin(base, rest string) string {
	base = strings.TrimSuffix(base, "/")
	if rest == "" {
		return base
	}
	if !strings.HasPrefix(rest, "/") {
		rest = "/" + rest
	}
	return base + rest
}
