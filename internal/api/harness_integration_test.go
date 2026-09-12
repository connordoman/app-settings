//go:build integration

package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	appsettings "github.com/connordoman/app-settings"
	"github.com/connordoman/app-settings/internal/api"
	"github.com/connordoman/app-settings/internal/apikey"
	"github.com/connordoman/app-settings/internal/cache"
	"github.com/connordoman/app-settings/internal/config"
	"github.com/connordoman/app-settings/internal/database"
	"github.com/connordoman/app-settings/internal/store"
)

// defaultTestDatabase matches the docker-compose stack started by `just up`.
const defaultTestDatabase = "postgres://settings:settings@localhost:5433/settings?sslmode=disable"

// harness is a running server backed by a throwaway database.
type harness struct {
	t      *testing.T
	server *httptest.Server
	store  *store.Store
	// adminKey has every scope and the highest role.
	adminKey string
	// bootstrapKey is the first-boot key, minted exactly as a real server does.
	bootstrapKey string
}

// newHarness creates a fresh database, migrates it, and serves the API.
func newHarness(t *testing.T) *harness {
	t.Helper()

	baseURL := os.Getenv("SETTINGS_TEST_DATABASE_URL")
	if baseURL == "" {
		baseURL = defaultTestDatabase
	}

	ctx := t.Context()
	name := fmt.Sprintf("settings_test_%d", rand.Uint32())
	testURL := createTestDatabase(t, ctx, baseURL, name)

	pool, err := database.Connect(ctx, testURL)
	if err != nil {
		t.Fatalf("connect to test database: %v", err)
	}
	t.Cleanup(pool.Close)

	if err := database.Migrate(ctx, pool, appsettings.Migrations(), nil); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	st := store.New(pool)
	cfg := config.Config{LastUsedThrottle: time.Hour}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	server := httptest.NewServer(api.NewServer(cfg, st, cache.NoOp{}, logger).Handler())
	t.Cleanup(server.Close)

	h := &harness{t: t, server: server, store: st}

	// Mint the bootstrap key before anything else, so the harness reflects the
	// state of a freshly provisioned server.
	token, err := st.EnsureBootstrapKey(ctx)
	if err != nil {
		t.Fatalf("EnsureBootstrapKey: %v", err)
	}
	if token == nil {
		t.Fatal("expected a bootstrap key on a fresh database")
	}
	h.bootstrapKey = token.String()

	h.adminKey = h.mintKey("test admin", []apikey.Scope{apikey.ScopeWildcard}, "admin", nil, nil)
	return h
}

// createTestDatabase makes a database for one test and drops it afterwards.
func createTestDatabase(t *testing.T, ctx context.Context, baseURL, name string) string {
	t.Helper()

	admin, err := pgx.Connect(ctx, baseURL)
	if err != nil {
		t.Skipf("no test database available (%v); start one with `just up`", err)
	}

	if _, err := admin.Exec(ctx, "create database "+name); err != nil {
		_ = admin.Close(ctx)
		t.Fatalf("create test database: %v", err)
	}
	_ = admin.Close(ctx)

	t.Cleanup(func() {
		// A new connection: the pool above is closed by the time this runs.
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		conn, err := pgx.Connect(cleanupCtx, baseURL)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close(cleanupCtx) }()
		_, _ = conn.Exec(cleanupCtx, "drop database if exists "+name+" with (force)")
	})

	parsed, err := url.Parse(baseURL)
	if err != nil {
		t.Fatalf("parse database url: %v", err)
	}
	parsed.Path = "/" + name
	return parsed.String()
}

