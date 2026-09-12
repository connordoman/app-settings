package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/connordoman/app-settings/internal/apikey"
)

func newKeysCommand(a *app) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "keys",
		Short:   "Mint, list and revoke API keys",
		Aliases: []string{"key"},
	}
	cmd.AddCommand(
		newKeysCreateCommand(a),
		newKeysListCommand(a),
		newKeysRevokeCommand(a),
	)
	return cmd
}

func newKeysCreateCommand(a *app) *cobra.Command {
	var (
		name         string
		scopes       []string
		environments []string
		platforms    []string
		role         string
		expiresIn    string
		asJSON       bool
	)

	cmd := &cobra.Command{
		Use:   "create --name NAME --scope SCOPE [flags]",
		Short: "Mint a new API key",
		Long: "Mint a new API key.\n\nAvailable scopes:\n  " +
			apikey.JoinScopes(apikey.AllScopes) + "\n\n" +
			"A key can never mint a key broader than itself.",
		Example: `  settingsctl keys create --name "web backend" \
      --scope resolve --scope values:write --env production --platform web`,
		Args:    cobra.NoArgs,
		PreRunE: requireClient(a),
		RunE: func(cmd *cobra.Command, _ []string) error {
			// Fail on an unknown scope here rather than after a round trip.
			if _, err := apikey.ParseScopes(scopes); err != nil {
				return err
			}

			request := map[string]any{
				"name":         name,
				"scopes":       scopes,
				"environments": orEmpty(environments),
				"platforms":    orEmpty(platforms),
			}
			if role != "" {
				request["role"] = role
			}
			if expiresIn != "" {
				if _, err := time.ParseDuration(expiresIn); err != nil {
					return fmt.Errorf("--expires-in must be a duration such as 720h: %w", err)
				}
				request["expires_in"] = expiresIn
			}

			var created struct {
				Key     keySummary `json:"key"`
				Token   string     `json:"token"`
				Warning string     `json:"warning"`
			}
			if err := a.client.do(cmd.Context(), "POST", "/api/v1/keys", request, &created); err != nil {
				return err
			}
			if asJSON {
				return printJSON(cmd.OutOrStdout(), created)
			}

			// The token goes to stdout on its own line so it can be piped
			// straight into a secret store; everything else goes to stderr.
			out := cmd.ErrOrStderr()
			fmt.Fprintf(out, "Created key %q (%s)\n", created.Key.Name, created.Key.ID)
			fmt.Fprintf(out, "  scopes:       %s\n", strings.Join(created.Key.Scopes, ", "))
			fmt.Fprintf(out, "  environments: %s\n", orAll(created.Key.Environments))
			fmt.Fprintf(out, "  platforms:    %s\n", orAll(created.Key.Platforms))
			fmt.Fprintf(out, "  role:         %s\n", created.Key.Role)
			if created.Key.ExpiresAt != nil {
				fmt.Fprintf(out, "  expires:      %s\n", created.Key.ExpiresAt.Format(time.RFC3339))
			}
			fmt.Fprintf(out, "\n%s\n\n", created.Warning)

			fmt.Fprintln(cmd.OutOrStdout(), created.Token)
			return nil
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&name, "name", "", "human-readable name for the key (required)")
	// StringSlice takes both `--scope a --scope b` and `--scope a,b`.
	flags.StringSliceVar(&scopes, "scope", nil, "scope to grant; repeatable, or comma-separated. Use '*' for all")
	flags.StringSliceVar(&environments, "env", nil, "restrict the key to an environment; repeatable. Default: all")
	flags.StringSliceVar(&platforms, "platform", nil, "restrict the key to a platform; repeatable. Default: all")
	flags.StringVar(&role, "role", "", "role ceiling for the key (default: the server's lowest role)")
	flags.StringVar(&expiresIn, "expires-in", "", "lifetime such as 720h; omit for a key that never expires")
	flags.BoolVar(&asJSON, "json", false, "print the raw JSON response")

	_ = cmd.MarkFlagRequired("name")
	_ = cmd.MarkFlagRequired("scope")
	_ = cmd.RegisterFlagCompletionFunc("scope", completeScopes)

	return cmd
}

// completeScopes offers the grantable scopes to the shell.
func completeScopes(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
	names := make([]string, 0, len(apikey.AllScopes))
	for _, scope := range apikey.AllScopes {
		names = append(names, string(scope))
	}
	// Scopes are comma-joinable, so don't let the shell append a space.
	return names, cobra.ShellCompDirectiveNoFileComp | cobra.ShellCompDirectiveNoSpace
}

// orEmpty encodes an unset filter as [] rather than null, so the server reads
// it as "no restriction" instead of a missing value.
func orEmpty(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func newKeysListCommand(a *app) *cobra.Command {
	var (
		includeRevoked bool
		asJSON         bool
	)

	cmd := &cobra.Command{
		Use:     "list",
		Short:   "List keys (never shows secrets)",
		Args:    cobra.NoArgs,
		PreRunE: requireClient(a),
		RunE: func(cmd *cobra.Command, _ []string) error {
			path := "/api/v1/keys"
			if includeRevoked {
				path += "?include_revoked=true"
			}

			var listing struct {
				Keys []keySummary `json:"keys"`
			}
			if err := a.client.do(cmd.Context(), "GET", path, nil, &listing); err != nil {
				return err
			}
			if asJSON {
				return printJSON(cmd.OutOrStdout(), listing)
			}
			if len(listing.Keys) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "No keys.")
				return nil
			}

			writer := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
			fmt.Fprintln(writer, "ID\tNAME\tKEY\tROLE\tSCOPES\tENVIRONMENTS\tSTATUS\tLAST USED")
			for _, key := range listing.Keys {
				fmt.Fprintf(writer, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
					key.ID, key.Name, apikey.Display(key.Prefix), key.Role,
					strings.Join(key.Scopes, " "), orAll(key.Environments),
					keyStatus(key), humanTime(key.LastUsedAt))
			}
			return writer.Flush()
		},
	}

	cmd.Flags().BoolVar(&includeRevoked, "include-revoked", false, "also list revoked keys")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print the raw JSON response")
	return cmd
}

func newKeysRevokeCommand(a *app) *cobra.Command {
	return &cobra.Command{
		Use:     "revoke <key-id>",
		Short:   "Permanently revoke a key by id",
		Long:    "Revoke a key by id. Revocation is permanent and takes effect immediately.",
		Args:    cobra.ExactArgs(1),
		PreRunE: requireClient(a),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := args[0]
			if err := a.client.do(cmd.Context(), "DELETE", "/api/v1/keys/"+url.PathEscape(id), nil, nil); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Revoked %s\n", id)
			return nil
		},
	}
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

func printJSON(out io.Writer, value any) error {
	encoder := json.NewEncoder(out)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
