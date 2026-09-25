package state

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"sort"
	"testing"
	"time"

	"github.com/benbjohnson/clock"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/infra/tracing"
	"github.com/grafana/grafana/pkg/services/ngalert/eval"
	"github.com/grafana/grafana/pkg/services/ngalert/models"
	"github.com/stretchr/testify/require"
)

// The reference forces construction of template data using an extra annotation
// that does not affect state identity. Removing that annotation permits a full
// comparison of transitions, notification selection, and retained cache state.
func TestTemplateDataAdvancingStateEquivalence(t *testing.T) {
	for _, mode := range []string{"empty", "literal", "dynamic", "dynamic-label", "broken"} {
		for _, errorMode := range []models.ExecutionErrorState{models.KeepLastErrState, models.ErrorErrState} {
			t.Run(fmt.Sprintf("%s/%s", mode, errorMode), func(t *testing.T) {
				rule, result := templateFixture(mode, 3)
				rule.ExecErrState = errorMode
				rule.For = time.Minute
				if mode == "broken" {
					rule.Labels = map[string]string{"route": "{{"}
					rule.Annotations = map[string]string{"summary": "{{ $labels. }}"}
				}
				referenceRule := rule
				referenceRule.Annotations = maps.Clone(rule.Annotations)
				if referenceRule.Annotations == nil {
					referenceRule.Annotations = map[string]string{}
				}
				const marker = "synthetic_reference_marker"
				referenceRule.Annotations[marker] = `{{ "constant" }}`
				makeManager := func() *Manager {
					return NewManager(ManagerCfg{Images: &NotAvailableImageService{}, Clock: clock.New(), Tracer: tracing.NewNoopTracerService(), Log: log.NewNopLogger()}, NewNoopPersister())
				}
				actual, reference := makeManager(), makeManager()
				tick := result.EvaluatedAt
				ctx := context.Background()
				clean := func(transitions StateTransitions) StateTransitions {
					for _, tr := range transitions {
						delete(tr.State.Annotations, marker)
					}
					sort.Slice(transitions, func(i, j int) bool { return transitions[i].State.CacheID < transitions[j].State.CacheID })
					return transitions
				}
				for phase := 0; phase < 7; phase++ {
					tick = tick.Add(time.Minute)
					results := eval.Results{result, result}
					for i := range results {
						results[i].Instance = data.Labels{"series": fmt.Sprint(i)}
						results[i].EvaluatedAt = tick
						if phase >= 1 && phase <= 3 {
							results[i].State = eval.Alerting
						}
					}
					if phase == 2 || phase == 3 {
						results = results[:1]
					}
					if phase == 4 {
						results = eval.Results{{State: eval.Error, Error: errors.New("synthetic error"), EvaluatedAt: tick}}
					}
					if phase == 5 {
						results = eval.Results{{State: eval.NoData, EvaluatedAt: tick}}
					}
					var gotSent, wantSent StateTransitions
					got := actual.ProcessEvalResults(ctx, tick, &rule, results, nil, func(_ context.Context, s StateTransitions) { gotSent = s })
					want := reference.ProcessEvalResults(ctx, tick, &referenceRule, results, nil, func(_ context.Context, s StateTransitions) { wantSent = s })
					require.Equal(t, clean(want), clean(got), "phase %d transitions", phase)
					require.Equal(t, clean(wantSent), clean(gotSent), "phase %d notifications", phase)
					gotCache := actual.GetStatesForRuleUID(ctx, 1, rule.UID)
					wantCache := reference.GetStatesForRuleUID(ctx, 1, rule.UID)
					for _, s := range wantCache {
						delete(s.Annotations, marker)
					}
					sort.Slice(gotCache, func(i, j int) bool { return gotCache[i].CacheID < gotCache[j].CacheID })
					sort.Slice(wantCache, func(i, j int) bool { return wantCache[i].CacheID < wantCache[j].CacheID })
					require.Equal(t, wantCache, gotCache, "phase %d cache", phase)
					switch phase {
					case 0:
						require.Len(t, gotCache, 2)
						for _, s := range gotCache {
							require.Equal(t, eval.Normal, s.State)
						}
					case 1:
						require.Len(t, gotCache, 2)
						for _, s := range gotCache {
							require.Equal(t, eval.Pending, s.State)
						}
					case 2:
						require.Len(t, gotSent, 1)
						require.Equal(t, eval.Alerting, gotSent[0].State.State)
					case 3:
						require.Len(t, gotCache, 1)
						require.Equal(t, eval.Alerting, gotCache[0].State)
						stale := 0
						for _, tr := range got {
							if tr.State.StateReason == models.StateReasonMissingSeries {
								stale++
								require.Equal(t, eval.Normal, tr.State.State)
							}
						}
						require.Equal(t, 1, stale)
					case 6:
						require.Len(t, gotCache, 2)
						for _, s := range gotCache {
							require.Equal(t, eval.Normal, s.State)
						}
					}

					if mode == "dynamic" && phase == 6 {
						require.Contains(t, gotCache[0].Annotations["summary"], fmt.Sprint(tick.Unix()))
					}
				}
			})
		}
	}
}
