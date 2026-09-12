// Package buildinfo reports the version of the running binary.
package buildinfo

import "runtime/debug"

// version is empty in ordinary builds and set by the release pipeline with
// -ldflags "-X github.com/connordoman/app-settings/internal/buildinfo.version=v1.2.3".
// It exists because a goreleaser build is not a `go install module@version`, so
// the toolchain has no module version of its own to stamp.
var version string

// Version returns the release version, preferring the linker-stamped value and
// falling back to the module version the toolchain records for `go install`ed
// builds and for `go build` of a clean, tagged checkout.
func Version() string {
	if version != "" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" {
		return info.Main.Version
	}
	return "(devel)"
}
