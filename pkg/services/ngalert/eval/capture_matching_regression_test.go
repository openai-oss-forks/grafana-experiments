package eval

import (
	"fmt"
	"math/rand"
	"sort"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/grafana/grafana/pkg/services/ngalert/models"
	"github.com/stretchr/testify/require"
)

// Compare capture attachment with an exhaustive matcher, including exact-match
// precedence, empty labels, heterogeneous cardinalities and duplicate captures.
func TestCaptureMatchingAgainstExhaustiveReference(t *testing.T) {
	rng := rand.New(rand.NewSource(718))
	for trial := 0; trial < 600; trial++ {
		response := backend.NewQueryDataResponse()
		condition := models.Condition{Condition: "C"}
		expectedByRef := map[string]map[data.Fingerprint]NumberValueCapture{}
		for _, ref := range []string{"A", "B", "C"} {
			condition.Data = append(condition.Data, models.AlertQuery{RefID: ref, DatasourceUID: "synthetic", Model: []byte(`{}`)})
			expectedByRef[ref] = map[data.Fingerprint]NumberValueCapture{}
			frames := make(data.Frames, 12)
			for i := range frames {
				labels := data.Labels{}
				for k, key := range []string{"x", "y", "z"} {
					include := rng.Intn(2) == 1
					if trial%3 != 2 {
						include = k < trial%3+1
					}
					if include {
						labels[key] = fmt.Sprint(rng.Intn(3))
						if rng.Intn(3) == 0 {
							labels[key] = ""
						}
					}
				}
				value := float64(i)
				valuePtr := &value
				if i%4 == 0 {
					valuePtr = nil
				}
				frames[i] = data.NewFrame("synthetic", data.NewField("value", labels, []*float64{valuePtr}))
				frames[i].RefID = ref
				expectedByRef[ref][labels.Fingerprint()] = NumberValueCapture{Var: ref, Labels: labels, Value: valuePtr}
			}
			response.Responses[ref] = backend.DataResponse{Frames: frames}
		}
		result := queryDataResponseToExecutionResults(condition, response)
		for _, frame := range result.Condition {
			labels := frame.Fields[0].Labels
			var want []string
			for _, captures := range expectedByRef {
				if capture, ok := captures[labels.Fingerprint()]; ok {
					want = append(want, captureSignature(capture))
					continue
				}
				for _, capture := range captures {
					if labels.Equals(capture.Labels) || labels.Contains(capture.Labels) || capture.Labels.Contains(labels) {
						want = append(want, captureSignature(capture))
					}
				}
			}
			captures := frame.Meta.Custom.([]NumberValueCapture)
			got := make([]string, 0, len(captures))
			for _, capture := range captures {
				got = append(got, captureSignature(capture))
			}
			sort.Strings(want)
			sort.Strings(got)
			require.Equal(t, want, got, "trial %d labels %v", trial, labels)
		}
	}
}

func captureSignature(c NumberValueCapture) string {
	value := "null"
	if c.Value != nil {
		value = fmt.Sprintf("%g", *c.Value)
	}
	return fmt.Sprintf("%s|%s|%s", c.Var, c.Labels.String(), value)
}

func TestCaptureMatchingEdgeCases(t *testing.T) {
	cases := []struct {
		name      string
		condition data.Labels
		upstream  []data.Labels
		want      []string
	}{
		{"nil and empty", nil, []data.Labels{nil, {}}, []string{"A||null", "C||null"}},
		{"empty values with different keys", data.Labels{"b": ""}, []data.Labels{{"a": ""}}, []string{"C|b=|null"}},
		{"exact takes precedence", data.Labels{"x": "1"}, []data.Labels{{}, {"x": "1"}, {"x": "1", "y": "2"}}, []string{"A|x=1|null", "C|x=1|null"}},
		{"mixed subsets and supersets", data.Labels{"x": "1"}, []data.Labels{{}, {"x": "1", "y": "2"}, {"x": "2"}}, []string{"A||null", "A|x=1, y=2|null", "C|x=1|null"}},
		{"uniform subsets", data.Labels{"x": "1", "y": "2"}, []data.Labels{{"x": "1"}, {"y": "2"}}, []string{"A|x=1|null", "A|y=2|null", "C|x=1, y=2|null"}},
		{"uniform supersets", data.Labels{"x": "1"}, []data.Labels{{"x": "1", "y": "2"}, {"x": "1", "y": "3"}}, []string{"A|x=1, y=2|null", "A|x=1, y=3|null", "C|x=1|null"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			frame := func(labels data.Labels) *data.Frame {
				return data.NewFrame("synthetic", data.NewField("value", labels, []*float64{nil}))
			}
			response := backend.NewQueryDataResponse()
			response.Responses["C"] = backend.DataResponse{Frames: data.Frames{frame(tc.condition)}}
			for _, labels := range tc.upstream {
				r := response.Responses["A"]
				r.Frames = append(r.Frames, frame(labels))
				response.Responses["A"] = r
			}
			result := queryDataResponseToExecutionResults(models.Condition{Condition: "C"}, response)
			captures := result.Condition[0].Meta.Custom.([]NumberValueCapture)
			got := make([]string, 0, len(captures))
			for _, c := range captures {
				got = append(got, captureSignature(c))
			}
			require.ElementsMatch(t, tc.want, got)
		})
	}
	t.Run("shared frames use response RefID and copy labels", func(t *testing.T) {
		labels := data.Labels{"x": "1"}
		frame := data.NewFrame("synthetic", data.NewField("value", labels, []*float64{nil}))
		frame.RefID = "unrelated"
		response := backend.NewQueryDataResponse()
		response.Responses["A"] = backend.DataResponse{Frames: data.Frames{frame}}
		response.Responses["C"] = backend.DataResponse{Frames: data.Frames{frame}}
		result := queryDataResponseToExecutionResults(models.Condition{Condition: "C"}, response)
		captures := result.Condition[0].Meta.Custom.([]NumberValueCapture)
		require.Len(t, captures, 2)
		require.ElementsMatch(t, []string{"A|x=1|null", "C|x=1|null"}, []string{captureSignature(captures[0]), captureSignature(captures[1])})
		require.Equal(t, data.Labels{"x": "1"}, labels)
		labels["x"] = "changed"
		require.Equal(t, "1", captures[0].Labels["x"])
		captures[0].Labels["x"] = "capture changed"
		require.Equal(t, "1", captures[1].Labels["x"])
	})
}
