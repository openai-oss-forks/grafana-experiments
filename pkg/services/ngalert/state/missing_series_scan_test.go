package state

import (
	"fmt"
	"strconv"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/services/ngalert/eval"
	"github.com/grafana/grafana/pkg/services/ngalert/models"
)

func TestMissingSeriesDeletionSelection(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	rule := &models.AlertRule{OrgID: 1, UID: "synthetic", IntervalSeconds: 60}
	for _, tc := range []struct {
		name   string
		state  eval.State
		reason string
		age    time.Duration
		stale  bool
	}{
		{"current", eval.Normal, "", 0, false},
		{"nonstale normal", eval.Normal, "", time.Minute, false},
		{"nonstale alerting", eval.Alerting, "", time.Minute, false},
		{"stale normal", eval.Normal, "", 2 * time.Minute, true},
		{"stale alerting", eval.Alerting, "", 2 * time.Minute, true},
		{"nonstale pending", eval.Pending, "", time.Minute, false},
		{"stale pending error", eval.Pending, models.StateReasonError, time.Minute, true},
		{"stale pending no data", eval.Pending, models.StateReasonNoData, time.Minute, true},
		{"stale error", eval.Error, "", time.Minute, true},
		{"stale no data", eval.NoData, "", time.Minute, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			manager := &Manager{cache: newCache()}
			state := &State{OrgID: 1, AlertRuleUID: rule.UID, CacheID: 1, State: tc.state, StateReason: tc.reason, LastEvaluationTime: now.Add(-tc.age), EndsAt: now}
			fresh := &State{OrgID: 1, AlertRuleUID: rule.UID, CacheID: 2, State: eval.Normal, LastEvaluationTime: now}
			other := &State{OrgID: 1, AlertRuleUID: "other", CacheID: 3, State: eval.Normal, LastEvaluationTime: now.Add(-time.Hour)}
			manager.Put([]*State{state, fresh, other})
			transitions, stale := manager.processMissingSeriesStates(log.NewNopLogger(), now, rule, func(string) *models.Image { return nil })
			require.NotNil(t, transitions)
			if tc.age == 0 {
				require.Empty(t, transitions)
			} else {
				require.Len(t, transitions, 1)
				require.Same(t, state, transitions[0].State)
				require.Equal(t, tc.state, transitions[0].PreviousState)
				require.Equal(t, tc.reason, transitions[0].PreviousStateReason)
			}
			if tc.stale {
				require.Equal(t, 1, stale)
				require.Equal(t, eval.Normal, state.State)
				require.Equal(t, models.StateReasonMissingSeries, state.StateReason)
				require.Nil(t, manager.cache.get(1, rule.UID, 1))
			} else {
				require.Zero(t, stale)
				require.Same(t, state, manager.cache.get(1, rule.UID, 1))
				if tc.state == eval.Alerting {
					require.True(t, state.EndsAt.After(now))
				}
			}
			require.Same(t, fresh, manager.cache.get(1, rule.UID, 2))
			require.Same(t, other, manager.cache.get(1, "other", 3))
		})
	}
	t.Run("empty cache", func(t *testing.T) {
		manager := &Manager{cache: newCache()}
		transitions, stale := manager.processMissingSeriesStates(log.NewNopLogger(), now, rule, func(string) *models.Image { t.Fatal("unexpected image"); return nil })
		require.NotNil(t, transitions)
		require.Empty(t, transitions)
		require.Zero(t, stale)
	})
}

// One invocation scans a rule's cache without persistence, templates, history,
// notification or fixture construction. Missing states are not yet stale.
func BenchmarkMissingSeriesScan(b *testing.B) {
	for _, n := range []int{1000, 100000} {
		for _, mode := range []string{"current", "sparse", "dense"} {
			b.Run(fmt.Sprintf("states=%d/%s", n, mode), func(b *testing.B) {
				now := time.Unix(1700000000, 0).UTC()
				rule := &models.AlertRule{OrgID: 1, UID: "synthetic", IntervalSeconds: 60}
				manager := &Manager{cache: newCache()}
				expected := 0
				for i := 0; i < n; i++ {
					last := now
					if mode == "dense" || mode == "sparse" && i < 2 {
						last = now.Add(-time.Minute)
						expected++
					}
					manager.Put([]*State{{OrgID: 1, AlertRuleUID: rule.UID, CacheID: data.Fingerprint(i), Labels: data.Labels{"series": strconv.Itoa(i)}, State: eval.Normal, LastEvaluationTime: last}})
				}
				logger := log.NewNopLogger()
				run := func() ([]StateTransition, int) {
					return manager.processMissingSeriesStates(logger, now, rule, func(string) *models.Image { b.Fatal("unexpected image"); return nil })
				}
				got, stale := run()
				if len(got) != expected || stale != 0 {
					b.Fatalf("got %d transitions, %d stale", len(got), stale)
				}
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					run()
				}
			})
		}
	}
}
