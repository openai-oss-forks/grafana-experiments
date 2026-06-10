package query

import (
	"github.com/grafana/grafana/pkg/apimachinery/errutil"
)

var (
	ErrNoQueriesFound           = errutil.BadRequest("query.noQueries", errutil.WithPublicMessage("No queries found")).Errorf("no queries found")
	ErrInvalidDatasourceID      = errutil.BadRequest("query.invalidDatasourceId", errutil.WithPublicMessage("Query does not contain a valid data source identifier")).Errorf("invalid data source identifier")
	ErrMissingDataSourceInfo    = errutil.BadRequest("query.missingDataSourceInfo").MustTemplate("query missing datasource info: {{ .Public.RefId }}", errutil.WithPublic("Query {{ .Public.RefId }} is missing datasource information"))
	ErrQueryParamMismatch       = errutil.BadRequest("query.headerMismatch", errutil.WithPublicMessage("The request headers point to a different plugin than is defined in the request body")).Errorf("plugin header/body mismatch")
	ErrDuplicateRefId           = errutil.BadRequest("query.duplicateRefId", errutil.WithPublicMessage("Multiple queries using the same RefId is not allowed ")).Errorf("multiple queries using the same RefId is not allowed")
	ErrInvalidStepSize          = errutil.BadRequest("query.invalidStepSize").MustTemplate("invalid stepSize: {{ .Public.StepSize }}", errutil.WithPublic("Invalid step size {{ .Public.StepSize }}"))
	ErrInvalidMinInterval       = errutil.BadRequest("query.invalidMinInterval").MustTemplate("invalid minInterval: {{ .Public.MinInterval }}", errutil.WithPublic("Invalid min interval {{ .Public.MinInterval }}"))
	ErrStepSizeBelowMinInterval = errutil.BadRequest("query.stepSizeBelowMinInterval").MustTemplate(
		"stepSize {{ .Public.StepSize }} is below minInterval {{ .Public.MinInterval }}",
		errutil.WithPublic("Step size {{ .Public.StepSize }} must be larger than or equal to min interval {{ .Public.MinInterval }}"),
	)
)
