package query

import (
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/gtime"
	"github.com/grafana/grafana/pkg/apimachinery/errutil"
	"github.com/grafana/grafana/pkg/components/simplejson"
)

const (
	queryOptionsKey = "__grafanaQueryOptions"
	stepSizeKey     = "stepSize"
	minIntervalKey  = "minInterval"
)

var allowedStepSizes = map[string]time.Duration{
	"1m":  time.Minute,
	"2m":  2 * time.Minute,
	"5m":  5 * time.Minute,
	"10m": 10 * time.Minute,
	"20m": 20 * time.Minute,
	"30m": 30 * time.Minute,
	"1h":  time.Hour,
	"2h":  2 * time.Hour,
	"5h":  5 * time.Hour,
}

func validateStepSize(query *simplejson.Json) error {
	queryOptions, ok := query.CheckGet(queryOptionsKey)
	if !ok || queryOptions.Interface() == nil {
		return nil
	}

	stepJSON, ok := queryOptions.CheckGet(stepSizeKey)
	if !ok || stepJSON.Interface() == nil {
		return nil
	}

	stepSize, err := stepJSON.String()
	if err != nil || stepSize == "" {
		return ErrInvalidStepSize.Build(errutil.TemplateData{
			Public: map[string]any{
				"StepSize": stepJSON.Interface(),
			},
		})
	}

	stepDuration, ok := allowedStepSizes[stepSize]
	if !ok {
		return ErrInvalidStepSize.Build(errutil.TemplateData{
			Public: map[string]any{
				"StepSize": stepSize,
			},
		})
	}

	minInterval := queryOptions.Get(minIntervalKey).MustString("")
	if minInterval == "" {
		return nil
	}

	minDuration, err := gtime.ParseDuration(minInterval)
	if err != nil {
		return ErrInvalidMinInterval.Build(errutil.TemplateData{
			Public: map[string]any{
				"MinInterval": minInterval,
			},
		})
	}

	if stepDuration < minDuration {
		return ErrStepSizeBelowMinInterval.Build(errutil.TemplateData{
			Public: map[string]any{
				"StepSize":    stepSize,
				"MinInterval": minInterval,
			},
		})
	}

	return nil
}
