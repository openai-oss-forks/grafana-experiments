package compact

import (
	"net/http"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana/pkg/promlib/models"
)

func TestNewQueryDataResponseIgnoresUnusedCustomMetadata(t *testing.T) {
	const step = int64(1_000)
	start := time.UnixMilli(0)
	end := time.UnixMilli(step)

	timeField := data.NewField("Time", nil, []time.Time{start, end})
	timeField.Config = &data.FieldConfig{Interval: float64(step)}
	frame := data.NewFrame("A", timeField, data.NewField("Value", nil, []float64{1, 2}))
	frame.Meta = &data.FrameMeta{
		Type:        data.FrameTypeTimeSeriesMulti,
		TypeVersion: data.FrameTypeVersion{0, 1},
		Custom: map[string]any{
			"resultType":               models.ResultTypeMatrix.String(),
			"calculatedMinStep":        step,
			"proxied_upstream_headers": http.Header{"X-Trickster-Result": {"cache-hit"}},
		},
	}

	response := &backend.QueryDataResponse{Responses: backend.Responses{
		"A": {Frames: data.Frames{frame}},
	}}

	compact, err := NewQueryDataResponse(response, map[string]QueryRequest{
		"A": {Start: start, End: end},
	})

	require.NoError(t, err)
	require.NotNil(t, compact)
}
