// Package sts is studiod's client for the token service.
//
// One call: Approve turns a person's decision into a grant garmd will
// accept. The shape is agentd's (agentd/internal/sts), because there is one
// way to authenticate to this service and a second implementation of it
// would be a second thing to get wrong.
//
// Two credentials travel, and they answer different questions. The
// Authorization bearer is the APPROVER — a person, with their own
// clearance, who may not be a delegated identity. The client assertion is
// studiod, the application asking on their behalf, proving it holds a
// registered private key. The assertion is in the BODY and the bearer is in
// the header, so there is no single field a caller could fill with the
// wrong credential and have the request still look well formed.
//
// This is why studiod exists as a server rather than a file host: a browser
// cannot hold a signing key, so it cannot be a registered client, and
// letting the token service accept unregistered callers would empty the
// registry that says which application is asking.
package sts

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

// ErrDenied is a refusal: the token service answered 4xx.
//
// One error for all of them because the service answers every refusal with
// one body, by design, so the endpoint cannot be used to enumerate what
// exists or who may reach it. Inventing distinctions on this side would be
// inventing information.
var ErrDenied = errors.New("sts: access_denied")

// ErrUnavailable is every non-2xx that is not a 4xx, and every transport
// failure. None of these are the service deciding anything, so a caller may
// retry rather than tell a person they were refused.
var ErrUnavailable = errors.New("sts: unavailable")

const (
	clientAssertionTypeJWT = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
	assertionTTL           = 2 * time.Minute
)

type Config struct {
	BaseURL       string
	ClientID      string
	Key           *ecdsa.PrivateKey
	TokenAudience string // what a client assertion's aud must be
	HTTP          *http.Client
	Now           func() time.Time
}

// Client is studiod's authenticated caller of the token service. It holds
// the private key that signs every client assertion, so that field is
// unexported and this type carries its own String and LogValue that redact
// it: a stray %+v or a slog line that carries a *Client around must never
// print the one number that lets something impersonate studiod.
type Client struct {
	baseURL  string
	clientID string
	key      *ecdsa.PrivateKey
	aud      string
	http     *http.Client
	now      func() time.Time
}

func New(cfg Config) (*Client, error) {
	if cfg.BaseURL == "" {
		return nil, errors.New("sts: BaseURL is required")
	}
	if cfg.ClientID == "" {
		return nil, errors.New("sts: ClientID is required")
	}
	if cfg.Key == nil {
		return nil, errors.New("sts: a private key is required; studiod authenticates with private_key_jwt")
	}
	if err := requireP256(cfg.Key); err != nil {
		return nil, err
	}
	aud := cfg.TokenAudience
	if aud == "" {
		// The token endpoint's own audience, which is what the service
		// checks a client assertion against. Defaulted here the way agentd
		// defaults --sts-token-audience, so a deployment that has not
		// changed it configures one flag instead of two.
		aud = strings.TrimSuffix(cfg.BaseURL, "/") + "/token"
	}
	hc := cfg.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 15 * time.Second}
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &Client{
		baseURL:  strings.TrimSuffix(cfg.BaseURL, "/"),
		clientID: cfg.ClientID,
		key:      cfg.Key,
		aud:      aud,
		http:     hc,
		now:      now,
	}, nil
}

// String redacts the private key. Value receiver, so that formatting a
// Client value and formatting a *Client both redact: a pointer-receiver
// String is only in the method set of *Client, and fmt would fall through
// to its default struct dump for the value.
func (c Client) String() string {
	return fmt.Sprintf("sts.Client{BaseURL:%q, ClientID:%q, TokenAudience:%q, Key:redacted}",
		c.baseURL, c.clientID, c.aud)
}

// LogValue redacts the private key from slog output, for the same reason.
func (c Client) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("base_url", c.baseURL),
		slog.String("client_id", c.clientID),
		slog.String("token_audience", c.aud),
		slog.String("key", "redacted"),
	)
}

// Grant is one approval, ready to travel to the tasks tool.
type Grant struct {
	Token     string
	ExpiresIn time.Duration
}

func (g Grant) String() string {
	return fmt.Sprintf("sts.Grant{Token:redacted, ExpiresIn:%s}", g.ExpiresIn)
}

