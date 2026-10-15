package state

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"testing"
	"time"

	"github.com/benbjohnson/clock"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/infra/tracing"
	"github.com/grafana/grafana/pkg/services/ngalert/eval"
	"github.com/grafana/grafana/pkg/services/ngalert/models"
)

func templateFixture(mode string, captures int) (models.AlertRule, eval.Result) {
	rule := models.AlertRule{OrgID: 1, UID: "synthetic", Title: "synthetic", IntervalSeconds: 60, NoDataState: models.NoData, ExecErrState: models.KeepLastErrState}
	switch mode {
	case "literal":
		rule.Labels = map[string]string{"route": "synthetic"}
		rule.Annotations = map[string]string{"summary": "literal annotation"}
	case "dynamic-label":
		rule.Labels = map[string]string{"route": `{{ $labels.series }}`}
		rule.Annotations = map[string]string{"summary": "literal annotation"}
	case "dynamic":
		rule.Labels = map[string]string{"route": "synthetic"}
		rule.Annotations = map[string]string{"summary": `{{ $labels.series }} {{ $values.A0.Value }} {{ printf "%.0f" (now) }}`}
	}
	result := eval.Result{Instance: data.Labels{"series": "0"}, State: eval.Normal, EvaluatedAt: time.Unix(1700000000, 0).UTC(), Values: map[string]eval.NumberValueCapture{}}
	for i := 0; i < captures; i++ {
		v := float64(i)
		ref := fmt.Sprintf("A%d", i)
		result.Values[ref] = eval.NumberValueCapture{Var: ref, Value: &v}
	}
	return rule, result
}

// One state construction with advancing evaluation time, excluding fixtures.
func BenchmarkTemplateStateConstruction(b *testing.B) {
	for _, mode := range []string{"empty", "literal", "dynamic"} {
		for _, captures := range []int{3, 32} {
			b.Run(fmt.Sprintf("%s/captures=%d", mode, captures), func(b *testing.B) {
				rule, result := templateFixture(mode, captures)
				ctx := context.Background()
				logger := log.NewNopLogger()
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					result.EvaluatedAt = result.EvaluatedAt.Add(time.Minute)
					newState(ctx, logger, &rule, result, nil, nil)
				}
			})
		}
	}
}

// Five advancing ticks: Normal, half missing, stale missing, KeepLast error,
// and all Normal again. Includes cache/state work, not fixture construction or
// real persistence, notification transport, history or expression evaluation.
func BenchmarkTemplateStateCycle(b *testing.B) {
	for _, mode := range []string{"literal", "dynamic"} {
		b.Run(mode, func(b *testing.B) {
			rule, result := templateFixture(mode, 3)
			manager := NewManager(ManagerCfg{Clock: clock.New(), Tracer: tracing.NewNoopTracerService(), Log: log.NewNopLogger()}, NewNoopPersister())
			results := make(eval.Results, 100)
			for i := range results {
				results[i] = result
				results[i].Instance = data.Labels{"series": strconv.Itoa(i)}
			}
			errorResults := eval.Results{{State: eval.Error, Error: errors.New("synthetic error")}}
			errorResult := &errorResults[0]
			tick := result.EvaluatedAt
			ctx := context.Background()
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				for phase := 0; phase < 5; phase++ {
					tick = tick.Add(time.Minute)
					for j := range results {
						results[j].EvaluatedAt = tick
					}
					current := results
					if phase == 1 || phase == 2 {
						current = results[:50]
					}
					if phase == 3 {
						errorResult.EvaluatedAt = tick
						current = errorResults
					}
					manager.ProcessEvalResults(ctx, tick, &rule, current, nil, nil)
				}
			}
		})
	}
}
