// Command settings-app runs the Settings App API server.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	settingsapp "github.com/connordoman/settings-app"
	"github.com/connordoman/settings-app/internal/api"
	"github.com/connordoman/settings-app/internal/apikey"
	"github.com/connordoman/settings-app/internal/cache"
	"github.com/connordoman/settings-app/internal/config"
	"github.com/connordoman/settings-app/internal/database"
	"github.com/connordoman/settings-app/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "settings-app: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	logger := newLogger(cfg.Debug)

	// Shut down cleanly on the signals a supervisor or container runtime sends.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := database.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	logger.Info("connected to postgres")

	if cfg.AutoMigrate {
		err := database.Migrate(ctx, pool, settingsapp.Migrations(), func(version int32, name string) {
			logger.Info("applying migration", "version", version, "name", name)
		})
		if err != nil {
			return err
		}
	}
	if version, err := database.SchemaVersion(ctx, pool); err == nil {
		logger.Info("schema ready", "version", version)
	}

	st := store.New(pool)

	token, err := st.EnsureBootstrapKey(ctx)
	if err != nil {
		return err
	}
	if token != nil {
		announceBootstrapKey(*token)
	}

	resolutionCache, err := cache.New(ctx, cfg.RedisURL, cfg.CacheTTL)
	if err != nil {
		return err
	}
	defer func() { _ = resolutionCache.Close() }()
	if resolutionCache.Enabled() {
		logger.Info("resolution cache enabled", "ttl", cfg.CacheTTL)
	} else {
		logger.Info("running without a cache", "hint", "set SETTINGS_REDIS_URL to enable one")
	}

	server := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           api.NewServer(cfg, st, resolutionCache, logger).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       cfg.ReadTimeout,
		WriteTimeout:      cfg.WriteTimeout,
	}

	listenErrors := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", cfg.ListenAddr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			listenErrors <- err
		}
	}()

	select {
	case err := <-listenErrors:
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
		logger.Info("shutting down", "grace", cfg.ShutdownGrace)
	}

	// Give in-flight requests a chance to finish before dropping connections.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownGrace)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}

	logger.Info("stopped")
	return nil
}

func newLogger(debug bool) *slog.Logger {
	level := slog.LevelInfo
	if debug {
		level = slog.LevelDebug
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
}

// announceBootstrapKey prints the first-boot key to stdout. It goes to the
// terminal rather than the structured log on purpose: it must not end up in a
// log aggregator, and the operator needs to copy it exactly once.
func announceBootstrapKey(token apikey.Token) {
	rule := strings.Repeat("═", 74)

	fmt.Printf(`
%s
  BOOTSTRAP API KEY — shown once, never recoverable
%s

  %s

  This key can only manage other API keys (%s).
  Use it with the CLI to mint the keys your services will actually use:

      export SETTINGS_API_KEY=%s
      settingsctl keys create --name "web backend" --scope resolve --env production

  Store it in a password manager, or discard it once you have minted a key
  with the %s scope: any such key can mint the rest.
%s

`, rule, rule, token.String(), apikey.JoinScopes(apikey.BootstrapScopes),
		token.String(), apikey.ScopeKeysWrite, rule)
}