// mintKey creates an API key directly, bypassing the HTTP layer so tests can
// set up whatever authority they need.
func (h *harness) mintKey(name string, scopes []apikey.Scope, role string, environments, platforms []string) string {
	h.t.Helper()

	token, err := apikey.Generate()
	if err != nil {
		h.t.Fatalf("generate key: %v", err)
	}
	if environments == nil {
		environments = []string{}
	}
	if platforms == nil {
		platforms = []string{}
	}

	_, err = h.store.CreateApiKey(h.t.Context(), database.CreateApiKeyParams{
		Name:         name,
		Prefix:       token.Prefix,
		SecretHash:   token.Hash(),
		Scopes:       apikey.Strings(scopes),
		Environments: environments,
		Platforms:    platforms,
		Role:         role,
		Actor:        "test",
	})
	if err != nil {
		h.t.Fatalf("create key %q: %v", name, err)
	}
	return token.String()
}

// response is a decoded API reply.
type response struct {
	status int
	body   []byte
}

// decode unmarshals the body, failing the test if it does not fit.
func (r response) decode(t *testing.T, into any) {
	t.Helper()
	if err := json.Unmarshal(r.body, into); err != nil {
		t.Fatalf("decode response %s: %v", r.body, err)
	}
}

// errorMessage extracts the message from an error body.
func (r response) errorMessage(t *testing.T) string {
	t.Helper()
	var body struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	r.decode(t, &body)
	return body.Error.Message
}

// do sends a request with the given key.
func (h *harness) do(key, method, path string, body any) response {
	h.t.Helper()

	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			h.t.Fatalf("encode body: %v", err)
		}
		payload = strings.NewReader(string(encoded))
	}

	request, err := http.NewRequestWithContext(h.t.Context(), method, h.server.URL+path, payload)
	if err != nil {
		h.t.Fatalf("build request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Content-Type", "application/json")

	result, err := h.server.Client().Do(request)
	if err != nil {
		h.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = result.Body.Close() }()

	raw, err := io.ReadAll(result.Body)
	if err != nil {
		h.t.Fatalf("read body: %v", err)
	}
	return response{status: result.StatusCode, body: raw}
}

// admin sends a request as the all-powerful test key.
func (h *harness) admin(method, path string, body any) response {
	h.t.Helper()
	return h.do(h.adminKey, method, path, body)
}

// mustAdmin sends an admin request and asserts the status.
func (h *harness) mustAdmin(method, path string, body any, wantStatus int) response {
	h.t.Helper()
	result := h.admin(method, path, body)
	if result.status != wantStatus {
		h.t.Fatalf("%s %s = %d, want %d: %s", method, path, result.status, wantStatus, result.body)
	}
	return result
}

// createSetting defines a setting and returns its id.
func (h *harness) createSetting(body map[string]any) string {
	h.t.Helper()

	result := h.mustAdmin(http.MethodPost, "/api/v1/settings", body, http.StatusCreated)
	var created struct {
		ID string `json:"id"`
	}
	result.decode(h.t, &created)
	return created.ID
}

// resolved is one setting from a resolution response.
type resolved struct {
	Name   string          `json:"name"`
	Value  json.RawMessage `json:"value"`
	Source string          `json:"source"`
	Role   string          `json:"role"`

	Override *struct {
		GroupID       string          `json:"group_id"`
		Enforced      bool            `json:"enforced"`
		Visible       bool            `json:"visible"`
		ReplacedValue json.RawMessage `json:"replaced_value"`
	} `json:"override"`
}

// resolveUser fetches effective settings, keyed by setting name.
func (h *harness) resolveUser(key, userID, query string) map[string]resolved {
	h.t.Helper()

	path := "/api/v1/resolve/user/" + userID + "?" + query
	result := h.do(key, http.MethodGet, path, nil)
	if result.status != http.StatusOK {
		h.t.Fatalf("resolve %s = %d: %s", path, result.status, result.body)
	}

	var body struct {
		Settings []resolved `json:"settings"`
	}
	result.decode(h.t, &body)

	byName := make(map[string]resolved, len(body.Settings))
	for _, setting := range body.Settings {
		byName[setting.Name] = setting
	}
	return byName
}
