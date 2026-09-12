// Package config loads server settings from the environment. App Settings is
// meant to be self-hosted, so everything is configurable without a config file
// and every option has a working default.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the resolved server configuration.
type Config struct {
	// DatabaseURL is the PostgreSQL connection string. Required.
	DatabaseURL string
	// RedisURL enables the optional resolution cache when set.
	RedisURL string
	// CacheTTL bounds how long a cached resolution is served.
	CacheTTL time.Duration

	ListenAddr   string
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
	// ShutdownGrace is how long in-flight requests get to finish.
	ShutdownGrace time.Duration

	// AutoMigrate applies embedded migrations at boot.
	AutoMigrate bool
	// TrustedProxies are the CIDRs Gin will believe X-Forwarded-For from.
	// Empty means trust none, which is the safe default for a public server.
	TrustedProxies []string

	// LastUsedThrottle is the minimum gap between last_used_at writes per key.
	LastUsedThrottle time.Duration

	Debug bool
}

// Load reads configuration from the environment.
func Load() (Config, error) {
	cfg := Config{
		DatabaseURL:      databaseURL(),
		RedisURL:         env("SETTINGS_REDIS_URL", ""),
		ListenAddr:       env("SETTINGS_LISTEN_ADDR", ":8080"),
		TrustedProxies:   splitList(env("SETTINGS_TRUSTED_PROXIES", "")),
		AutoMigrate:      envBool("SETTINGS_AUTO_MIGRATE", true),
		Debug:            envBool("SETTINGS_DEBUG", false),
		CacheTTL:         envDuration("SETTINGS_CACHE_TTL", 60*time.Second),
		ReadTimeout:      envDuration("SETTINGS_READ_TIMEOUT", 15*time.Second),
		WriteTimeout:     envDuration("SETTINGS_WRITE_TIMEOUT", 30*time.Second),
		ShutdownGrace:    envDuration("SETTINGS_SHUTDOWN_GRACE", 20*time.Second),
		LastUsedThrottle: envDuration("SETTINGS_LAST_USED_THROTTLE", 5*time.Minute),
	}

	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("SETTINGS_DATABASE_URL is required (or set the standard PG* variables)")
	}
	return cfg, nil
}

// CacheEnabled reports whether a Redis instance was configured.
func (c Config) CacheEnabled() bool { return c.RedisURL != "" }

// databaseURL prefers an explicit URL and otherwise falls back to libpq's
// standard variables, so the usual psql environment just works.
func databaseURL() string {
	if url := env("SETTINGS_DATABASE_URL", env("DATABASE_URL", "")); url != "" {
		return url
	}
	if os.Getenv("PGHOST") == "" && os.Getenv("PGDATABASE") == "" {
		return ""
	}
	// An empty connection string makes pgx read PG* itself.
	return " "
}

func env(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok && value != "" {
		return value
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	raw, ok := os.LookupEnv(key)
	if !ok || raw == "" {
		return fallback
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return fallback
	}
	return value
}

func envDuration(key string, fallback time.Duration) time.Duration {
	raw, ok := os.LookupEnv(key)
	if !ok || raw == "" {
		return fallback
	}
	value, err := time.ParseDuration(raw)
	if err != nil {
		return fallback
	}
	return value
}

func splitList(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
