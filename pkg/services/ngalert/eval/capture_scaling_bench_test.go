package eval

import (
	"fmt"
	"strconv"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/grafana/grafana/pkg/services/ngalert/models"
)

// This isolates response/capture conversion, excluding datasource transport,
// expression execution, formatting of results, and fixture creation.
func syntheticCaptureResponse(n, branches int, mode string) (models.Condition, *backend.QueryDataResponse) {
	c := models.Condition{Condition: "C"}
	response := backend.NewQueryDataResponse()
	for branch := 0; branch <= branches; branch++ {
		ref := fmt.Sprintf("A%d", branch)
		if branch == 0 {
			ref = "C"
		}
		c.Data = append(c.Data, models.AlertQuery{RefID: ref, DatasourceUID: "synthetic", Model: []byte(`{}`)})
		frames := make(data.Frames, n)
		for i := range frames {
			labels := data.Labels{"series": strconv.Itoa(i)}
			if mode == "subset" && branch == 0 {
				labels["region"] = "synthetic"
			}
			if mode == "superset" && branch != 0 {
				labels["region"] = "synthetic"
			}
			if mode == "disjoint" && branch != 0 {
				labels["series"] = "other-" + strconv.Itoa(i)
			}
			value := float64(i % 2)
			frames[i] = data.NewFrame("synthetic", data.NewField("value", labels, []*float64{&value}))
			frames[i].RefID = ref
		}
		response.Responses[ref] = backend.DataResponse{Frames: frames}
	}
	return c, response
}

func checkSyntheticCaptures(tb testing.TB, result ExecutionResults, n, branches int, mode string) {
	tb.Helper()
	if result.Error != nil || len(result.Condition) != n {
		tb.Fatalf("unexpected conversion: %v, %d", result.Error, len(result.Condition))
	}
	want := branches + 1
	if mode == "disjoint" {
		want = 1
	}
	for i, frame := range result.Condition {
		captures, ok := frame.Meta.Custom.([]NumberValueCapture)
		if !ok || len(captures) != want {
			tb.Fatalf("frame %d: captures=%d, want %d", i, len(captures), want)
		}
		seen := map[string]bool{}
		for _, capture := range captures {
			if seen[capture.Var] || capture.Value == nil || *capture.Value != float64(i%2) {
				tb.Fatalf("invalid capture %v", capture)
			}
			seen[capture.Var] = true
		}
		if !seen["C"] {
			tb.Fatal("condition capture missing")
		}
		if mode != "disjoint" {
			for branch := 1; branch <= branches; branch++ {
				if !seen[fmt.Sprintf("A%d", branch)] {
					tb.Fatalf("capture branch %d missing", branch)
				}
			}
		}
	}
}

func TestSyntheticCaptureShapes(t *testing.T) {
	for _, mode := range []string{"exact", "disjoint", "subset", "superset"} {
		t.Run(mode, func(t *testing.T) {
			c, response := syntheticCaptureResponse(10, 4, mode)
			checkSyntheticCaptures(t, queryDataResponseToExecutionResults(c, response), 10, 4, mode)
		})
	}
}

func BenchmarkCaptureMatching(b *testing.B) {
	for _, n := range []int{100, 1000, 3000} {
		for _, branches := range []int{1, 4} {
			for _, mode := range []string{"exact", "disjoint", "subset", "superset"} {
				b.Run(fmt.Sprintf("n=%d/branches=%d/%s", n, branches, mode), func(b *testing.B) {
					c, response := syntheticCaptureResponse(n, branches, mode)
					checkSyntheticCaptures(b, queryDataResponseToExecutionResults(c, response), n, branches, mode)
					b.ReportAllocs()
					b.ResetTimer()
					for i := 0; i < b.N; i++ {
						queryDataResponseToExecutionResults(c, response)
					}
				})
			}
		}
	}
}

// One condition frame can retain many captures even though it returns one state.
func BenchmarkScalarCaptureFanout(b *testing.B) {
	for _, n := range []int{100, 1000, 3000} {
		for _, phase := range []string{"conversion", "formatting"} {
			b.Run(fmt.Sprintf("captures=%d/%s", n, phase), func(b *testing.B) {
				c, response := syntheticCaptureResponse(n, 1, "exact")
				value := 1.0
				frame := data.NewFrame("synthetic", data.NewField("value", data.Labels{}, []*float64{&value}))
				frame.RefID = "C"
				response.Responses["C"] = backend.DataResponse{Frames: data.Frames{frame}}
				result := queryDataResponseToExecutionResults(c, response)
				captures, ok := result.Condition[0].Meta.Custom.([]NumberValueCapture)
				if !ok || len(captures) != n+1 {
					b.Fatalf("got %d captures, want %d", len(captures), n+1)
				}
				size := len(extractEvalString(frame))
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					if phase == "conversion" {
						queryDataResponseToExecutionResults(c, response)
					} else {
						if len(extractEvalString(frame)) != size {
							b.Fatal("format size changed")
						}
					}
				}
				b.ReportMetric(float64(n+1), "captures/op")
				b.ReportMetric(float64(size), "formatted-B/op")
			})
		}
	}
}
