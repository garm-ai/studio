// Package studio serves Studio: the built single-page application and a
// reverse proxy in front of garmd.
//
// It holds no business logic and knows nothing about cards. Studio is a
// client of garmd's door — every card, every listing and every decision is
// a governed call the browser makes with the person's own bearer — and this
// package exists so the browser sees one origin: the bundle and the API
// come from the same place, which is why garmd needs no CORS and Studio
// needs no second origin to trust.
//
// Serve is the importable entry point. `cmd/studiod` is flag parsing and a
// call to it, and a development harness that runs several components in one
// process calls it the same way.
package studio

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/garm-ai/studio/internal/sts"
	"github.com/garm-ai/studio/internal/ui"
)

// DefaultListen is where studiod listens when nothing says otherwise.
const DefaultListen = "127.0.0.1:7480"

// drainTimeout is how long in-flight requests get once the context ends.
// The listener closes at once; a request is seconds, and a proxied call
// that has already reached garmd should be allowed to come back rather than
// be cut off with its ledger row already written.
const drainTimeout = 15 * time.Second

// Config is everything Serve needs. Nothing here is read from the
// environment or from a flag: the caller decides, so that a test and a
// development harness can start the same server the binary starts.
type Config struct {
	// Listen is the TCP address to serve on. Empty means DefaultListen.
	Listen string

	// GarmdURL is the base URL of the garm daemon every governed call is
	// forwarded to, such as "http://garmd:7440". Required.
	GarmdURL string

	// DevIdPURL is the base URL of the devkit identity provider. When it is
	// set, GET /idp/personas and GET /idp/token are forwarded there and
	// nothing else is. DEVELOPMENT ONLY: that provider mints any identity
	// it is asked for. Empty disables the two routes.
	DevIdPURL string

	// The token service studiod signs an approval at, and the registered
	// client it signs as. All three together, or none: with none, the
	// approve route says so and the rest of Studio works, which is what a
	// person working on the renderer wants.
	//
	// STSClientKey is for a caller that already holds the key — a test, or
	// a harness running several components in one process. It wins over
	// STSClientKeyFile, which is the path a deployment gives.
	STSURL           string
	STSClientID      string
	STSClientKeyFile string
	STSClientKey     *ecdsa.PrivateKey

	// STSTokenAudience is what a client assertion's `aud` must name. Empty
	// means the token endpoint of STSURL, which is what a deployment that
	// has not changed it wants.
	STSTokenAudience string

	// Assets is the built bundle to serve. Nil means the one embedded in
	// this binary, and a binary with no bundle then refuses to start.
	Assets fs.FS

	// Log receives the startup lines and the drain warning. Nil discards
	// them.
	Log *slog.Logger

	// OnListen, when set, is called with the bound address once the
	// listener is open. A caller that asked for port 0 learns which port it
	// got; a test uses it to know when to start fetching.
	OnListen func(addr string)
}

// ConfigError is a refusal an operator can fix from a command line.
type ConfigError struct {
	Flag   string
	Value  string
	Reason string
}

func (e *ConfigError) Error() string {
	return fmt.Sprintf("%s %q: %s", e.Flag, e.Value, e.Reason)
}

