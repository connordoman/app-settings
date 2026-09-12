package valuetype

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// DATETIME is the only temporal type, and it holds exactly one instant.
//
// A value must be a strict RFC 3339 `date-time`:
//
//	date-time = full-date "T" full-time
//	          = 2026-01-02 T 15:04:05[.fraction] (Z | ±hh:mm)
//
// The offset is mandatory, and that single requirement is what makes the rest
// of this simple. A datetime carrying an offset denotes one unambiguous point
// on the timeline, so it can be converted to UTC on the way in and stored in
// one canonical form. A datetime without an offset does not denote an instant
// at all — it is a wall-clock reading that means a different moment in every
// zone — and there would be no correct way to convert it.
//
// Values are normalised to UTC, so they compare and sort correctly as plain
// strings: for two RFC 3339 values that both end in "Z", lexicographic order
// is chronological order.
//
// Browser clients get this for free. `Date.prototype.toISOString()` emits
// exactly this shape, and `JSON.stringify` calls it automatically, so putting
// a Date straight into a request body produces a value this accepts.
const dateTimeExample = "2026-01-02T15:04:05Z"

// zoneFreeLayouts are the shapes a client sends when it has dropped the
// offset. Recognising them lets the error name the real mistake rather than
// reporting a generic parse failure. The third is what an HTML
// <input type="datetime-local"> produces, which is the most common source of
// a zone-free value on the web.
var zoneFreeLayouts = []string{
	"2006-01-02T15:04:05.999999999",
	"2006-01-02T15:04:05",
	"2006-01-02T15:04",
	"2006-01-02",
}

// normaliseDateTime validates an RFC 3339 date-time and returns it in UTC.
func normaliseDateTime(raw json.RawMessage) (json.RawMessage, error) {
	var original string
	if err := json.Unmarshal(raw, &original); err != nil {
		return nil, fmt.Errorf(
			"a DATETIME value must be a JSON string holding an RFC 3339 date-time, like %q", dateTimeExample)
	}

	// RFC 3339 §5.6 permits lower-case "t" and "z"; Go's parser insists on
	// upper case, so accept either and canonicalise here.
	literal := strings.ToUpper(strings.TrimSpace(original))

	instant, err := time.Parse(time.RFC3339Nano, literal)
	if err != nil {
		return nil, explainDateTime(original, literal)
	}

	// Format from the UTC instant: one canonical spelling per moment.
	// RFC3339Nano drops a trailing zero fraction, so a value with no
	// fractional part comes back without a decimal point at all.
	return json.Marshal(instant.UTC().Format(time.RFC3339Nano))
}

// explainDateTime turns a parse failure into advice about the mistake that was
// actually made.
func explainDateTime(original, literal string) error {
	// Missing offset is by far the most common error, and the most confusing,
	// because the value looks like a perfectly good timestamp.
	for _, layout := range zoneFreeLayouts {
		if _, err := time.Parse(layout, literal); err == nil {
			return fmt.Errorf(
				"DATETIME value %q has no UTC offset, so it does not identify a single instant; "+
					"RFC 3339 requires one, as in %q. In a browser, new Date(value).toISOString() adds it",
				original, dateTimeExample)
		}
	}

	// A compact or hour-only offset: the caller meant to supply one, but not
	// in the form RFC 3339 allows.
	if index := strings.LastIndexAny(literal, "+-"); index > 0 {
		if _, err := time.Parse("2006-01-02T15:04:05.999999999", literal[:index]); err == nil {
			return fmt.Errorf(
				"DATETIME value %q has a malformed UTC offset %q; RFC 3339 requires \"Z\" or "+
					"\"+hh:mm\"/\"-hh:mm\", as in %q",
				original, literal[index:], dateTimeExample)
		}
	}

	// A space instead of "T" is what most SQL clients and Python's
	// datetime.isoformat(sep=" ") produce.
	if strings.Contains(literal, " ") {
		return fmt.Errorf(
			"DATETIME value %q must separate the date and time with \"T\", not a space, as in %q",
			original, dateTimeExample)
	}

	return fmt.Errorf(
		"DATETIME value %q is not a valid RFC 3339 date-time; expected YYYY-MM-DDThh:mm:ss[.fraction](Z|±hh:mm), as in %q",
		original, dateTimeExample)
}
