package query

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana/pkg/components/simplejson"
)

func TestValidateStepSize(t *testing.T) {
	tests := []struct {
		name    string
		query   string
		wantErr error
	}{
		{
			name:  "allows unset step size",
			query: `{"refId":"A"}`,
		},
		{
			name:    "rejects unknown step size",
			query:   `{"refId":"A","__grafanaQueryOptions":{"stepSize":"605s"}}`,
			wantErr: ErrInvalidStepSize,
		},
		{
			name:    "rejects step size below min interval",
			query:   `{"refId":"A","__grafanaQueryOptions":{"stepSize":"5m","minInterval":"10m"}}`,
			wantErr: ErrStepSizeBelowMinInterval,
		},
		{
			name:  "allows step size equal to min interval",
			query: `{"refId":"A","__grafanaQueryOptions":{"stepSize":"5m","minInterval":"5m"}}`,
		},
		{
			name:  "allows step size above min interval",
			query: `{"refId":"A","__grafanaQueryOptions":{"stepSize":"10m","minInterval":"5m"}}`,
		},
		{
			name:    "rejects invalid min interval",
			query:   `{"refId":"A","__grafanaQueryOptions":{"stepSize":"10m","minInterval":"definitely-not-an-interval"}}`,
			wantErr: ErrInvalidMinInterval,
		},
		{
			name:  "ignores plugin-owned fields with the same names",
			query: `{"refId":"A","stepSize":"605s","minInterval":"definitely-not-an-interval"}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			query, err := simplejson.NewJson([]byte(tt.query))
			require.NoError(t, err)

			err = validateStepSize(query)
			if tt.wantErr == nil {
				require.NoError(t, err)
				return
			}

			require.Error(t, err)
			require.True(t, errors.Is(err, tt.wantErr))
		})
	}
}

func TestParseMetricRequestValidatesStepSizeBeforeDatasourceLookup(t *testing.T) {
	req := metricRequestWithQueries(t, `{
		"refId": "A",
		"__grafanaQueryOptions": {
			"stepSize": "5m",
			"minInterval": "10m"
		},
		"datasource": {
			"uid": "missing-datasource",
			"type": "postgres"
		}
	}`)

	_, err := (&ServiceImpl{}).parseMetricRequest(context.Background(), nil, true, req, false)

	require.Error(t, err)
	require.True(t, errors.Is(err, ErrStepSizeBelowMinInterval))
}
