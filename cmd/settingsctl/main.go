// Command settingsctl mints and manages API keys against a running Settings
// App instance.
//
// App Settings is self-hosted, so the first key cannot come from the API
// itself. The server prints a bootstrap key on its first boot; that key can
// only manage other keys, and this tool is how you use it:
//
//	export SETTINGS_URL=https://settings.internal
//	export SETTINGS_API_KEY=as_...            # the bootstrap key
//	settingsctl keys create --name "web backend" --scope resolve --env production
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

// app carries the flags every command shares, plus the client built from them.
type app struct {
	baseURL string
	apiKey  string
	client  *client
}

func main() {
	// Ctrl-C cancels the in-flight request rather than killing the process
	// mid-write, so a `keys create` either happens or does not.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := newRootCommand().ExecuteContext(ctx); err != nil {
		os.Exit(1)
	}
}

func newRootCommand() *cobra.Command {
	a := &app{}

	root := &cobra.Command{
		Use:   "settingsctl",
		Short: "Manage App Settings API keys",
		Long: "settingsctl manages the API keys of a running App Settings instance.\n\n" +
			"On a new server, authenticate with the bootstrap key printed at first boot\n" +
			"and use `keys create` to mint the keys your services will actually use.",
		SilenceUsage:  true, // a failed request is not a usage mistake
		SilenceErrors: false,
	}

	flags := root.PersistentFlags()
	flags.StringVar(&a.baseURL, "url", envOr("SETTINGS_URL", "http://localhost:8080"),
		"base URL of the server [$SETTINGS_URL]")
	flags.StringVar(&a.apiKey, "api-key", os.Getenv("SETTINGS_API_KEY"),
		"key to authenticate with [$SETTINGS_API_KEY]")

	root.AddCommand(
		newKeysCommand(a),
		newWhoamiCommand(a),
		newHealthCommand(a),
		newVersionCommand(),
	)
	return root
}

// requireClient builds the HTTP client just before a command runs. It is a
// per-command hook rather than a persistent one on the root so that Cobra's own
// `help` and `completion` commands keep working without credentials.
func requireClient(a *app) func(*cobra.Command, []string) error {
	return func(*cobra.Command, []string) error {
		if a.apiKey == "" {
			return errors.New("no API key: pass --api-key or set SETTINGS_API_KEY " +
				"(on a new server, the bootstrap key printed at first boot)")
		}
		a.client = newClient(a.baseURL, a.apiKey)
		return nil
	}
}

func newVersionCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the client version",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			fmt.Fprintf(cmd.OutOrStdout(), "settingsctl (App Settings) %s\n", version())
			return nil
		},
	}
}

func newWhoamiCommand(a *app) *cobra.Command {
	var asJSON bool

	cmd := &cobra.Command{
		Use:     "whoami",
		Short:   "Describe the key you are authenticating with",
		Args:    cobra.NoArgs,
		PreRunE: requireClient(a),
		RunE: func(cmd *cobra.Command, _ []string) error {
			var identity struct {
				KeyID        string   `json:"key_id"`
				Name         string   `json:"name"`
				Key          string   `json:"key"`
				Scopes       []string `json:"scopes"`
				Environments []string `json:"environments"`
				Platforms    []string `json:"platforms"`
				Role         string   `json:"role"`
				IsBootstrap  bool     `json:"is_bootstrap"`
			}
			if err := a.client.do(cmd.Context(), "GET", "/api/v1/whoami", nil, &identity); err != nil {
				return err
			}
			if asJSON {
				return printJSON(cmd.OutOrStdout(), identity)
			}

			writer := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
			fmt.Fprintf(writer, "id\t%s\n", identity.KeyID)
			fmt.Fprintf(writer, "name\t%s\n", identity.Name)
			fmt.Fprintf(writer, "key\t%s\n", identity.Key)
			fmt.Fprintf(writer, "role\t%s\n", identity.Role)
			fmt.Fprintf(writer, "scopes\t%s\n", strings.Join(identity.Scopes, ", "))
			fmt.Fprintf(writer, "environments\t%s\n", orAll(identity.Environments))
			fmt.Fprintf(writer, "platforms\t%s\n", orAll(identity.Platforms))
			if identity.IsBootstrap {
				fmt.Fprintf(writer, "bootstrap\tyes — this key can only manage other keys\n")
			}
			return writer.Flush()
		},
	}

	cmd.Flags().BoolVar(&asJSON, "json", false, "print the raw JSON response")
	return cmd
}

func newHealthCommand(a *app) *cobra.Command {
	return &cobra.Command{
		Use:     "health",
		Short:   "Check that the server and its dependencies are up",
		Args:    cobra.NoArgs,
		PreRunE: requireClient(a),
		RunE: func(cmd *cobra.Command, _ []string) error {
			var health map[string]any
			if err := a.client.do(cmd.Context(), "GET", "/readyz", nil, &health); err != nil {
				return err
			}
			return printJSON(cmd.OutOrStdout(), health)
		},
	}
}

// orAll renders an empty filter as the "everything" it means.
func orAll(values []string) string {
	if len(values) == 0 {
		return "(all)"
	}
	return strings.Join(values, ", ")
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
