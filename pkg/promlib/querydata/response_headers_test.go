package querydata

import (
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

	headersFor := func(refID string) http.Header {
		custom := queryResponse.Responses[refID].Frames[0].Meta.Custom.(map[string]any)
		return custom[proxiedUpstreamHeadersMetaKey].(http.Header)
	}

	require.Equal(t, "cache-hit", headersFor("A").Get("X-Trickster-Result"))
	require.Equal(t, "1", headersFor("A").Get("X-Trickster-Metric"))
	require.Empty(t, headersFor("A").Get("X-Not-Proxied"))
	require.Equal(t, "proxy-miss", headersFor("B").Get("X-Trickster-Result"))
}

func TestResponseHeadersPreserveMultipleUpstreamValues(t *testing.T) {
	headers := http.Header{}
	mergeResponseHeaders(headers, http.Header{"X-Trickster-Result": {"cache-hit"}})
	mergeResponseHeaders(headers, http.Header{"X-Trickster-Result": {"proxy-miss"}})

	response := backend.DataResponse{Frames: data.Frames{data.NewFrame("")}}
	addResponseHeadersToDataResponse(&response, headers)

	custom := response.Frames[0].Meta.Custom.(map[string]any)
	require.Equal(t, []string{"cache-hit", "proxy-miss"}, custom[proxiedUpstreamHeadersMetaKey].(http.Header).Values("X-Trickster-Result"))
}
