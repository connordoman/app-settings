package apikey_test

import (
	"strings"
	"testing"

	"github.com/connordoman/settings-app/internal/apikey"
)

func TestGenerateRoundTrip(t *testing.T) {
	token, err := apikey.Generate()
	if err != nil {
		t.Fatal(err)
	}

	prefix, err := apikey.Parse(token.String())
	if err != nil {
		t.Fatalf("Parse(%s): %v", token, err)
	}
	if prefix != token.Prefix {
		t.Errorf("parsed prefix %q, want %q", prefix, token.Prefix)
	}
	if !apikey.Verify(token.String(), token.Hash()) {
		t.Error("a freshly minted token failed to verify against its own hash")
	}
}

// The secret is base64url, whose alphabet includes "_" and "-". A token must
// still parse when its secret contains them.
func TestParseHandlesSeparatorsInSecret(t *testing.T) {
	token := apikey.Token{
		Prefix: "0123456789ab",
		Secret: "abc_def-ghi_jkl",
	}

	prefix, err := apikey.Parse(token.String())
	if err != nil {
		t.Fatalf("Parse(%s): %v", token, err)
	}
	if prefix != token.Prefix {
		t.Errorf("parsed prefix %q, want %q", prefix, token.Prefix)
	}
}

func TestTokensAreDistinct(t *testing.T) {
	seen := make(map[string]struct{}, 500)
	for range 500 {
		token, err := apikey.Generate()
		if err != nil {
			t.Fatal(err)
		}
		if _, duplicate := seen[token.Prefix]; duplicate {
			t.Fatalf("prefix %q was generated twice", token.Prefix)
		}
		seen[token.Prefix] = struct{}{}

		// Every generated token must round-trip, whatever characters the
		// CSPRNG happened to produce.
		if _, err := apikey.Parse(token.String()); err != nil {
			t.Fatalf("Parse(%s): %v", token, err)
		}
	}
}

func TestVerifyRejectsTamperedTokens(t *testing.T) {
	token, err := apikey.Generate()
	if err != nil {
		t.Fatal(err)
	}
	hash := token.Hash()

	// Flipping either half must fail: the hash covers the whole token.
	tampered := token
	tampered.Secret = "A" + token.Secret[1:]
	if apikey.Verify(tampered.String(), hash) {
		t.Error("a token with a modified secret verified")
	}

	tampered = token
	tampered.Prefix = strings.Repeat("a", apikey.PrefixLength)
	if apikey.Verify(tampered.String(), hash) {
		t.Error("a token with a modified prefix verified")
	}
}

func TestParseRejectsMalformed(t *testing.T) {
	valid, err := apikey.Generate()
	if err != nil {
		t.Fatal(err)
	}

	for _, presented := range []string{
		"",
		"sa_short_secret",
		"xx_" + valid.Prefix + "_" + valid.Secret,       // wrong label
		"sa_" + valid.Prefix,                            // no secret
		"sa_" + strings.ToUpper(valid.Prefix) + "_abcd", // prefix outside the alphabet
	} {
		if _, err := apikey.Parse(presented); err == nil {
			t.Errorf("Parse(%q) accepted a malformed token", presented)
		}
	}
}

func TestScopes(t *testing.T) {
	if _, err := apikey.ParseScopes([]string{"settings:read", "nope"}); err == nil {
		t.Error("expected an unknown scope to be rejected")
	}
	if _, err := apikey.ParseScopes(nil); err == nil {
		t.Error("expected a key with no scopes to be rejected")
	}

	scopes, err := apikey.ParseScopes([]string{"resolve", "resolve", " settings:read "})
	if err != nil {
		t.Fatal(err)
	}
	if len(scopes) != 2 {
		t.Errorf("got %v, want duplicates collapsed to 2 scopes", scopes)
	}

	if !apikey.Grants([]string{"*"}, apikey.ScopeKeysWrite) {
		t.Error("the wildcard scope should grant everything")
	}
	if apikey.Grants([]string{"settings:read"}, apikey.ScopeSettingsWrite) {
		t.Error("settings:read must not imply settings:write")
	}
}