// Approve mints the grant that records one person's decision about one
// call, bound to one task.
//
// `taskID` is what binds it: two tasks with the same material — the same
// payment asked twice — cannot share a grant. The service copies it into
// the claim and looks nothing up.
//
// Nothing here knows what a task is, what the material means, or which
// values matter. The four fields arrive from the page, which read them off
// the card the tasks tool served, and this call adds one thing to them: the
// proof that studiod is a registered client.
func (c *Client) Approve(ctx context.Context, approverToken, tool, subject, taskID string,
	material map[string]string) (Grant, error) {
	for name, v := range map[string]string{
		"approver token": approverToken, "tool": tool, "subject": subject, "task id": taskID,
	} {
		if v == "" {
			return Grant{}, fmt.Errorf("sts: %s is required", name)
		}
	}
	assertion, err := c.assertion()
	if err != nil {
		return Grant{}, err
	}
	if material == nil {
		// A nil map marshals to JSON null, not {}. The service's material
		// field is an object it iterates, and null is a different wire
		// shape for anything that unmarshals it without a null check.
		material = map[string]string{}
	}
	body, err := json.Marshal(map[string]any{
		"client_assertion_type": clientAssertionTypeJWT,
		"client_assertion":      assertion,
		"tool":                  tool,
		"subject":               subject,
		"task_id":               taskID,
		"material":              material,
	})
	if err != nil {
		return Grant{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/approve", strings.NewReader(string(body)))
	if err != nil {
		return Grant{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+approverToken)

	resp, err := c.http.Do(req)
	if err != nil {
		return Grant{}, fmt.Errorf("sts: calling /approve: %w: %w", err, ErrUnavailable)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Grant{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return Grant{}, statusError(resp.StatusCode)
	}
	var out struct {
		Grant     string `json:"grant"`
		ExpiresIn int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		// A static message: the body is the service's and is not repeated
		// into a log or an answer.
		return Grant{}, errors.New("sts: /approve did not answer with a valid grant response")
	}
	if out.Grant == "" {
		return Grant{}, errors.New("sts: /approve answered 200 with no grant")
	}
	return Grant{Token: out.Grant, ExpiresIn: time.Duration(out.ExpiresIn) * time.Second}, nil
}

// statusError separates a decision the service made from the service not
// working. A caller that filed a 503 as a refusal would tell a person they
// may not approve when the truth is "try again".
func statusError(status int) error {
	if status >= 400 && status < 500 {
		return fmt.Errorf("sts: /approve returned %d: %w", status, ErrDenied)
	}
	return fmt.Errorf("sts: /approve returned %d: %w", status, ErrUnavailable)
}

// assertion is the private_key_jwt this process signs to prove it is the
// registered client it claims to be (RFC 7523): short-lived, single-use by
// its `jti`, audience the token endpoint.
func (c *Client) assertion() (string, error) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", fmt.Errorf("sts: jti: %w", err)
	}
	now := c.now()
	payload, err := json.Marshal(map[string]any{
		"iss": c.clientID,
		"sub": c.clientID,
		"aud": c.aud,
		"iat": now.Unix(),
		"exp": now.Add(assertionTTL).Unix(),
		"jti": base64.RawURLEncoding.EncodeToString(nonce[:]),
	})
	if err != nil {
		return "", err
	}
	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: jose.ES256, Key: c.key},
		(&jose.SignerOptions{}).WithType("JWT"))
	if err != nil {
		return "", fmt.Errorf("sts: building the signer: %w", err)
	}
	obj, err := signer.Sign(payload)
	if err != nil {
		return "", fmt.Errorf("sts: signing the client assertion: %w", err)
	}
	return obj.CompactSerialize()
}

// requireP256 rejects any key whose curve is not P-256, naming the curve it
// found.
//
// go-jose signs with whatever curve the key carries, so a P-384 key would
// produce an ES384-shaped assertion the service was never told to expect,
// and that failure would show up opaquely inside the signer on the first
// real call rather than here, at construction, where the fix is obvious.
func requireP256(key *ecdsa.PrivateKey) error {
	if key.Curve != elliptic.P256() {
		return fmt.Errorf("sts: the client key uses curve %s; studiod signs ES256, which requires P-256",
			key.Curve.Params().Name)
	}
	return nil
}

// LoadECKey reads the client key: a PEM EC private key, in either the SEC1
// ("EC PRIVATE KEY") or PKCS#8 ("PRIVATE KEY") wrapper, because openssl
// emits the first and most tooling emits the second, and a startup that
// accepts only one produces a confusing failure.
func LoadECKey(path string) (*ecdsa.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("sts: reading the client key: %w", err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("sts: %s is not PEM", path)
	}
	if k, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		if err := requireP256(k); err != nil {
			return nil, fmt.Errorf("sts: %s: %w", path, err)
		}
		return k, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("sts: %s is not an EC private key: %w", path, err)
	}
	k, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("sts: %s is a %T, not an EC private key", path, parsed)
	}
	if err := requireP256(k); err != nil {
		return nil, fmt.Errorf("sts: %s: %w", path, err)
	}
	return k, nil
}
