package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

const (
	contentType              = "application/prometheus.multibatch; version=1"
	multiBatchMediaType      = "application/prometheus.multibatch"
	frameMagic               = "MBBF"
	frameVersion        byte = 1
	payloadTypeJSONL    byte = 1
	flagFinalBatch      byte = 1
	payloadEncodingZstd byte = 1
	defaultAddr              = ":19090"
	defaultDelay             = 10 * time.Second
)

type apiResponse struct {
	Status string       `json:"status"`
	Data   responseData `json:"data"`
}

type responseData struct {
	ResultType string         `json:"resultType"`
	Result     []matrixSeries `json:"result"`
}

type matrixSeries struct {
	Metric map[string]string `json:"metric"`
	Values [][]any           `json:"values"`
}

type modelPoint struct {
	Timestamp float64
	Values    []float64
}

func main() {
	addr := env("PROMETHEUS_MULTIBATCH_DEMO_ADDR", defaultAddr)
	delay := parseDelay(env("PROMETHEUS_MULTIBATCH_DEMO_DELAY", defaultDelay.String()))

	mux := http.NewServeMux()
	mux.HandleFunc("/-/healthy", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/api/v1/status/buildinfo", writeJSON(map[string]any{
		"status": "success",
		"data": map[string]string{
			"version": "chronosphere-multibatch-demo",
		},
	}))
	mux.HandleFunc("/api/v1/labels", writeJSON(map[string]any{
		"status": "success",
		"data": []string{
			"__name__",
			"turn_analytics.last_message_model_slug",
		},
	}))
	mux.HandleFunc("/api/v1/label/__name__/values", writeJSON(map[string]any{
		"status": "success",
		"data": []string{
			"client_turn_analytics_exchange_complete_ratio",
		},
	}))
	mux.HandleFunc("/api/v1/query", handleInstantQuery)
	mux.HandleFunc("/api/v1/query_range", func(w http.ResponseWriter, r *http.Request) {
		handleQueryRange(w, r, delay)
	})

	log.Printf("serving Prometheus multi-batch demo backend on %s with %s delay", addr, delay)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func handleQueryRange(w http.ResponseWriter, r *http.Request, delay time.Duration) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	start := parseUnixSeconds(r.Form.Get("start"), time.Now().Add(-7*24*time.Hour).Unix())
	end := parseUnixSeconds(r.Form.Get("end"), time.Now().Unix())
	step := parseStepSeconds(r.Form.Get("step"), 30*time.Minute)
	if end <= start {
		end = start + 4*float64(time.Hour/time.Second)
	}

	midpoint := start + ((end - start) / 2)
	finalMode := strings.ToLower(r.Form.Get("final"))

	first := buildRangeResponse(start, midpoint, step)
	var second apiResponse
	if finalMode == "full" {
		second = buildRangeResponse(start, end, step)
	} else {
		second = buildRangeResponse(midpoint+step, end, step)
	}

	if !clientAcceptsMultiBatch(r.Header.Get("Accept")) {
		writeResponseJSON(w, buildRangeResponse(start, end, step))
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming is not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	if err := writeResponseHeader(w, flusher); err != nil {
		log.Printf("write response header: %v", err)
		return
	}

	if err := writeFrame(w, flusher, first, 0); err != nil {
		log.Printf("write first batch: %v", err)
		return
	}
	log.Printf("sent first batch: %.0f to %.0f", start, midpoint)

	time.Sleep(delay)

	if err := writeFrame(w, flusher, second, flagFinalBatch); err != nil {
		log.Printf("write final batch: %v", err)
		return
	}
	log.Printf("sent final batch: %.0f to %.0f mode=%s", midpoint, end, defaultString(finalMode, "delta"))
}

func handleInstantQuery(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	now := float64(time.Now().Unix())
	writeResponseJSON(w, buildRangeResponse(now, now, 1))
}

