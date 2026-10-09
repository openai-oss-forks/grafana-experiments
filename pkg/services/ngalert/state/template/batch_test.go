package template

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/require"
)

func TestLabelLookupEligibility(t *testing.T) {
	require.False(t, HasReusableFields(nil))
	require.False(t, HasReusableFields(map[string]string{"literal": "text", "function": `{{ printf "%s" $labels.x }}`}))
	require.True(t, HasReusableFields(map[string]string{"function": `{{ printf "%s" $labels.x }}`, "lookup": `{{ $labels.x }}`}))
	for _, text := range []string{`{{ $labels.x }}`, `prefix {{ $labels.a_1 }} / {{ $labels._b }} suffix`, "{{\n$labels.X\t}}"} {
		require.True(t, labelLookupsOnly(text), text)
	}
	for _, text := range []string{`literal`, `{{`, `{{ $labels }}`, `{{ $labels.String }}`, `{{ .Labels.x }}`, `{{ $labels.x.y }}`, `{{ $labels.x | printf "%s" }}`, `{{ index $labels "x" }}`, `{{ $values.A }}`, `{{ $value }}`, `{{- $labels.x -}}`, `{{ $labels.1x }}`, `{{ $labels.é }}`, `{{ $labels.x }}{{ now }}`, `{{/* comment */}}`, `{{define "x"}}x{{end}}`, `{{ $labels.x }}{{`} {
		require.False(t, labelLookupsOnly(text), text)
	}
}
func TestLabelBatchDifferential(t *testing.T) {
	ctx := context.Background()
	u := &url.URL{Scheme: "https", Host: "example.invalid"}
	at := time.Unix(1700000000, 123000000)
	cases := []string{`{{ $labels.x }}`, `{{ $labels.missing }}`, `{{ $labels.String }}`, `a{{ $labels.x }}b{{ $labels.y }}`, `{{ $labels.x }}{{`, `{{ . }}`, `{{ printf "%T" . }}`, `{{ printf "%#v" . }}`, `{{ $values.A.Value }}`, `{{ $value }}`, `{{ now }}`, `{{ title $labels.x }}`, `{{define "x"}}local{{end}}{{template "x"}}`, `{{ index $labels "x" }}`, `{{- $labels.x -}}`, `{{ reReplaceAll $labels.x "x" "a" }}`}
	for _, text := range cases {
		t.Run(text, func(t *testing.T) {
			batch := NewBatch(ctx, "synthetic", u)
			for i, labels := range []Labels{nil, {}, {"x": "", "y": "<no value>"}, {"x": "école", "y": "a"}, {"x": "["}, {"x": "last", "String": "map value"}} {
				data := Data{Labels: labels, Value: float64(i), Values: map[string]Value{"A": {Value: float64(i)}}}
				when := at.Add(time.Duration(i) * time.Millisecond)
				want, we := Expand(ctx, "synthetic", text, data, u, when)
				got, ge := batch.Expand("labels", "field", text, data, when)
				require.Equal(t, want, got)
				require.Equal(t, fmt.Sprint(we), fmt.Sprint(ge))
				require.Len(t, batch.fields, 1)
				for _, entry := range batch.fields {
					require.Empty(t, entry.labels)
				}
			}
		})
	}
	// Repeated timestamp: reuse the expander and prove that missing keys do not
	// leak, caller maps remain unchanged, and field replacement stays bounded.
	batch := NewBatch(ctx, "synthetic", u)
	labels := Labels{"x": strings.Repeat("a", 65536)}
	_, err := batch.Expand("labels", "field", `{{ $labels.x }}`, Data{Labels: labels}, at)
	require.NoError(t, err)
	exp := batch.fields[fieldKey{"labels", "field"}].expander
	got, err := batch.Expand("labels", "field", `{{ $labels.x }}`, Data{}, at)
	require.NoError(t, err)
	require.Equal(t, "[no value]", got)
	require.Same(t, exp, batch.fields[fieldKey{"labels", "field"}].expander)
	require.Len(t, labels["x"], 65536)
	for range 2048 {
		_, err = batch.Expand("labels", "field", `{{ $labels.x }}`, Data{Labels: labels}, at)
		require.NoError(t, err)
		require.Empty(t, batch.fields[fieldKey{"labels", "field"}].labels)
	}
	_, err = batch.Expand("labels", "field", `{{ $labels.y }}`, Data{Labels: Labels{"y": "new"}}, at)
	require.NoError(t, err)
	require.Len(t, batch.fields, 1)
}
func TestLabelBatchIndependentConcurrent(t *testing.T) {
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			batch := NewBatch(context.Background(), "synthetic", &url.URL{})
			for range 32 {
				want := fmt.Sprint(i)
				got, err := batch.Expand("labels", "x", `{{ $labels.x }}`, Data{Labels: Labels{"x": want}}, time.Time{})
				if err != nil || got != want {
					t.Errorf("got %q: %v", got, err)
				}
				_, err = batch.Expand("annotations", "title", `{{ title $labels.x }}`, Data{Labels: Labels{"x": "école"}}, time.Time{})
				if err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
}
func TestLabelBatchCounters(t *testing.T) {
	counters := func() (float64, float64) {
		families, err := prometheus.DefaultGatherer.Gather()
		require.NoError(t, err)
		var total, failed float64
		for _, f := range families {
			if f.GetName() == "prometheus_template_text_expansions_total" {
				total = f.Metric[0].GetCounter().GetValue()
			}
			if f.GetName() == "prometheus_template_text_expansion_failures_total" {
				failed = f.Metric[0].GetCounter().GetValue()
			}
		}
		return total, failed
	}
	before, bf := counters()
	batch := NewBatch(context.Background(), "synthetic", &url.URL{})
	for range 3 {
		_, err := batch.Expand("labels", "ok", `{{ $labels.x }}`, Data{}, time.Time{})
		require.NoError(t, err)
	}
	for range 2 {
		_, err := batch.Expand("labels", "bad", `{{`, Data{}, time.Time{})
		require.Error(t, err)
	}
	_, err := batch.Expand("labels", "literal", `literal`, Data{}, time.Time{})
	require.NoError(t, err)
	after, af := counters()
	require.Equal(t, before+5, after)
	require.Equal(t, bf+2, af)
}
