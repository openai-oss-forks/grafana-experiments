package querydata

import (
	"net/http"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
)

const proxiedUpstreamHeadersMetaKey = "proxied_upstream_headers"

// proxiedResponseHeaderPrefixes lists the upstream response header families
// exposed in query result metadata. Add new prefixes here when panels need
// another family of data source response headers.
var proxiedResponseHeaderPrefixes = []string{
	"X-Trickster-",
}

type queryHTTPResponse struct {
	response backend.DataResponse
	headers  http.Header
}

func extractProxiedResponseHeaders(src http.Header) http.Header {
	dst := http.Header{}
	for name, values := range src {
		for _, prefix := range proxiedResponseHeaderPrefixes {
			if len(name) >= len(prefix) && strings.EqualFold(name[:len(prefix)], prefix) {
				for _, value := range values {
					dst.Add(name, value)
				}
				break
			}
		}
	}
	return dst
}

func mergeResponseHeaders(dst, src http.Header) {
	for name, values := range src {
		for _, value := range values {
			dst.Add(name, value)
		}
	}
}

func addResponseHeadersToDataResponse(response *backend.DataResponse, headers http.Header) {
	if len(headers) == 0 || len(response.Frames) == 0 {
		return
	}

	frame := response.Frames[0]
	if frame == nil {
		return
	}
	if frame.Meta == nil {
		frame.Meta = &data.FrameMeta{}
	}
	if frame.Meta.Custom == nil {
		frame.Meta.Custom = map[string]any{}
	}
	custom, ok := frame.Meta.Custom.(map[string]any)
	if !ok {
		return
	}
	custom[proxiedUpstreamHeadersMetaKey] = headers
}
