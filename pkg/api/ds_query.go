package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/grafana/grafana-plugin-sdk-go/backend"

	"github.com/grafana/grafana/pkg/api/dtos"
	"github.com/grafana/grafana/pkg/api/response"
	"github.com/grafana/grafana/pkg/api/routing"
	"github.com/grafana/grafana/pkg/apimachinery/identity"
	"github.com/grafana/grafana/pkg/middleware/requestmeta"
	"github.com/grafana/grafana/pkg/services/apiserver/endpoints/request"
	contextmodel "github.com/grafana/grafana/pkg/services/contexthandler/model"
	"github.com/grafana/grafana/pkg/services/datasources"
	"github.com/grafana/grafana/pkg/services/featuremgmt"
	"github.com/grafana/grafana/pkg/services/query"
	"github.com/grafana/grafana/pkg/util/errhttp"
	"github.com/grafana/grafana/pkg/web"
)

func (hs *HTTPServer) handleQueryMetricsError(err error) *response.NormalResponse {
	if errors.Is(err, datasources.ErrDataSourceAccessDenied) {
		return response.Error(http.StatusForbidden, "Access denied to data source", err)
	}
	if errors.Is(err, datasources.ErrDataSourceNotFound) {
		return response.Error(http.StatusNotFound, "Data source not found", err)
	}

	return response.ErrOrFallback(http.StatusInternalServerError, "Query data error", err)
}

// metrics.go
func (hs *HTTPServer) getDSQueryEndpoint() web.Handler {
	//nolint:staticcheck // not yet migrated to OpenFeature
	if hs.Features.IsEnabledGlobally(featuremgmt.FlagQueryServiceRewrite) {
		// rewrite requests from /ds/query to the new query service
		namespaceMapper := request.GetNamespaceMapper(hs.Cfg)
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get(compactQueryDataHeader) == compactQueryDataVersion {
				http.Error(w, "compact-v1 is not supported by the query-service rewrite", http.StatusNotAcceptable)
				return
			}
			user, err := identity.GetRequester(r.Context())
			if err != nil || user == nil {
				errhttp.Write(r.Context(), fmt.Errorf("no user"), w)
				return
			}
			r.URL.Path = "/apis/query.grafana.app/v0alpha1/namespaces/" + namespaceMapper(user.GetOrgID()) + "/query"
			hs.clientConfigProvider.DirectlyServeHTTP(w, r)
		}
	}
	return routing.Wrap(hs.QueryMetricsV2)
}

// QueryMetricsV2 returns query metrics.
// swagger:route POST /ds/query datasources queryMetricsWithExpressions
//
// DataSource query metrics with expressions.
//
// If you are running Grafana Enterprise and have Fine-grained access control enabled
// you need to have a permission with action: `datasources:query`.
//
// Responses:
// 200: queryMetricsWithExpressionsRespons
// 207: queryMetricsWithExpressionsRespons
// 401: unauthorisedError
// 400: badRequestError
// 403: forbiddenError
// 500: internalServerError
func (hs *HTTPServer) QueryMetricsV2(c *contextmodel.ReqContext) response.Response {
	c.Resp.Header().Set("Vary", compactQueryDataHeader+", Accept-Encoding")

	reqDTO := dtos.MetricRequest{}
	if err := web.Bind(c.Req, &reqDTO); err != nil {
		return response.Error(http.StatusBadRequest, "bad request data", err)
	}
	if c.Req.Header.Get(compactQueryDataHeader) == compactQueryDataVersion && !isCompactDashboardQuery(c.Req, reqDTO) {
		err := errors.New("compact-v1 is restricted to Prometheus dashboard time-series panels")
		return response.Error(http.StatusNotAcceptable, err.Error(), err)
	}

	handleTimeInQuery := c.Req.Header.Get("X-Query-V2") == "true"

	var resp *backend.QueryDataResponse
	var err error

	hs.log.Debug("QueryMetricsV2: request received", "time_in_query", handleTimeInQuery)
	if handleTimeInQuery {
		resp, err = hs.queryDataService.QueryDataNew(c.Req.Context(), c.SignedInUser, c.SkipDSCache, reqDTO)
	} else {
		resp, err = hs.queryDataService.QueryData(c.Req.Context(), c.SignedInUser, c.SkipDSCache, reqDTO)
	}

	if err != nil {
		return hs.handleQueryMetricsError(err)
	}
	if c.Req.Header.Get(compactQueryDataHeader) == compactQueryDataVersion {
		compactResponse, err := newCompactQueryDataResponse(resp, newCompactQueryRequests(reqDTO, handleTimeInQuery))
		if errors.Is(err, errCompactQueryDataUnsupported) {
			return hs.toJsonStreamingResponse(c.Req.Context(), resp)
		}
		if errors.Is(err, errCompactQueryDataTooLarge) {
			return response.Error(http.StatusRequestEntityTooLarge, err.Error(), err)
		}
		if err != nil {
			return response.Error(http.StatusInternalServerError, "Compact query response encoding failed", err)
		}
		return compactQueryDataStreamingResponse{body: compactResponse}
	}
	return hs.toJsonStreamingResponse(c.Req.Context(), resp)
}

func isCompactDashboardQuery(req *http.Request, request dtos.MetricRequest) bool {
	if req.Header.Get(query.HeaderDashboardUID) == "" ||
		req.Header.Get(query.HeaderPanelPluginId) != "timeseries" ||
		req.Header.Get("X-Plugin-Id") != "prometheus" ||
		len(request.Queries) == 0 {
		return false
	}
	for _, target := range request.Queries {
		if target.Get("datasource").Get("type").MustString() != "prometheus" ||
			target.Get("instant").MustBool(false) ||
			target.Get("exemplar").MustBool(false) {
			return false
		}
		if rangeValue, ok := target.CheckGet("range"); ok && !rangeValue.MustBool() {
			return false
		}
		format := target.Get("format").MustString()
		if format != "" && format != "time_series" {
			return false
		}
	}
	return true
}

func (hs *HTTPServer) toJsonStreamingResponse(ctx context.Context, qdr *backend.QueryDataResponse) response.Response {
	statusCode := http.StatusOK
	for _, res := range qdr.Responses {
		if res.Error != nil {
			statusCode = http.StatusBadRequest
			break
		}
	}

	if statusCode == http.StatusBadRequest {
		// an error in the response we treat as downstream.
		requestmeta.WithDownstreamStatusSource(ctx)
	}

	return response.JSONStreaming(statusCode, qdr)
}

// swagger:parameters queryMetricsWithExpressions
type QueryMetricsWithExpressionsBodyParams struct {
	// in:body
	// required:true
	Body dtos.MetricRequest `json:"body"`
}

// swagger:response queryMetricsWithExpressionsRespons
type QueryMetricsWithExpressionsRespons struct {
	// The response message
	// in: body
	Body *backend.QueryDataResponse `json:"body"`
}