func writeResponseHeader(w http.ResponseWriter, flusher http.Flusher) error {
	header := make([]byte, 12)
	copy(header[0:4], "MBRH")
	header[4] = frameVersion

	if _, err := w.Write(header); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

func writeFrame(w http.ResponseWriter, flusher http.Flusher, response apiResponse, flags byte) error {
	payload, err := json.Marshal(response)
	if err != nil {
		return err
	}
	payload = append(payload, '\n')

	encoder, err := zstd.NewWriter(nil)
	if err != nil {
		return err
	}
	compressed := encoder.EncodeAll(payload, nil)
	encoder.Close()

	if len(compressed) > math.MaxUint32 {
		return fmt.Errorf("compressed payload is too large: %d", len(compressed))
	}

	header := make([]byte, 12)
	copy(header[0:4], frameMagic)
	header[4] = frameVersion
	header[5] = payloadTypeJSONL
	header[6] = flags
	header[7] = payloadEncodingZstd
	binary.BigEndian.PutUint32(header[8:12], uint32(len(compressed)))

	if _, err := w.Write(header); err != nil {
		return err
	}
	if _, err := w.Write(compressed); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

func buildRangeResponse(start, end, step float64) apiResponse {
	points := buildModelPoints(start, end, step)
	models := []string{"gpt-5", "gpt-4.1", "gpt-4o"}
	series := make([]matrixSeries, 0, len(models))

	for modelIndex, model := range models {
		values := make([][]any, 0, len(points))
		for _, point := range points {
			values = append(values, []any{
				point.Timestamp,
				strconv.FormatFloat(point.Values[modelIndex], 'f', 4, 64),
			})
		}

		series = append(series, matrixSeries{
			Metric: map[string]string{
				"__name__":                               "client_turn_analytics_exchange_complete_ratio",
				"turn_analytics.last_message_model_slug": model,
			},
			Values: values,
		})
	}

	return apiResponse{
		Status: "success",
		Data: responseData{
			ResultType: "matrix",
			Result:     series,
		},
	}
}

func buildModelPoints(start, end, step float64) []modelPoint {
	if step <= 0 {
		step = float64((30 * time.Minute) / time.Second)
	}

	first := math.Ceil(start/step) * step
	points := make([]modelPoint, 0, int(math.Max(1, (end-first)/step))+1)
	for ts := first; ts <= end+0.001; ts += step {
		phase := ts / float64((24*time.Hour)/time.Second)
		raw := []float64{
			0.55 + 0.08*math.Sin(phase),
			0.30 + 0.05*math.Cos(phase*0.7),
			0.15 + 0.03*math.Sin(phase*1.4+1.2),
		}
		total := raw[0] + raw[1] + raw[2]
		points = append(points, modelPoint{
			Timestamp: ts,
			Values: []float64{
				raw[0] / total,
				raw[1] / total,
				raw[2] / total,
			},
		})
	}
	return points
}

func clientAcceptsMultiBatch(accept string) bool {
	for _, part := range strings.Split(accept, ",") {
		if strings.EqualFold(strings.TrimSpace(strings.Split(part, ";")[0]), multiBatchMediaType) {
			return true
		}
	}
	return false
}

func parseUnixSeconds(value string, fallback int64) float64 {
	if parsed, err := strconv.ParseFloat(value, 64); err == nil && parsed > 0 {
		return parsed
	}
	return float64(fallback)
}

func parseStepSeconds(value string, fallback time.Duration) float64 {
	if parsed, err := strconv.ParseFloat(value, 64); err == nil && parsed > 0 {
		return parsed
	}
	if parsed, err := time.ParseDuration(value); err == nil && parsed > 0 {
		return parsed.Seconds()
	}
	return fallback.Seconds()
}

func parseDelay(value string) time.Duration {
	parsed, err := time.ParseDuration(value)
	if err == nil {
		return parsed
	}
	return defaultDelay
}

func writeJSON(value any) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeResponseJSON(w, value)
	}
}

func writeResponseJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write json: %v", err)
	}
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func defaultString(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}
