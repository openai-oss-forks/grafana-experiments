package v0alpha1_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkdata "github.com/grafana/grafana-plugin-sdk-go/data"
	data "github.com/grafana/grafana-plugin-sdk-go/experimental/apis/data/v0alpha1"
	query "github.com/grafana/grafana/pkg/apis/query/v0alpha1"
	"github.com/grafana/grafana/pkg/plugins/backendplugin/querydataresponse"
)

func TestQueryDataResponseGroupsProxiedHeadersByRefID(t *testing.T) {
	frame := sdkdata.NewFrame("")
	frame.Meta = &sdkdata.FrameMeta{Custom: map[string]any{
		querydataresponse.MetadataKey: http.Header{"X-Trickster-Result": {"cache-hit"}},
	}}
	response := query.NewQueryDataResponse(&backend.QueryDataResponse{Responses: backend.Responses{
		"A": {Frames: sdkdata.Frames{frame}},
	}})

	encoded, err := json.Marshal(response)
	require.NoError(t, err)
	var decoded map[string]any
	require.NoError(t, json.Unmarshal(encoded, &decoded))
	require.Equal(t, map[string]any{
		"A": map[string]any{"X-Trickster-Result": "cache-hit"},
	}, decoded["proxied_upstream_headers"])
}

func TestQueryDataResponseUnmarshalsProxiedHeaders(t *testing.T) {
	encoded := []byte(`{
		"apiVersion": "query.grafana.app/v0alpha1",
		"kind": "QueryDataResponse",
		"results": {
			"A": {
				"status": 200,
				"frames": []
			}
		},
		"proxied_upstream_headers": {
			"A": {
				"X-Trickster-Result": "cache-hit"
			}
		}
	}`)

	response := query.QueryDataResponse{}
	require.NoError(t, json.Unmarshal(encoded, &response))
	require.Equal(t, "query.grafana.app/v0alpha1", response.APIVersion)
	require.Equal(t, "QueryDataResponse", response.Kind)
	require.Contains(t, response.Responses, "A")
	require.Equal(t, "cache-hit", response.ProxiedUpstreamHeaders["A"]["X-Trickster-Result"])
}

func TestQueryDataResponseRoundTripsProxiedHeaders(t *testing.T) {
	frame := sdkdata.NewFrame("")
	frame.Meta = &sdkdata.FrameMeta{Custom: map[string]any{
		querydataresponse.MetadataKey: http.Header{"X-Trickster-Result": {"cache-hit"}},
	}}

	encoded, err := json.Marshal(query.NewQueryDataResponse(&backend.QueryDataResponse{Responses: backend.Responses{
		"A": {Frames: sdkdata.Frames{frame}},
	}}))
	require.NoError(t, err)

	response := query.QueryDataResponse{}
	require.NoError(t, json.Unmarshal(encoded, &response))
	require.Contains(t, response.Responses, "A")
	require.Equal(t, "cache-hit", response.ProxiedUpstreamHeaders["A"]["X-Trickster-Result"])
}

func TestParseQueriesIntoQueryDataRequest(t *testing.T) {
	request := []byte(`{
		"queries": [
			{
				"refId": "A",
				"datasource": {
					"type": "grafana-googlesheets-datasource",
					"uid": "b1808c48-9fc9-4045-82d7-081781f8a553"
				},
				"cacheDurationSeconds": 300,
				"spreadsheet": "spreadsheetID",
				"datasourceId": 4,
				"intervalMs": 30000,
				"maxDataPoints": 794
			},
			{
				"refId": "Z",
				"datasource": "old",
				"maxDataPoints": 10,
				"timeRange": {
					"from": "100",
					"to": "200"
				},
				"queryType": "foo"
			}
		],
		"from": "1692624667389",
		"to": "1692646267389"
	}`)

	req := &query.QueryDataRequest{}
	err := json.Unmarshal(request, req)
	require.NoError(t, err)

	require.Len(t, req.Queries, 2)
	require.Equal(t, "b1808c48-9fc9-4045-82d7-081781f8a553", req.Queries[0].Datasource.UID)
	require.Equal(t, "spreadsheetID", req.Queries[0].GetString("spreadsheet"))

	// Write the query (with additional spreadsheetID) to JSON
	out, err := json.MarshalIndent(req.Queries[0], "", "  ")
	require.NoError(t, err)

	// And read it back with standard JSON marshal functions
	query := &data.DataQuery{}
	err = json.Unmarshal(out, query)
	require.NoError(t, err)
	require.Equal(t, "spreadsheetID", query.GetString("spreadsheet"))

	// The second query has an explicit time range, and legacy datasource name
	out, err = json.MarshalIndent(req.Queries[1], "", "  ")
	require.NoError(t, err)
	// fmt.Printf("%s\n", string(out))
	require.JSONEq(t, `{
		"datasource": {
		  "type": "", ` /* NOTE! this implies legacy naming */ +`
		  "uid": "old"
		},
		"maxDataPoints": 10,
		"queryType": "foo",
		"refId": "Z",
		"timeRange": {
		  "from": "100",
		  "to": "200"
		}
	  }`, string(out))
}

func TestGetResponseCode(t *testing.T) {
	t.Run("return 200 if no errors in responses", func(t *testing.T) {
		assert.Equal(t, 200, query.GetResponseCode(&backend.QueryDataResponse{
			Responses: map[string]backend.DataResponse{
				"A": {
					Error: nil,
				},
				"B": {
					Error: nil,
				},
			},
		}))
	})
	t.Run("return 400 if there is an error in the responses but no status code", func(t *testing.T) {
		assert.Equal(t, 400, query.GetResponseCode(&backend.QueryDataResponse{
			Responses: map[string]backend.DataResponse{
				"A": {
					Error: fmt.Errorf("some wild error"),
				},
			},
		}))
	})
	t.Run("return 400 if there is a partial error but no status code", func(t *testing.T) {
		assert.Equal(t, 400, query.GetResponseCode(&backend.QueryDataResponse{
			Responses: map[string]backend.DataResponse{
				"A": {
					Error: nil,
				},
				"B": {
					Error: fmt.Errorf("some partial error"),
				},
			},
		}))
	})
}
