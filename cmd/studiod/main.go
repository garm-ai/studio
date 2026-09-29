// Command studiod serves Studio.
//
// It is flag parsing and a call to studio.Serve. Everything it does is in
// that package, so a development harness that runs several components in
// one process starts the same server this binary starts, and a bank that
// serves the bundle from its own web tier and proxies to garmd itself needs
// neither.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"

	"github.com/garm-ai/studio"
)

func main() {
	if err := run(os.Args[1:], os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "studiod:", err)
		os.Exit(1)
	}
}

func run(args []string, errOut *os.File) error {
	fs := flag.NewFlagSet("studiod", flag.ContinueOnError)
	fs.SetOutput(errOut)
	var (
		listen    = fs.String("listen", envOr("STUDIOD_LISTEN", studio.DefaultListen), "address to serve on")
		garmd     = fs.String("garmd", os.Getenv("STUDIOD_GARMD"), "base URL of the garm daemon every governed call is forwarded to")
		devIdP    = fs.String("dev-idp-url", os.Getenv("STUDIOD_DEV_IDP_URL"), "DEV ONLY: base URL of the devkit identity provider; GET /idp/personas and GET /idp/token are forwarded there and nothing else is")
		stsURL    = fs.String("sts-url", os.Getenv("STUDIOD_STS_URL"), "base URL of the token service an approval is signed at")
		stsClient = fs.String("sts-client-id", os.Getenv("STUDIOD_STS_CLIENT_ID"), "the client id studiod is registered at the token service under")
		stsKey    = fs.String("sts-client-key-file", os.Getenv("STUDIOD_STS_CLIENT_KEY_FILE"), "PEM file holding studiod's P-256 private key; it signs the client assertion and is never sent")
		stsAud    = fs.String("sts-token-audience", os.Getenv("STUDIOD_STS_TOKEN_AUDIENCE"), "what a client assertion's aud must name (default: --sts-url + /token)")
		showVer   = fs.Bool("version", false, "print the version this binary was built at")
		verbosity = fs.String("log-level", envOr("STUDIOD_LOG_LEVEL", "info"), "debug, info, warn or error")
	)
	fs.Usage = func() {
		fmt.Fprintf(errOut, "studiod serves Studio: the bundle, a reverse proxy in front of garmd, and\n"+
			"POST %s, where a person's approval is signed.\n\n"+
			"Usage:\n  studiod --garmd http://garmd:7440 [--listen %s]\n"+
			"          [--sts-url URL --sts-client-id ID --sts-client-key-file PEM]\n"+
			"          [--dev-idp-url URL]\n\nFlags:\n", studio.ApprovePath, studio.DefaultListen)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if *showVer {
		fmt.Println(version())
		return nil
	}

	var level slog.Level
	if err := level.UnmarshalText([]byte(*verbosity)); err != nil {
		return fmt.Errorf("--log-level %q: want debug, info, warn or error", *verbosity)
	}
	log := slog.New(slog.NewTextHandler(errOut, &slog.HandlerOptions{Level: level}))

	// SIGTERM and SIGINT cancel the context; Serve then closes the listener
	// and gives what is in flight a deadline to finish.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	return studio.Serve(ctx, studio.Config{
		Listen:           *listen,
		GarmdURL:         *garmd,
		DevIdPURL:        *devIdP,
		STSURL:           *stsURL,
		STSClientID:      *stsClient,
		STSClientKeyFile: *stsKey,
		STSTokenAudience: *stsAud,
		Log:              log,
	})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// version is the module version the toolchain stamped, not a literal.
func version() string {
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" {
		return info.Main.Version
	}
	return "(devel)"
}
