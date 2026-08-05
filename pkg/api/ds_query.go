package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"

	"github.com/grafana/grafana/pkg/api/dtos"
	"github.com/grafana/grafana/pkg/api/response"
	"github.com/grafana/grafana/pkg/api/routing"
	"github.com/grafana/grafana/pkg/apimachinery/identity"
	"github.com/grafana/grafana/pkg/middleware/requestmeta"
	"github.com/grafana/grafana/pkg/plugins/backendplugin/querydataresponse"
	promcompact "github.com/grafana/grafana/pkg/promlib/compact"
	"github.com/grafana/grafana/pkg/services/apiserver/endpoints/request"
	"github.com/grafana/grafana/pkg/services/contexthandler"
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
			if r.Header.Get(promcompact.Header) == promcompact.Version {
				reqCtx := contexthandler.FromContext(r.Context())
				if reqCtx == nil {
					errhttp.Write(r.Context(), errors.New("missing request context"), w)
					return
				}
				hs.QueryMetricsV2(reqCtx).WriteTo(reqCtx)
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
	c.Resp.Header().Set("Vary", promcompact.Header+", Accept-Encoding")

	reqDTO := dtos.MetricRequest{}
	if err := web.Bind(c.Req, &reqDTO); err != nil {
		return response.Error(http.StatusBadRequest, "bad request data", err)
	}
	if c.Req.Header.Get(promcompact.Header) == promcompact.Version && !isCompactVisualizationQuery(c.Req, reqDTO) {
		err := errors.New("compact-v1 is restricted to supported Prometheus dashboard and Explore visualization panels")
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
	if c.Req.Header.Get(promcompact.Header) == promcompact.Version {
		compactResponse, err := promcompact.NewQueryDataResponseContext(
			c.Req.Context(),
			resp,
			toPromCompactQueryRequests(newCompactQueryRequests(reqDTO, handleTimeInQuery)),
		)
		if errors.Is(err, promcompact.ErrUnsupported) {
			hs.log.Warn(
				"Compact query response fell back to JSON",
				"reason", promcompact.UnsupportedReason(err),
				"dashboardUID", c.Req.Header.Get(query.HeaderDashboardUID),
				"dashboardTitle", c.Req.Header.Get(query.HeaderDashboardTitle),
				"panelID", c.Req.Header.Get(query.HeaderPanelID),
				"panelTitle", c.Req.Header.Get(query.HeaderPanelTitle),
				"datasourceUID", c.Req.Header.Get(query.HeaderDatasourceUID),
				"requestID", c.Req.URL.Query().Get("requestId"),
			)
			return hs.toJsonStreamingResponse(c.Req.Context(), resp)
		}
		if errors.Is(err, promcompact.ErrTooLarge) {
			return response.Error(http.StatusRequestEntityTooLarge, err.Error(), err)
		}
		if err != nil {
			return response.Error(http.StatusInternalServerError, "Compact query response encoding failed", err)
		}
		return promCompactQueryDataStreamingResponse{body: compactResponse}
	}
	return hs.toJsonStreamingResponse(c.Req.Context(), resp)
}

type promCompactQueryDataStreamingResponse struct {
	body *promcompact.QueryDataResponse
}

func (r promCompactQueryDataStreamingResponse) Status() int {
	return http.StatusOK
}

func (r promCompactQueryDataStreamingResponse) Body() []byte {
	return nil
}

func (r promCompactQueryDataStreamingResponse) WriteTo(ctx *contextmodel.ReqContext) {
	header := ctx.Resp.Header()
	header.Set("Content-Type", promcompact.MediaType)
	header.Set("Vary", promcompact.Header+", Accept-Encoding")
	ctx.Resp.WriteHeader(r.Status())

	if err := promcompact.WriteQueryDataResponse(ctx.Req.Context(), r.body, ctx.Resp); err != nil {
		ctx.Logger.Error("Error writing compact query response", "err", err)
	}
}

func toPromCompactQueryRequests(requests map[string]compactQueryRequest) map[string]promcompact.QueryRequest {
	converted := make(map[string]promcompact.QueryRequest, len(requests))
	for refID, request := range requests {
		converted[refID] = promcompact.QueryRequest{
			Start:        request.Start,
			End:          request.End,
			UTCOffsetSec: request.UTCOffsetSec,
		}
	}
	return converted
}

func isCompactVisualizationQuery(req *http.Request, request dtos.MetricRequest) bool {
	panelPluginID := req.Header.Get(query.HeaderPanelPluginId)
	isDashboard := req.Header.Get(query.HeaderDashboardUID) != ""
	isExplore := strings.HasPrefix(req.URL.Query().Get("requestId"), "explore_")
	if (!isDashboard && (!isExplore || panelPluginID != "timeseries")) ||
		(panelPluginID != "timeseries" && panelPluginID != "barchart") ||
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

	return response.JSONStreaming(statusCode, querydataresponse.New(qdr))
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
	Body querydataresponse.Response `json:"body"`
}
