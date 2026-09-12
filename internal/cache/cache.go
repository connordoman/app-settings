// Package cache holds the optional Redis layer in front of setting
// resolution. Redis is genuinely optional: when it is not configured the
// server uses a no-op cache and behaves identically, just with more database
// reads.
package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Cache stores resolved settings payloads.
//
// Every method is best-effort. A cache failure must never fail a request, so
// implementations swallow errors and report a miss instead.
type Cache interface {
	// Get returns a cached payload, or ok=false on a miss.
	Get(ctx context.Context, key Key) (payload []byte, ok bool)
	// Put stores a payload and records it against its environment.
	Put(ctx context.Context, key Key, payload []byte)
	// InvalidateEnvironment drops every entry for an environment. Called after
	// any write that could change what a resolution returns.
	InvalidateEnvironment(ctx context.Context, environment string)
	// Ping reports whether the cache is reachable, for readiness checks.
	Ping(ctx context.Context) error
	// Close releases resources.
	Close() error
	// Enabled reports whether this is a real cache.
	Enabled() bool
}

// Key identifies one resolution. Every input that can change the result must
// appear here, or a caller could be served another caller's answer.
type Key struct {
	Environment string
	Platforms   []string
	UserID      string
	MaxRank     int32
	AdHocGroups []string
}

// String renders the key's identity. It is hashed rather than used directly so
// that a long group list cannot produce an unbounded Redis key.
func (k Key) String() string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "v1|env=%s|rank=%d|user=%s|platforms=%s|groups=%s",
		k.Environment, k.MaxRank, k.UserID,
		strings.Join(k.Platforms, ","), strings.Join(k.AdHocGroups, ","))

	sum := sha256.Sum256([]byte(builder.String()))
	return "settings:resolve:" + k.Environment + ":" + hex.EncodeToString(sum[:16])
}

// indexKey names the set tracking which entries belong to an environment.
func indexKey(environment string) string {
	return "settings:index:" + environment
}

// New returns a Redis-backed cache, or a no-op cache when url is empty.
func New(ctx context.Context, url string, ttl time.Duration) (Cache, error) {
	if url == "" {
		return NoOp{}, nil
	}

	options, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}

	client := redis.NewClient(options)
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("redis is not reachable: %w", err)
	}

	return &redisCache{client: client, ttl: ttl}, nil
}

type redisCache struct {
	client *redis.Client
	ttl    time.Duration
}

func (c *redisCache) Enabled() bool { return true }

func (c *redisCache) Get(ctx context.Context, key Key) ([]byte, bool) {
	payload, err := c.client.Get(ctx, key.String()).Bytes()
	if err != nil {
		// redis.Nil is an ordinary miss; anything else is a cache problem the
		// request should not care about.
		return nil, false
	}
	return payload, true
}

func (c *redisCache) Put(ctx context.Context, key Key, payload []byte) {
	name := key.String()
	pipe := c.client.TxPipeline()
	pipe.Set(ctx, name, payload, c.ttl)
	pipe.SAdd(ctx, indexKey(key.Environment), name)
	// The index outlives its entries so invalidation can still find them; give
	// it a generous ceiling so an abandoned environment cannot leak forever.
	pipe.Expire(ctx, indexKey(key.Environment), maxDuration(c.ttl*10, time.Hour))
	_, _ = pipe.Exec(ctx)
}

func (c *redisCache) InvalidateEnvironment(ctx context.Context, environment string) {
	index := indexKey(environment)
	members, err := c.client.SMembers(ctx, index).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return
	}
	if len(members) > 0 {
		// Unlink reclaims memory on a background thread.
		_ = c.client.Unlink(ctx, members...).Err()
	}
	_ = c.client.Unlink(ctx, index).Err()
}

func (c *redisCache) Ping(ctx context.Context) error { return c.client.Ping(ctx).Err() }

func (c *redisCache) Close() error { return c.client.Close() }

// NoOp is the cache used when Redis is not configured.
type NoOp struct{}

func (NoOp) Enabled() bool                                 { return false }
func (NoOp) Get(context.Context, Key) ([]byte, bool)       { return nil, false }
func (NoOp) Put(context.Context, Key, []byte)              {}
func (NoOp) InvalidateEnvironment(context.Context, string) {}
func (NoOp) Ping(context.Context) error                    { return nil }
func (NoOp) Close() error                                  { return nil }

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}
