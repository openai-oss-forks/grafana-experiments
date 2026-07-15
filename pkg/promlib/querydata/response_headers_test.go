package querydata

import (
	"net/http"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/stretchr/testify/require"
)

func TestResponseHeadersPreserveMultipleUpstreamValues(t *testing.T) {
	headers := http.Header{}
	mergeResponseHeaders(headers, http.Header{"X-Trickster-Result": {"cache-hit"}})
	mergeResponseHeaders(headers, http.Header{"X-Trickster-Result": {"proxy-miss"}})

	response := backend.DataResponse{Frames: data.Frames{data.NewFrame("")}}
	addResponseHeadersToDataResponse(&response, headers)

	custom := response.Frames[0].Meta.Custom.(map[string]any)
	require.Equal(t, []string{"cache-hit", "proxy-miss"}, custom[proxiedUpstreamHeadersMetadataKey].(http.Header).Values("X-Trickster-Result"))
}

func TestExtractProxiedResponseHeadersOnlyAllowsTricksterPrefix(t *testing.T) {
	headers := extractProxiedResponseHeaders(http.Header{
		"X-Trickster-Result": {"cache-hit"},
		"X-Not-Proxied":      {"secret"},
		"Content-Type":       {"application/json"},
	})

	require.Equal(t, "cache-hit", headers.Get("X-Trickster-Result"))
	require.Empty(t, headers.Get("X-Not-Proxied"))
	require.Empty(t, headers.Get("Content-Type"))
}
