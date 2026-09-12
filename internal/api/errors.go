package api

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/connordoman/app-settings/internal/store"
)

// errorBody is the single error shape every endpoint returns, so a client can
// parse failures without special-casing the route.
type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	// Code is a stable machine-readable identifier.
	Code string `json:"code"`
	// Message explains the failure to a human operator.
	Message string `json:"message"`
}

// Error codes returned by the API.
const (
	codeInvalidRequest = "invalid_request"
	codeUnauthorized   = "unauthorized"
	codeForbidden      = "forbidden"
	codeNotFound       = "not_found"
	codeConflict       = "conflict"
	codeInternal       = "internal_error"
	codeUnavailable    = "unavailable"
)

// fail aborts the request with a structured error.
func fail(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, errorBody{Error: errorDetail{Code: code, Message: message}})
}

// failValidation reports a request the caller can fix.
func failValidation(c *gin.Context, err error) {
	fail(c, http.StatusBadRequest, codeInvalidRequest, err.Error())
}

// failStore maps a database error onto the right status. Anything unrecognised
// becomes a 500 with a generic message, and the detail is logged instead of
// being returned, so internal structure does not leak to callers.
func failStore(c *gin.Context, err error) {
	classified := store.Classify(err)

	switch {
	case store.IsNotFound(classified):
		fail(c, http.StatusNotFound, codeNotFound, "not found")
	case errors.Is(classified, store.ErrConflict):
		fail(c, http.StatusConflict, codeConflict, unwrapMessage(classified))
	case errors.Is(classified, store.ErrInvalid):
		fail(c, http.StatusBadRequest, codeInvalidRequest, unwrapMessage(classified))
	default:
		_ = c.Error(err)
		fail(c, http.StatusInternalServerError, codeInternal, "internal error")
	}
}

// unwrapMessage strips the sentinel prefix that Classify added.
func unwrapMessage(err error) string {
	message := err.Error()
	for _, prefix := range []string{"conflict: ", "invalid: "} {
		if len(message) > len(prefix) && message[:len(prefix)] == prefix {
			return message[len(prefix):]
		}
	}
	return message
}
