package state

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/benbjohnson/clock"
	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/infra/tracing"
	"github.com/grafana/grafana/pkg/services/ngalert/eval"
)

// Synthetic shapes deliberately vary field syntax and result cardinality
// independently. They are neither production rules nor a replay/distribution.
//
//nolint:gocyclo // Explicit synthetic shape and lifecycle matrix keeps controls together.
func BenchmarkTemplateShapeCycle(b *testing.B) {
	type shape struct {
		name                           string
		fields, rows, captures, labels int
		lifecycle                      string
	}
	shapes := make([]shape, 0, 19)
	for _, fields := range []int{1, 4, 7} {
		for _, rows := range []int{1, 16, 256} {
			shapes = append(shapes, shape{"labels", fields, rows, 3, 8, "warm"})
		}
	}
	shapes = append(shapes, shape{"literal", 4, 1, 3, 8, "warm"}, shape{"literal", 4, 256, 3, 8, "warm"}, shape{"long", 4, 256, 3, 8, "warm"}, shape{"values", 4, 256, 3, 8, "warm"}, shape{"labels", 4, 256, 16, 32, "warm"})
	shapes = append(shapes, shape{"unsupported", 4, 256, 3, 8, "warm"}, shape{"labels", 4, 2, 3, 8, "warm"})
	for _, life := range []string{"cold", "churn", "error"} {
		shapes = append(shapes, shape{"labels", 4, 128, 3, 8, life})
	}
	for _, shape := range shapes {
		b.Run(fmt.Sprintf("%s/fields=%d/rows=%d/captures=%d/labels=%d/%s", shape.name, shape.fields, shape.rows, shape.captures, shape.labels, shape.lifecycle), func(b *testing.B) {
			rule, result := templateFixture("empty", shape.captures)
			rule.Labels = map[string]string{"route": "synthetic"}
			rule.Annotations = map[string]string{}
			result.Instance["service"] = "worker"
			result.Instance["region"] = "west"
			for i := 3; i < shape.labels; i++ {
				result.Instance[fmt.Sprintf("dimension%d", i)] = "synthetic"
			}
			for i := 0; i < shape.fields; i++ {
				value := `{{ $labels.service }}`
				if i%2 == 1 {
					value = `{{ $labels.series }}`
				}
				switch shape.name {
				case "unsupported":
					value = `{{ printf "%s" $labels.service }}`
				case "literal":
					value = "synthetic text"
				case "long":
					if i%2 == 1 {
						value = strings.Repeat("Synthetic diagnostic text. ", 8) + `Service {{ $labels.service }} in {{ $labels.region }} on {{ $labels.series }}.`
					}
				case "values":
					if i%2 == 1 {
						value = `{{ $labels.service }} value {{ printf "%.2f" $values.A0.Value }} in {{ $labels.region }}`
					}
				}
				key := fmt.Sprintf("custom%d", i)
				if i%2 == 0 {
					rule.Labels[key] = value
				} else {
					rule.Annotations[key] = value
				}
			}
			manager := NewManager(ManagerCfg{Clock: clock.New(), Tracer: tracing.NewNoopTracerService(), Log: log.NewNopLogger()}, NewNoopPersister())
			results := make(eval.Results, shape.rows)
			for i := range results {
				results[i] = result
				results[i].Instance = result.Instance.Copy()
				results[i].Instance["series"] = strconv.Itoa(i)
			}
			errorsOnly := eval.Results{{State: eval.Error, Error: errors.New("synthetic datasource failure")}}
			ctx := context.Background()
			tick := result.EvaluatedAt
			run := func() {
				phases := 1
				if shape.lifecycle == "churn" {
					phases = 4
				}
				if shape.lifecycle == "error" {
					phases = 3
				}
				for phase := 0; phase < phases; phase++ {
					tick = tick.Add(time.Minute)
					for i := range results {
						results[i].EvaluatedAt = tick
					}
					current := results
					if shape.lifecycle == "churn" && (phase == 1 || phase == 2) {
						current = results[:shape.rows/2]
					}
					if shape.lifecycle == "error" && phase == 1 {
						errorsOnly[0].EvaluatedAt = tick
						current = errorsOnly
					}
					manager.ProcessEvalResults(ctx, tick, &rule, current, nil, nil)
				}
			}
			run()
			states := manager.GetStatesForRuleUID(ctx, 1, rule.UID)
			if len(states) != shape.rows {
				b.Fatalf("states=%d want %d", len(states), shape.rows)
			}
			for _, state := range states {
				if state.State != eval.Normal {
					b.Fatalf("unexpected state %v", state.State)
				}
				if shape.name != "literal" && state.Labels["custom0"] != "worker" {
					b.Fatal("label expansion")
				}
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if shape.lifecycle == "cold" {
					b.StopTimer()
					manager.cache = newCache()
					b.StartTimer()
				}
				run()
			}
		})
	}
}
