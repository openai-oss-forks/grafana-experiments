package intervalv2

import (
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/stretchr/testify/assert"
)

func TestIntervalCalculator_Calculate(t *testing.T) {
	calculator := NewCalculator(CalculatorOptions{TshirtSizeStepSizeEnabled: true})

	timeNow := time.Now()

	testCases := []struct {
		name       string
		timeRange  backend.TimeRange
		resolution int64
		expected   string
	}{
		{"from 5m to now and default resolution", backend.TimeRange{From: timeNow, To: timeNow.Add(5 * time.Minute)}, 0, "1s"},
		{"from 5m to now and 500 resolution", backend.TimeRange{From: timeNow, To: timeNow.Add(5 * time.Minute)}, 500, "1s"},
		{"from 15m to now and default resolution", backend.TimeRange{From: timeNow, To: timeNow.Add(15 * time.Minute)}, 0, "5s"},
		{"from 15m to now and 100 resolution", backend.TimeRange{From: timeNow, To: timeNow.Add(15 * time.Minute)}, 100, "5s"},
		{"from 30m to now and default resolution", backend.TimeRange{From: timeNow, To: timeNow.Add(30 * time.Minute)}, 0, "10s"},
		{"from 30m to now and 3000 resolution", backend.TimeRange{From: timeNow, To: timeNow.Add(30 * time.Minute)}, 3000, "10s"},
		{"from 1h to now and default resolution", backend.TimeRange{From: timeNow, To: timeNow.Add(time.Hour)}, 0, "20s"},
		{"from 1h to now and 1000 resolution", backend.TimeRange{From: timeNow, To: timeNow.Add(time.Hour)}, 1000, "20s"},
		{"from 1d to now", backend.TimeRange{From: timeNow, To: timeNow.Add(24 * time.Hour)}, 1000, "5m"},
		{"from 2d to now", backend.TimeRange{From: timeNow, To: timeNow.Add(48 * time.Hour)}, 1000, "10m"},
		{"from 3d to now", backend.TimeRange{From: timeNow, To: timeNow.Add(72 * time.Hour)}, 1000, "1h"},
		{"from 7d to now", backend.TimeRange{From: timeNow, To: timeNow.Add(7 * 24 * time.Hour)}, 1000, "1h"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			interval := calculator.Calculate(tc.timeRange, time.Millisecond*1, tc.resolution)
			assert.Equal(t, tc.expected, interval.Text)
		})
	}
}

func TestIntervalCalculator_CalculateLegacyUsesMaxDataPoints(t *testing.T) {
	calculator := NewCalculator()
	timeNow := time.Now()
	timeRange := backend.TimeRange{From: timeNow, To: timeNow.Add(time.Hour)}

	interval := calculator.Calculate(timeRange, time.Millisecond, 60)
	assert.Equal(t, "1m", interval.Text)

	interval = calculator.Calculate(timeRange, time.Millisecond, 3600)
	assert.Equal(t, "1s", interval.Text)

	interval = calculator.Calculate(timeRange, 15*time.Second, 3600)
	assert.Equal(t, "15s", interval.Text)
}

func TestIntervalCalculator_CalculateWithOneMinuteMinimumStep(t *testing.T) {
	calculator := NewCalculator(CalculatorOptions{MinInterval: time.Minute, TshirtSizeStepSizeEnabled: true})
	timeNow := time.Now()

	interval := calculator.Calculate(backend.TimeRange{From: timeNow, To: timeNow.Add(15 * time.Minute)}, time.Millisecond, 1000)
	assert.Equal(t, "1m", interval.Text)
}

func TestIntervalCalculator_CalculateWithMinimumStep(t *testing.T) {
	calculator := NewCalculator(CalculatorOptions{MinInterval: time.Second, TshirtSizeStepSizeEnabled: true})
	timeNow := time.Now()

	interval := calculator.Calculate(backend.TimeRange{From: timeNow, To: timeNow.Add(15 * time.Minute)}, time.Millisecond, 1000)
	assert.Equal(t, "5s", interval.Text)

	interval = calculator.Calculate(backend.TimeRange{From: timeNow, To: timeNow.Add(24 * time.Hour)}, 10*time.Minute, 1000)
	assert.Equal(t, "10m", interval.Text)
}

func TestCalculateTimeRangeInterval(t *testing.T) {
	testCases := []struct {
		name      string
		timeRange time.Duration
		expected  time.Duration
	}{
		{"5m", 5 * time.Minute, time.Second},
		{"15m", 15 * time.Minute, 5 * time.Second},
		{"30m", 30 * time.Minute, 10 * time.Second},
		{"1h", time.Hour, 20 * time.Second},
		{"4h", 4 * time.Hour, time.Minute},
		{"1d", 24 * time.Hour, 5 * time.Minute},
		{"2d", 48 * time.Hour, 10 * time.Minute},
		{"3d", 72 * time.Hour, time.Hour},
		{"7d", 7 * 24 * time.Hour, time.Hour},
		{"30d", 30 * 24 * time.Hour, 4 * time.Hour},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.expected, calculateTimeRangeInterval(tc.timeRange))
		})
	}
}

func TestIntervalCalculator_CalculateSafeInterval(t *testing.T) {
	calculator := NewCalculator(CalculatorOptions{})

	timeNow := time.Now()

	testCases := []struct {
		name           string
		timeRange      backend.TimeRange
		safeResolution int64
		expected       string
	}{
		{"from 5m to now", backend.TimeRange{From: timeNow, To: timeNow.Add(5 * time.Minute)}, 11000, "20ms"},
		{"from 15m to now", backend.TimeRange{From: timeNow, To: timeNow.Add(15 * time.Minute)}, 11000, "100ms"},
		{"from 30m to now", backend.TimeRange{From: timeNow, To: timeNow.Add(30 * time.Minute)}, 11000, "200ms"},
		{"from 24h to now", backend.TimeRange{From: timeNow, To: timeNow.Add(1440 * time.Minute)}, 11000, "10s"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			interval := calculator.CalculateSafeInterval(tc.timeRange, tc.safeResolution)
			assert.Equal(t, tc.expected, interval.Text)
		})
	}
}
