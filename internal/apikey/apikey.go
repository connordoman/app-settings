// Package apikey mints and verifies the tokens that guard the API.
//
// A token looks like:
//
//	sa_k3n8qv2mx7wd_7Hf2...43 base64url characters
//	│  │             └ secret: 32 CSPRNG bytes, never stored
//	│  └ prefix: stored in the clear, uniquely indexed, identifies the row
//	└ fixed label, so a leaked token is recognisable in logs and scanners
//
// Only sha256(token) is persisted. A password KDF such as argon2 exists to slow
// down guessing a low-entropy human secret; against 256 bits of CSPRNG output
// it buys nothing, and it would add a deliberately slow hash to every single
// authenticated request. The prefix makes lookup a single indexed read, so the
// hash is compared exactly once.
package apikey

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

const (
	// Label marks a string as a Settings App key.
	Label = "sa"
	// PrefixLength is the number of characters in the public prefix.
	PrefixLength = 12
	// secretBytes is the entropy behind the secret half.
	secretBytes = 32
)

// prefixAlphabet is Crockford-style base32: no i, l, o or u, so a prefix read
// aloud or copied by hand is hard to garble.
const prefixAlphabet = "0123456789abcdefghjkmnpqrstvwxyz"

// ErrMalformed means a string is not shaped like a token at all.
var ErrMalformed = errors.New("malformed API key")

// Token is a freshly minted key. The full value exists only here and in the
// response that hands it to the operator; it is never recoverable afterwards.
type Token struct {
	Prefix string
	Secret string
}

// String renders the complete token.
func (t Token) String() string {
	return Label + "_" + t.Prefix + "_" + t.Secret
}

// Hash returns the digest to persist alongside the prefix.
func (t Token) Hash() []byte {
	return hashToken(t.String())
}

// Generate mints a new token from the system CSPRNG.
func Generate() (Token, error) {
	prefix, err := randomPrefix()
	if err != nil {
		return Token{}, err
	}

	secret := make([]byte, secretBytes)
	if _, err := rand.Read(secret); err != nil {
		return Token{}, fmt.Errorf("read random bytes: %w", err)
	}

	return Token{Prefix: prefix, Secret: base64.RawURLEncoding.EncodeToString(secret)}, nil
}

// randomPrefix draws PrefixLength characters uniformly from the alphabet. The
// alphabet is a power of two in size, so masking the random byte is unbiased.
func randomPrefix() (string, error) {
	buffer := make([]byte, PrefixLength)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("read random bytes: %w", err)
	}
	for i, b := range buffer {
		buffer[i] = prefixAlphabet[b%byte(len(prefixAlphabet))]
	}
	return string(buffer), nil
}

// Parse splits a presented token, returning the prefix used to look up the row.
// It deliberately reveals nothing about whether the key exists.
func Parse(presented string) (prefix string, err error) {
	// SplitN, not Split: the base64url secret may itself contain underscores.
	parts := strings.SplitN(strings.TrimSpace(presented), "_", 3)
	if len(parts) != 3 || parts[0] != Label {
		return "", ErrMalformed
	}
	if len(parts[1]) != PrefixLength || parts[2] == "" {
		return "", ErrMalformed
	}
	if strings.Trim(parts[1], prefixAlphabet) != "" {
		return "", ErrMalformed
	}
	return parts[1], nil
}

// Verify reports whether a presented token matches a stored hash, in time
// independent of how much of the hash matched.
func Verify(presented string, storedHash []byte) bool {
	return subtle.ConstantTimeCompare(hashToken(strings.TrimSpace(presented)), storedHash) == 1
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// Display renders a key for humans: enough to identify the row, nothing usable.
func Display(prefix string) string {
	return Label + "_" + prefix + "_" + strings.Repeat("•", 8)
}
