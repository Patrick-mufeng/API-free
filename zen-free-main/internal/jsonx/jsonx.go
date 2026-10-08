// Package jsonx holds the JSON accessors used by every package that reads
// client or upstream payloads decoded into map[string]any.
package jsonx

import (
	"encoding/json"
	"strings"
)

// AnyAt walks a path of keys, returning nil as soon as a level is missing.
func AnyAt(object map[string]any, path ...string) any {
	var current any = object
	for _, key := range path {
		next, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = next[key]
	}
	return current
}

func StringAt(object map[string]any, path ...string) string {
	value, _ := AnyAt(object, path...).(string)
	return value
}

func BoolAt(object map[string]any, path ...string) bool {
	value, _ := AnyAt(object, path...).(bool)
	return value
}

// NumberAt returns a pointer so callers can tell "absent" from zero — the free
// decision depends on that distinction.
func NumberAt(object map[string]any, path ...string) *float64 {
	value, exists := AnyAt(object, path...).(float64)
	if !exists {
		return nil
	}
	return &value
}

func IntAt(object map[string]any, path ...string) int {
	switch number := AnyAt(object, path...).(type) {
	case float64:
		return int(number)
	case int:
		return number
	case json.Number:
		integer, _ := number.Int64()
		return int(integer)
	default:
		return 0
	}
}

func SliceAt(object map[string]any, path ...string) []any {
	values, _ := AnyAt(object, path...).([]any)
	return values
}

func MapAt(object map[string]any, path ...string) map[string]any {
	value, _ := AnyAt(object, path...).(map[string]any)
	return value
}

// Clone deep-copies through JSON, which is how the request body survives the
// rewrite steps without aliasing the decoded original.
func Clone(input map[string]any) map[string]any {
	data, _ := json.Marshal(input)
	var output map[string]any
	_ = json.Unmarshal(data, &output)
	return output
}

func FirstString(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
