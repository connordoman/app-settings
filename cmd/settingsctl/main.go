// Command settingsctl mints and manages API keys against a running Settings
// App instance.
//
// Settings App is self-hosted, so the first key cannot come from the API
// itself. The server prints a bootstrap key on its first boot; that key can
// only manage other keys, and this tool is how you use it:
//
//	export SETTINGS_URL=https://settings.internal
//	export SETTINGS_API_KEY=sa_...            # the bootstrap key
//	settingsctl keys create --name "web backend" --scope resolve --env production
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"text/tabwriter"
)

// commands are dispatched on the first argument.
var commands = map[string]func(context.Context, *client, []string) error{
	"keys":    runKeys,
	"whoami":  runWhoami,
	"health":  runHealth,
	"version": runVersion,
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(2)
		}
		fmt.Fprintf(os.Stderr, "settingsctl: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		usage()
		return nil
	}

	command, known := commands[args[0]]
	if !known {
		usage()
		return fmt.Errorf("unknown command %q", args[0])
	}

	baseURL := envOr("SETTINGS_URL", "http://localhost:8080")
	apiKey := os.Getenv("SETTINGS_API_KEY")

	// `version` needs no server, so check credentials for everything else.
	if args[0] != "version" && apiKey == "" {
		return errors.New("set SETTINGS_API_KEY to the key you want to authenticate with " +
			"(on a new server, the bootstrap key printed at first boot)")
	}

	return command(ctx, newClient(baseURL, apiKey), args[1:])
}

func usage() {
	fmt.Fprint(os.Stderr, `settingsctl — manage Settings App API keys

Usage:
  settingsctl <command> [flags]

Commands:
  keys create     Mint a new API key
  keys list       List keys (never shows secrets)
  keys revoke     Permanently revoke a key by id
  whoami          Describe the key in SETTINGS_API_KEY
  health          Check that the server and its dependencies are up
  version         Print the client version

Environment:
  SETTINGS_URL       Base URL of the server (default http://localhost:8080)
  SETTINGS_API_KEY   The key to authenticate with

Run 'settingsctl keys create -h' for the flags of a subcommand.
`)
}

func runVersion(context.Context, *client, []string) error {
	fmt.Println("settingsctl (Settings App)")
	return nil
}

func runWhoami(ctx context.Context, c *client, args []string) error {
	flags := flag.NewFlagSet("whoami", flag.ContinueOnError)
	asJSON := flags.Bool("json", false, "print the raw JSON response")
	if err := flags.Parse(args); err != nil {
		return err
	}

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
	if err := c.do(ctx, "GET", "/api/v1/whoami", nil, &identity); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(identity)
	}

	writer := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
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
}

func runHealth(ctx context.Context, c *client, args []string) error {
	flags := flag.NewFlagSet("health", flag.ContinueOnError)
	if err := flags.Parse(args); err != nil {
		return err
	}

	var health map[string]any
	if err := c.do(ctx, "GET", "/readyz", nil, &health); err != nil {
		return err
	}
	return printJSON(health)
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
