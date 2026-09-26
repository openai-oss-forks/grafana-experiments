package state

import (
	"context"
	"testing"
	"time"

	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/services/ngalert/state/template"
	"github.com/stretchr/testify/require"
)

func TestLabelBatchStateDifferential(t *testing.T) {
	for _, mode := range []string{"empty", "literal", "dynamic"} {
		rule, result := templateFixture(mode, 3)
		if rule.Labels == nil {
			rule.Labels = map[string]string{}
		}
		if rule.Annotations == nil {
			rule.Annotations = map[string]string{}
		}
		rule.Labels["identity"] = `{{ $labels.series }}`
		rule.Annotations["scope"] = `{{define "x"}}annotation{{end}}{{template "x"}}`
		rule.Labels["scope"] = `{{define "x"}}label{{end}}{{template "x"}}`
		rule.Annotations["broken"] = `{{`
		batch := template.NewBatch(context.Background(), rule.Title, nil)
		for i := 0; i < 20; i++ {
			result.EvaluatedAt = result.EvaluatedAt.Add(time.Millisecond * time.Duration(i%3))
			result.Instance["series"] = string(rune('a' + i))
			expected := newState(context.Background(), log.NewNopLogger(), &rule, result, nil, nil)
			actual := newStateWithTemplates(context.Background(), log.NewNopLogger(), &rule, result, nil, nil, batch)
			require.Equal(t, expected, actual)
		}
	}
}
