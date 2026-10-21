package apperror

import "encoding/json"

const Prefix = "OPENSHELL_ERROR:"

type Error struct {
	Code   string         `json:"code"`
	Params map[string]any `json:"params,omitempty"`
	Cause  error          `json:"-"`
}

func New(code string, params map[string]any) error { return &Error{Code: code, Params: params} }
func Wrap(code string, cause error, params map[string]any) error {
	return &Error{Code: code, Params: params, Cause: cause}
}
func (e *Error) Error() string {
	detail := ""
	if e.Cause != nil {
		detail = e.Cause.Error()
	}
	data, _ := json.Marshal(struct {
		Code   string         `json:"code"`
		Params map[string]any `json:"params,omitempty"`
		Detail string         `json:"detail,omitempty"`
	}{e.Code, e.Params, detail})
	return Prefix + string(data)
}
func (e *Error) Unwrap() error { return e.Cause }
