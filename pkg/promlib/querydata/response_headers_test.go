package querydata

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/stretchr/testify/require"
)

func TestResponseHeadersAreGroupedByRefID(t *testing.T) {
	queryResponse := backend.NewQueryDataResponse()

	responses := map[string]http.Header{
		"A": {
			"X-Trickster-Result": {"cache-hit"},
			"X-Trickster-Metric": {"1"},
			"X-Not-Proxied":      {"secret"},
		},
		"B": {
			"x-trickster-result": {"proxy-miss"},
		},
	}

	for refID, headers := range responses {
		response := backend.DataResponse{Frames: data.Frames{data.NewFrame("")}}
		addResponseHeadersToDataResponse(&response, extractProxiedResponseHeaders(headers))
		queryResponse.Responses[refID] = response
	}

	encoded, err := json.Marshal(queryResponse)
	require.NoError(t, err)

	var payload struct {
		Results map[string]struct {
			Frames []struct {
				Schema struct {
					Meta struct {
						Custom struct {
							ResponseHeaders http.Header `json:"responseHeaders"`
						} `json:"custom"`
					} `json:"meta"`
				} `json:"schema"`
			} `json:"frames"`
		} `json:"results"`
	}
	require.NoError(t, json.Unmarshal(encoded, &payload))

	require.Equal(t, "cache-hit", payload.Results["A"].Frames[0].Schema.Meta.Custom.ResponseHeaders.Get("X-Trickster-Result"))
	require.Equal(t, "1", payload.Results["A"].Frames[0].Schema.Meta.Custom.ResponseHeaders.Get("X-Trickster-Metric"))
	require.Empty(t, payload.Results["A"].Frames[0].Schema.Meta.Custom.ResponseHeaders.Get("X-Not-Proxied"))
	require.Equal(t, "proxy-miss", payload.Results["B"].Frames[0].Schema.Meta.Custom.ResponseHeaders.Get("X-Trickster-Result"))
}

func TestResponseHeadersPreserveMultipleUpstreamValues(t *testing.T) {
	headers := http.Header{}
	mergeResponseHeaders(headers, http.Header{"X-Trickster-Result": {"cache-hit"}})
	mergeResponseHeaders(headers, http.Header{"X-Trickster-Result": {"proxy-miss"}})

	response := backend.DataResponse{Frames: data.Frames{data.NewFrame("")}}
	addResponseHeadersToDataResponse(&response, headers)

	custom := response.Frames[0].Meta.Custom.(map[string]any)
	require.Equal(t, []string{"cache-hit", "proxy-miss"}, custom[responseHeadersMetaKey].(http.Header).Values("X-Trickster-Result"))
}
