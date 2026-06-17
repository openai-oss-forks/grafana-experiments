package querydataresponse

import (
	"net/http"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
)

const MetadataKey = "proxied_upstream_headers"

type ProxiedUpstreamHeaders map[string]map[string]string

type Response struct {
	Results                backend.Responses      `json:"results"`
	ProxiedUpstreamHeaders ProxiedUpstreamHeaders `json:"proxied_upstream_headers,omitempty"`
}

func New(response *backend.QueryDataResponse) Response {
	result := Response{Results: make(backend.Responses, len(response.Responses))}
	for refID, dataResponse := range response.Responses {
		cleaned, headers := extractHeaders(dataResponse)
		result.Results[refID] = cleaned
		if len(headers) > 0 {
			if result.ProxiedUpstreamHeaders == nil {
				result.ProxiedUpstreamHeaders = ProxiedUpstreamHeaders{}
			}
			result.ProxiedUpstreamHeaders[refID] = headers
		}
	}
	return result
}

func extractHeaders(response backend.DataResponse) (backend.DataResponse, map[string]string) {
	if len(response.Frames) == 0 || response.Frames[0] == nil || response.Frames[0].Meta == nil {
		return response, nil
	}
	custom, ok := response.Frames[0].Meta.Custom.(map[string]any)
	if !ok {
		return response, nil
	}
	headers, ok := custom[MetadataKey].(http.Header)
	if !ok {
		return response, nil
	}

	values := make(map[string]string, len(headers))
	for name, headerValues := range headers {
		values[name] = strings.Join(headerValues, ", ")
	}

	frames := append(data.Frames(nil), response.Frames...)
	frame := *frames[0]
	meta := *frame.Meta
	cleanedCustom := make(map[string]any, len(custom)-1)
	for key, value := range custom {
		if key != MetadataKey {
			cleanedCustom[key] = value
		}
	}
	if len(cleanedCustom) == 0 {
		meta.Custom = nil
	} else {
		meta.Custom = cleanedCustom
	}
	frame.Meta = &meta
	frames[0] = &frame
	response.Frames = frames

	return response, values
}