// Serve runs Studio until ctx is cancelled, then drains and returns.
//
// Everything that can be refused is refused before the listener opens: a
// missing garmd URL, a malformed one, a binary with no bundle. After that
// the only way out is the context, a listener that could not be opened, or
// a server that stopped for a reason that is not shutdown.
func Serve(ctx context.Context, cfg Config) error {
	log := cfg.Log
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}

	if cfg.GarmdURL == "" {
		return &ConfigError{Flag: "--garmd", Value: "", Reason: "Studio calls garmd for everything; there is nothing to serve without it"}
	}
	api, err := garmdProxy(cfg.GarmdURL)
	if err != nil {
		return err
	}

	var devIdP http.Handler
	if cfg.DevIdPURL != "" {
		if devIdP, err = devIdPProxy(cfg.DevIdPURL); err != nil {
			return err
		}
	}

	// The token service, if there is one. Configured in full or not at all:
	// two of the three is a deployment that meant to sign approvals and
	// will find out at the first click, which is the wrong moment.
	var signer *sts.Client
	switch n := countSet(cfg.STSURL, cfg.STSClientID, cfg.STSClientKeyFile) +
		boolToInt(cfg.STSClientKey != nil && cfg.STSClientKeyFile == ""); {
	case n == 0:
	case n < 3:
		return &ConfigError{Flag: "--sts-url, --sts-client-id and --sts-client-key-file", Value: cfg.STSURL,
			Reason: "configure all three or none; studiod signs an approval as a registered client"}
	default:
		if _, err := parseBaseURL("--sts-url", cfg.STSURL); err != nil {
			return err
		}
		key := cfg.STSClientKey
		if key == nil {
			if key, err = sts.LoadECKey(cfg.STSClientKeyFile); err != nil {
				return err
			}
		}
		if signer, err = sts.New(sts.Config{
			BaseURL:       cfg.STSURL,
			ClientID:      cfg.STSClientID,
			Key:           key,
			TokenAudience: cfg.STSTokenAudience,
		}); err != nil {
			return err
		}
	}

	assets := cfg.Assets
	if assets == nil {
		if assets, err = ui.Assets(); err != nil {
			return err
		}
	}

	listen := cfg.Listen
	if listen == "" {
		listen = DefaultListen
	}
	listener, err := net.Listen("tcp", listen)
	if err != nil {
		return fmt.Errorf("listening on %s: %w", listen, err)
	}

	log.Info("studio is serving",
		"listen", listener.Addr().String(),
		"garmd", redactURL(cfg.GarmdURL))
	if signer != nil {
		// The client id, never the key: sts.Client redacts it in both
		// String and LogValue, and this line names only what identifies
		// this process to the token service.
		log.Info("approvals are signed at the token service",
			"sts", redactURL(cfg.STSURL), "client_id", cfg.STSClientID)
	} else {
		log.Warn("no token service is configured; " + ApprovePath + " will refuse and no approval can be signed")
	}
	if cfg.DevIdPURL != "" {
		// Loud on purpose. This forwards to a provider that mints any
		// identity it is asked for, and a deployment that turned it on by
		// accident should find it in the first screen of its logs.
		log.Warn("DEVELOPMENT identity provider is proxied at /idp/personas and /idp/token; it mints any identity asked of it and must not be reachable in a real deployment",
			"dev_idp", redactURL(cfg.DevIdPURL))
	}

	srv := &http.Server{
		Handler:           mount(api, bundleHandler(assets), approveHandler(signer, log), devIdP),
		ReadHeaderTimeout: 10 * time.Second,
	}

	drained := make(chan struct{})
	go func() {
		defer close(drained)
		<-ctx.Done()
		// The context is stripped of cancellation because ctx is ALREADY
		// done — that is what started the shutdown — and honouring it would
		// cut off the requests this deadline exists to let finish.
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), drainTimeout)
		defer cancel()
		if err := srv.Shutdown(sctx); err != nil {
			log.Warn("studio did not drain within the deadline", "err", err)
		}
	}()

	if cfg.OnListen != nil {
		cfg.OnListen(listener.Addr().String())
	}

	err = srv.Serve(listener)
	// ErrServerClosed says Shutdown was CALLED, not that it returned:
	// waiting for the drain is what makes "Serve returned" mean "nothing is
	// in flight".
	if errors.Is(err, http.ErrServerClosed) {
		<-drained
		return nil
	}
	return err
}

// redactURL is how a base URL reaches the log: with its password replaced.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return "<unparseable url>"
	}
	return u.Redacted()
}

// countSet is how "all three or none" is checked without three nested ifs.
func countSet(vs ...string) int {
	n := 0
	for _, v := range vs {
		if v != "" {
			n++
		}
	}
	return n
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
