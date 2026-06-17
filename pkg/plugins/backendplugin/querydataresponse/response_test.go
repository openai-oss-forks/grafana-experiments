package querydataresponse

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/stretchr/testify/require"
)

func TestNewGroupsProxiedHeadersByRefID(t *testing.T) {
	response := backend.NewQueryDataResponse()
	for refID, value := range map[string]string{"A": "cache-hit", "B": "proxy-hit"} {
		frame := data.NewFrame("")
		frame.Meta = &data.FrameMeta{Custom: map[string]any{
			MetadataKey: http.Header{"X-Trickster-Result": {value}},
		}}
		response.Responses[refID] = backend.DataResponse{Frames: data.Frames{frame}}
	}

	encoded, err := json.Marshal(New(response))
	require.NoError(t, err)

	var decoded struct {
		Results                map[string]json.RawMessage `json:"results"`
		ProxiedUpstreamHeaders ProxiedUpstreamHeaders     `json:"proxied_upstream_headers"`
	}
	require.NoError(t, json.Unmarshal(encoded, &decoded))
	require.Equal(t, "cache-hit", decoded.ProxiedUpstreamHeaders["A"]["X-Trickster-Result"])
	require.Equal(t, "proxy-hit", decoded.ProxiedUpstreamHeaders["B"]["X-Trickster-Result"])
	require.NotContains(t, string(decoded.Results["A"]), MetadataKey)
	require.NotContains(t, string(decoded.Results["B"]), MetadataKey)
}
