package template

import (
	"context"
	"net/url"
	"strings"
	"time"

	"github.com/prometheus/prometheus/model/timestamp"
	promtemplate "github.com/prometheus/prometheus/template"
)

// Batch reuses construction only for literal text and simple label lookups.
// It belongs to one sequential evaluation; never share it between goroutines.
// Every expansion still calls the supported Prometheus Expand API. Cleared label
// maps retain capacity up to the largest input seen for each field until the
// evaluation returns, but no result strings or expanded output are retained.
type Batch struct {
	ctx         context.Context
	name        string
	externalURL *url.URL
	fields      map[fieldKey]batchEntry
}
type fieldKey struct{ namespace, key string }
type batchEntry struct {
	text     string
	millis   int64
	expander *promtemplate.Expander
	fullText string
	labels   Labels
}

// HasReusableFields reports whether a field map contains an eligible label template.
// Callers can avoid batch bookkeeping entirely when every field will fall back.
func HasReusableFields(fields map[string]string) bool {
	for _, text := range fields {
		if labelLookupsOnly(text) {
			return true
		}
	}
	return false
}

func NewBatch(ctx context.Context, name string, externalURL *url.URL) *Batch {
	return &Batch{ctx: ctx, name: name, externalURL: externalURL}
}
func (b *Batch) Expand(namespace, key, text string, data Data, at time.Time) (string, error) {
	if !strings.Contains(text, "{{") {
		return text, nil
	}
	if b.fields == nil {
		b.fields = make(map[fieldKey]batchEntry)
	}
	k := fieldKey{namespace, key}
	e, ok := b.fields[k]
	ms := timestamp.FromTime(at)
	if !ok || e.text != text || e.millis != ms {
		e = batchEntry{text: text, millis: ms}
		if labelLookupsOnly(text) {
			e.labels = make(Labels, len(data.Labels))
			e.expander, e.fullText = newExpander(b.ctx, b.name, text, Data{Labels: e.labels}, b.externalURL, at)
		}
		b.fields[k] = e
	}
	if e.expander == nil {
		return Expand(b.ctx, b.name, text, data, b.externalURL, at)
	}
	// The admitted syntax can observe only individual label values. Keep the
	// original Data value type while mutating an owned map, never caller maps.
	for k, v := range data.Labels {
		e.labels[k] = v
	}
	defer clear(e.labels) // Retain no result strings between invocations.
	result, err := e.expander.Expand()
	if err != nil {
		return "", ExpandError{Tmpl: e.fullText, Err: err}
	}
	return strings.ReplaceAll(result, "<no value>", "[no value]"), nil
}

// labelLookupsOnly deliberately admits a strict subset of the template grammar:
// literal text and {{ $labels.ASCII_identifier }} actions, without trim markers,
// functions, pipelines, assignments, nested access, or control flow. Everything
// else keeps the existing expansion path. This is not a template parser.
func labelLookupsOnly(text string) bool {
	found := false
	for {
		start := strings.Index(text, "{{")
		if start < 0 {
			return found
		}
		text = text[start+2:]
		end := strings.Index(text, "}}")
		if end < 0 {
			return false
		}
		action := strings.Trim(text[:end], " \t\r\n")
		if !strings.HasPrefix(action, "$labels.") {
			return false
		}
		key := strings.TrimPrefix(action, "$labels.")
		// String is a Labels method, not an individual map lookup.
		if key == "" || key == "String" {
			return false
		}
		for i, c := range key {
			if c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (i > 0 && c >= '0' && c <= '9') {
				continue
			}
			return false
		}
		found = true
		text = text[end+2:]
	}
}
