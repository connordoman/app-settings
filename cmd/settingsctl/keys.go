package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/connordoman/settings-app/internal/apikey"
)

// runKeys dispatches the `keys` subcommands.
func runKeys(ctx context.Context, c *client, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("keys needs a subcommand: create, list or revoke")
	}

	switch args[0] {
	case "create":
		return runKeysCreate(ctx, c, args[1:])
	case "list":
		return runKeysList(ctx, c, args[1:])
	case "revoke":
		return runKeysRevoke(ctx, c, args[1:])
	default:
		return fmt.Errorf("unknown keys subcommand %q: expected create, list or revoke", args[0])
	}
}

// repeatedFlag collects a flag given more than once.
type repeatedFlag []string

func (r *repeatedFlag) String() string { return strings.Join(*r, ",") }

func (r *repeatedFlag) Set(value string) error {
	// Accept both `--scope a --scope b` and `--scope a,b`.
	for _, part := range strings.Split(value, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			*r = append(*r, trimmed)
		}
	}
	return nil
}

func runKeysCreate(ctx context.Context, c *client, args []string) error {
	flags := flag.NewFlagSet("keys create", flag.ContinueOnError)

	var scopes, environments, platforms repeatedFlag
	name := flags.String("name", "", "human-readable name for the key (required)")
	flags.Var(&scopes, "scope", "scope to grant; repeatable, or comma-separated. Use '*' for all")
	flags.Var(&environments, "env", "restrict the key to an environment; repeatable. Default: all")
	flags.Var(&platforms, "platform", "restrict the key to a platform; repeatable. Default: all")
	role := flags.String("role", "", "role ceiling for the key (default: the server's lowest role)")
	expiresIn := flags.String("expires-in", "", "lifetime such as 720h; omit for a key that never expires")
	asJSON := flags.Bool("json", false, "print the raw JSON response")

	flags.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: settingsctl keys create --name NAME --scope SCOPE [flags]\n\n")
		flags.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\nAvailable scopes:\n  %s\n", apikey.JoinScopes(apikey.AllScopes))
		fmt.Fprintf(os.Stderr, "\nExample:\n"+
			"  settingsctl keys create --name \"web backend\" \\\n"+
			"      --scope resolve --scope values:write --env production --platform web\n")
	}
	if err := flags.Parse(args); err != nil {
		return err
	}

	if *name == "" {
		flags.Usage()
		return fmt.Errorf("--name is required")
	}
	if len(scopes) == 0 {
		flags.Usage()
		return fmt.Errorf("at least one --scope is required")
	}
	// Fail on an unknown scope here rather than after a round trip.
	if _, err := apikey.ParseScopes(scopes); err != nil {
		return err
	}

	request := map[string]any{
		"name":         *name,
		"scopes":       []string(scopes),
		"environments": orEmptyList(environments),
		"platforms":    orEmptyList(platforms),
	}
	if *role != "" {
		request["role"] = *role
	}
	if *expiresIn != "" {
		if _, err := time.ParseDuration(*expiresIn); err != nil {
			return fmt.Errorf("--expires-in must be a duration such as 720h: %w", err)
		}
		request["expires_in"] = *expiresIn
	}

	var created struct {
		Key     keySummary `json:"key"`
		Token   string     `json:"token"`
		Warning string     `json:"warning"`
	}
	if err := c.do(ctx, "POST", "/api/v1/keys", request, &created); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(created)
	}

	// The token goes to stdout on its own line so it can be piped straight
	// into a secret store; everything else goes to stderr.
	fmt.Fprintf(os.Stderr, "Created key %q (%s)\n", created.Key.Name, created.Key.ID)
	fmt.Fprintf(os.Stderr, "  scopes:       %s\n", strings.Join(created.Key.Scopes, ", "))
	fmt.Fprintf(os.Stderr, "  environments: %s\n", orAll(created.Key.Environments))
	fmt.Fprintf(os.Stderr, "  platforms:    %s\n", orAll(created.Key.Platforms))
	fmt.Fprintf(os.Stderr, "  role:         %s\n", created.Key.Role)
	if created.Key.ExpiresAt != nil {
		fmt.Fprintf(os.Stderr, "  expires:      %s\n", created.Key.ExpiresAt.Format(time.RFC3339))
	}
	fmt.Fprintf(os.Stderr, "\n%s\n\n", created.Warning)

	fmt.Println(created.Token)
	return nil
}

// orEmptyList encodes an unset filter as [] rather than null, so the server
// reads it as "no restriction" instead of a missing value.
func orEmptyList(values repeatedFlag) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// keySummary is the key metadata the server returns. It never includes a secret.
type keySummary struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	Prefix       string     `json:"prefix"`
	Scopes       []string   `json:"scopes"`
	Environments []string   `json:"environments"`
	Platforms    []string   `json:"platforms"`
	Role         string     `json:"role"`
	IsBootstrap  bool       `json:"is_bootstrap"`
	ExpiresAt    *time.Time `json:"expires_at"`
	RevokedAt    *time.Time `json:"revoked_at"`
	LastUsedAt   *time.Time `json:"last_used_at"`
	CreatedAt    time.Time  `json:"created_at"`
}

func runKeysList(ctx context.Context, c *client, args []string) error {
	flags := flag.NewFlagSet("keys list", flag.ContinueOnError)
	includeRevoked := flags.Bool("include-revoked", false, "also list revoked keys")
	asJSON := flags.Bool("json", false, "print the raw JSON response")
	if err := flags.Parse(args); err != nil {
		return err
	}

	path := "/api/v1/keys"
	if *includeRevoked {
		path += "?include_revoked=true"
	}

	var listing struct {
		Keys []keySummary `json:"keys"`
	}
	if err := c.do(ctx, "GET", path, nil, &listing); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(listing)
	}
	if len(listing.Keys) == 0 {
		fmt.Println("No keys.")
		return nil
	}

	writer := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(writer, "ID\tNAME\tKEY\tROLE\tSCOPES\tENVIRONMENTS\tSTATUS\tLAST USED")
	for _, key := range listing.Keys {
		fmt.Fprintf(writer, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			key.ID, key.Name, apikey.Display(key.Prefix), key.Role,
			strings.Join(key.Scopes, " "), orAll(key.Environments),
			keyStatus(key), humanTime(key.LastUsedAt))
	}
	return writer.Flush()
}

func runKeysRevoke(ctx context.Context, c *client, args []string) error {
	flags := flag.NewFlagSet("keys revoke", flag.ContinueOnError)
	flags.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: settingsctl keys revoke <key-id>\n\n"+
			"Revocation is permanent and takes effect immediately.\n")
	}
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		flags.Usage()
		return fmt.Errorf("expected exactly one key id")
	}

	if err := c.do(ctx, "DELETE", "/api/v1/keys/"+flags.Arg(0), nil, nil); err != nil {
		return err
	}
	fmt.Printf("Revoked %s\n", flags.Arg(0))
	return nil
}

// keyStatus summarises whether a key still works.
func keyStatus(key keySummary) string {
	switch {
	case key.RevokedAt != nil:
		return "revoked"
	case key.ExpiresAt != nil && key.ExpiresAt.Before(time.Now()):
		return "expired"
	case key.IsBootstrap:
		return "active (bootstrap)"
	default:
		return "active"
	}
}

func humanTime(value *time.Time) string {
	if value == nil {
		return "never"
	}
	return value.Format(time.RFC3339)
}

func printJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
