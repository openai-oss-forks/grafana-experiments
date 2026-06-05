// Package intervalv2 partially copied from https://github.com/grafana/grafana/blob/main/pkg/tsdb/intervalv2/intervalv2.go
package intervalv2

import (
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/gtime"
)

var (
	DefaultRes         int64 = 1500
	defaultMinInterval       = time.Millisecond * 1
)

type Interval struct {
	Text  string
	Value time.Duration
}

type intervalCalculator struct {
	minInterval               time.Duration
	tshirtSizeStepSizeEnabled bool
}

type Calculator interface {
	Calculate(timerange backend.TimeRange, minInterval time.Duration, maxDataPoints int64) Interval
	CalculateSafeInterval(timerange backend.TimeRange, resolution int64) Interval
	TshirtSizeStepSizeEnabled() bool
}

type CalculatorOptions struct {
	MinInterval               time.Duration
	TshirtSizeStepSizeEnabled bool
}

func NewCalculator(opts ...CalculatorOptions) *intervalCalculator {
	calc := &intervalCalculator{}

	for _, o := range opts {
		if o.MinInterval == 0 {
			calc.minInterval = defaultMinInterval
		} else {
			calc.minInterval = o.MinInterval
		}
		calc.tshirtSizeStepSizeEnabled = o.TshirtSizeStepSizeEnabled
	}

	return calc
}

func (ic *intervalCalculator) TshirtSizeStepSizeEnabled() bool {
	return ic.tshirtSizeStepSizeEnabled
}

func (ic *intervalCalculator) Calculate(timerange backend.TimeRange, minInterval time.Duration, maxDataPoints int64) Interval {
	if !ic.tshirtSizeStepSizeEnabled {
		return calculateResolutionBasedInterval(timerange, minInterval, maxDataPoints)
	}

	calculatedInterval := calculateTimeRangeInterval(timerange.To.Sub(timerange.From))

	if calculatedInterval < minInterval {
		calculatedInterval = minInterval
	}
	if calculatedInterval < ic.minInterval {
		calculatedInterval = ic.minInterval
	}

	return Interval{Text: gtime.FormatInterval(calculatedInterval), Value: calculatedInterval}
}

func calculateResolutionBasedInterval(timerange backend.TimeRange, minInterval time.Duration, maxDataPoints int64) Interval {
	resolution := maxDataPoints
	if resolution == 0 {
		resolution = DefaultRes
	}

	to := timerange.To.UnixNano()
	from := timerange.From.UnixNano()
	calculatedInterval := time.Duration((to - from) / resolution)
	if calculatedInterval < minInterval {
		return Interval{Text: gtime.FormatInterval(minInterval), Value: minInterval}
	}

	rounded := gtime.RoundInterval(calculatedInterval)
	return Interval{Text: gtime.FormatInterval(rounded), Value: rounded}
}

func (ic *intervalCalculator) CalculateSafeInterval(timerange backend.TimeRange, safeRes int64) Interval {
	to := timerange.To.UnixNano()
	from := timerange.From.UnixNano()
	safeInterval := time.Duration((to - from) / safeRes)

	rounded := gtime.RoundInterval(safeInterval)
	return Interval{Text: gtime.FormatInterval(rounded), Value: rounded}
}

func calculateTimeRangeInterval(timerange time.Duration) time.Duration {
	switch {
	case timerange <= 5*time.Minute:
		return time.Second
	case timerange <= 15*time.Minute:
		return 5 * time.Second
	case timerange <= 30*time.Minute:
		return 10 * time.Second
	case timerange <= time.Hour:
		return 20 * time.Second
	case timerange <= 4*time.Hour:
		return time.Minute
	case timerange <= 24*time.Hour:
		return 5 * time.Minute
	case timerange <= 48*time.Hour:
		return 10 * time.Minute
	case timerange <= 7*24*time.Hour:
		return time.Hour
	case timerange <= 30*24*time.Hour:
		return 4 * time.Hour
	default:
		interval := gtime.RoundInterval(timerange / time.Duration(DefaultRes))
		if interval < 4*time.Hour {
			return 4 * time.Hour
		}
		return interval
	}
}
