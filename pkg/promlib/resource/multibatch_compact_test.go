package resource

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/grafana/grafana-plugin-sdk-go/experimental/featuretoggles"
	"github.com/klauspost/compress/zstd"
	"github.com/stretchr/testify/require"
)

type compactRoundTripper struct {
	response *http.Response
}

func (t compactRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return t.response, nil
}

type recordingSender struct {
	responses chan *backend.CallResourceResponse
}

func (s recordingSender) Send(response *backend.CallResourceResponse) error {
	copyResponse := *response
	copyResponse.Body = append([]byte(nil), response.Body...)
	copyResponse.Headers = cloneResponseHeaders(response.Headers)
	s.responses <- &copyResponse
	return nil
}

type failingSender struct {
	responses chan *backend.CallResourceResponse
	calls     int
	failAt    int
	err       error
}

func (s *failingSender) Send(response *backend.CallResourceResponse) error {
	s.calls++
	if s.calls == s.failAt {
		return s.err
	}
	copyResponse := *response
	copyResponse.Body = append([]byte(nil), response.Body...)
	copyResponse.Headers = cloneResponseHeaders(response.Headers)
	s.responses <- &copyResponse
	return nil
}

type recordingLogger struct {
	errorMessages []string
	errorArgs     [][]interface{}
}

func (l *recordingLogger) Debug(string, ...interface{}) {}
func (l *recordingLogger) Info(string, ...interface{})  {}
func (l *recordingLogger) Warn(string, ...interface{})  {}
func (l *recordingLogger) Error(message string, args ...interface{}) {
	l.errorMessages = append(l.errorMessages, message)
	l.errorArgs = append(l.errorArgs, args)
}
func (l *recordingLogger) With(...interface{}) log.Logger         { return l }
func (l *recordingLogger) Level() log.Level                       { return log.Debug }
func (l *recordingLogger) FromContext(context.Context) log.Logger { return l }

func TestExecuteCompactMultiBatchStreamSendsFirstBatchBeforeFinalArrives(t *testing.T) {
	reader, writer := io.Pipe()
	res, err := New(&http.Client{Transport: compactRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{preferredMultiBatchContentType + "; version=1"}},
		Body:       reader,
	}}}, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte(`{}`)}, log.DefaultLogger)
	require.NoError(t, err)

	req := compactMultiBatchRequest()
	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 4)}
	done := make(chan error, 1)
	go func() {
		done <- res.ExecuteStream(context.Background(), req, sender)
	}()

	_, err = writer.Write(multiBatchResponseHeader())
	require.NoError(t, err)
	_, err = writer.Write(multiBatchPayloadFrame(multiBatchPayloadTypeJSONL, 0, multiBatchPayloadEncodingIdentity, []byte(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"api"},"values":[[0,"1"]]}]}}`)))
	require.NoError(t, err)

	first := receiveResponse(t, sender.responses)
	require.Equal(t, preferredMultiBatchContentType+"; version=1", first.Headers["Content-Type"][0])
	require.Equal(t, "MBRH", string(first.Body[:4]))
	partial := receiveResponse(t, sender.responses)
	require.Equal(t, "MBBF", string(partial.Body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeCompactV1), partial.Body[5])
	require.Zero(t, partial.Body[6]&multiBatchFinalFlag)

	select {
	case unexpected := <-sender.responses:
		t.Fatalf("sent response before final batch arrived: %#v", unexpected)
	case <-time.After(100 * time.Millisecond):
	}

	_, err = writer.Write(multiBatchPayloadFrame(multiBatchPayloadTypeJSONL, multiBatchFinalFlag, multiBatchPayloadEncodingIdentity, []byte(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"api"},"values":[[60,"2"],[120,"3"]]}]}}`)))
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	final := receiveResponse(t, sender.responses)
	require.Equal(t, "MBBF", string(final.Body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeCompactV1), final.Body[5])
	require.Equal(t, byte(multiBatchFinalFlag), final.Body[6]&multiBatchFinalFlag)
	require.NoError(t, <-done)
}

func TestExecuteCompactMultiBatchStreamDecodesZstdWithoutContentSize(t *testing.T) {
	var compressed bytes.Buffer
	encoder, err := zstd.NewWriter(&compressed)
	require.NoError(t, err)
	_, err = encoder.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`))
	require.NoError(t, err)
	require.NoError(t, encoder.Close())

	res, err := New(&http.Client{Transport: compactRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{preferredMultiBatchContentType + "; version=1"}},
		Body: io.NopCloser(bytes.NewReader(append(
			multiBatchResponseHeader(),
			multiBatchPayloadFrame(multiBatchPayloadTypeJSONL, multiBatchFinalFlag, multiBatchPayloadEncodingZstd, compressed.Bytes())...,
		))),
	}}}, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte(`{}`)}, log.DefaultLogger)
	require.NoError(t, err)

	req := compactMultiBatchRequest()
	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 4)}
	require.NoError(t, res.ExecuteStream(context.Background(), req, sender))

	first := receiveResponse(t, sender.responses)
	require.Equal(t, "MBRH", string(first.Body[:4]))
	final := receiveResponse(t, sender.responses)
	require.Equal(t, "MBBF", string(final.Body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeCompactV1), final.Body[5])
	require.Equal(t, byte(multiBatchFinalFlag), final.Body[6]&multiBatchFinalFlag)
}

func TestExecuteCompactMultiBatchStreamDoesNotForwardBrowserOnlyHeaders(t *testing.T) {
	var forwarded http.Header
	upstreamResponse := append(
		multiBatchResponseHeader(),
		multiBatchPayloadFrame(multiBatchPayloadTypeJSONL, multiBatchFinalFlag, multiBatchPayloadEncodingIdentity, []byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`))...,
	)
	finalRoundTripper := sdkhttpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		forwarded = req.Header.Clone()
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{preferredMultiBatchContentType + "; version=1"}},
			Body:       io.NopCloser(bytes.NewReader(upstreamResponse)),
		}, nil
	})
	transport := sdkhttpclient.ContextualMiddleware().CreateMiddleware(sdkhttpclient.Options{}, finalRoundTripper)
	res, err := New(&http.Client{Transport: transport}, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte(`{}`)}, log.DefaultLogger)
	require.NoError(t, err)

	req := compactMultiBatchRequest()
	req.Headers["Accept"] = []string{preferredMultiBatchContentType + "; version=1, " + multiBatchContentType + "; version=1, application/jsonl"}
	req.Headers["Accept-Encoding"] = []string{"gzip, deflate, br, zstd"}
	req.Headers["X-OQP-Source"] = []string{"grafana-prometheus"}
	req.Headers["X-OQP-Cache-Control"] = []string{"no-cache"}
	req.Headers["X-Grafana-Prometheus-Unrelated-Test"] = []string{"keep"}
	forwardPluginHeaders := sdkhttpclient.NamedMiddlewareFunc("test-forward-plugin-headers", func(opts sdkhttpclient.Options, next http.RoundTripper) http.RoundTripper {
		return sdkhttpclient.RoundTripperFunc(func(httpReq *http.Request) (*http.Response, error) {
			for key, values := range req.GetHTTPHeaders() {
				if httpReq.Header.Get(key) == "" {
					httpReq.Header[key] = values
				}
			}
			return next.RoundTrip(httpReq)
		})
	})
	ctx := sdkhttpclient.WithContextualMiddleware(context.Background(), forwardPluginHeaders)
	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 4)}
	require.NoError(t, res.ExecuteStream(ctx, req, sender))

	receiveResponse(t, sender.responses)
	receiveResponse(t, sender.responses)
	require.Equal(t, "compact-v1", req.GetHTTPHeaders().Get("X-Grafana-Query-Format"))
	require.Equal(t, preferredMultiBatchContentType+"; version=1, "+multiBatchContentType+"; version=1, application/jsonl", forwarded.Get("Accept"))
	require.Empty(t, forwarded.Get("Accept-Encoding"))
	require.Equal(t, "application/x-www-form-urlencoded", forwarded.Get("Content-Type"))
	require.Equal(t, "grafana-prometheus", forwarded.Get("X-Oqp-Source"))
	require.Equal(t, "no-cache", forwarded.Get("X-Oqp-Cache-Control"))
	require.Equal(t, "keep", forwarded.Get("X-Grafana-Prometheus-Unrelated-Test"))
	require.Empty(t, forwarded.Get("X-Grafana-Query-Format"))
}

func TestExecuteCompactMultiBatchStreamUsesGoManagedGzipForPlainJSONFallback(t *testing.T) {
	payload := []byte("{\"status\":\"success\",\"data\":{\"resultType\":\"matrix\",\"result\":[{\"metric\":{\"job\":\"api\"},\"values\":[[0,\"1\"]]}]}}")
	var upstreamAcceptEncoding string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		upstreamAcceptEncoding = req.Header.Get("Accept-Encoding")
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(upstreamAcceptEncoding, "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			writer := gzip.NewWriter(w)
			_, err := writer.Write(payload)
			require.NoError(t, err)
			require.NoError(t, writer.Close())
			return
		}

		_, err := w.Write(payload)
		require.NoError(t, err)
	}))
	defer server.Close()

	res, err := New(
		server.Client(),
		backend.DataSourceInstanceSettings{URL: server.URL, JSONData: []byte("{}")},
		log.DefaultLogger,
	)
	require.NoError(t, err)

	req := compactMultiBatchRequest()
	req.Headers["Accept-Encoding"] = []string{"gzip, deflate, br, zstd"}
	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 2)}
	require.NoError(t, res.ExecuteStream(context.Background(), req, sender))

	preamble := receiveResponse(t, sender.responses)
	final := receiveResponse(t, sender.responses)
	require.Equal(t, "gzip", upstreamAcceptEncoding)
	require.Equal(t, "MBRH", string(preamble.Body[:4]))
	require.Equal(t, "MBBF", string(final.Body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeCompactV1), final.Body[5])
	require.Equal(t, byte(multiBatchFinalFlag), final.Body[6]&multiBatchFinalFlag)
	require.Equal(t, "GQD1", string(final.Body[multiBatchFrameHeaderSize:multiBatchFrameHeaderSize+4]))
}

func TestPrometheusMultiBatchStreamUsesParsedQueryAndOnlyUpstreamPrometheusFields(t *testing.T) {
	var upstreamBody url.Values
	var upstreamHeaders http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		require.Equal(t, "/api/v1/query_range", req.URL.Path)
		require.NoError(t, req.ParseForm())
		upstreamBody = req.Form
		upstreamHeaders = req.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		_, err := w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`))
		require.NoError(t, err)
	}))
	defer server.Close()

	res, err := New(
		server.Client(),
		backend.DataSourceInstanceSettings{
			URL:      server.URL + "?custom=keep",
			JSONData: []byte(`{"queryTimeout":"30s","timeInterval":"15s"}`),
		},
		log.DefaultLogger,
	)
	require.NoError(t, err)

	req := compactMultiBatchRequest()
	req.Body = []byte(`{"from":"0","to":"120000","queries":[{"expr":"rate(up[$__interval])","range":true,"refId":"A","legendFormat":"[{{app}}] in [{{cluster_short_name}}] ➡️ [{{oai_sd_target_service}}] in [{{oai_sd_routed_to}}] via {{route_type}}","utcOffsetSec":0,"intervalMs":60000,"maxDataPoints":100}]}`)
	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 2)}
	require.NoError(t, res.ExecuteStream(context.Background(), req, sender))

	receiveResponse(t, sender.responses)
	receiveResponse(t, sender.responses)
	require.Equal(t, prometheusMultiBatchAcceptHeader, upstreamHeaders.Get("Accept"))
	require.Empty(t, upstreamHeaders.Get("X-Grafana-Query-Format"))
	require.Empty(t, upstreamHeaders.Get("X-Grafana-Prometheus-Multibatch-Legend-Format"))
	require.Equal(t, "30s", upstreamBody.Get("timeout"))
	require.Equal(t, "keep", upstreamBody.Get("custom"))
	require.NotContains(t, upstreamBody.Get("query"), "$__interval")
	require.Contains(t, upstreamBody.Get("query"), "rate(up[")
	require.NotEmpty(t, upstreamBody.Get("start"))
	require.NotEmpty(t, upstreamBody.Get("end"))
	require.NotEmpty(t, upstreamBody.Get("step"))
}

func TestPrometheusMultiBatchStreamRespectsConfiguredUpstreamGETMethod(t *testing.T) {
	var upstreamMethod string
	var upstreamQuery url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		upstreamMethod = req.Method
		upstreamQuery = req.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		_, err := w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`))
		require.NoError(t, err)
	}))
	defer server.Close()

	res, err := New(
		server.Client(),
		backend.DataSourceInstanceSettings{URL: server.URL, JSONData: []byte(`{"httpMethod":"GET","queryTimeout":"30s"}`)},
		log.DefaultLogger,
	)
	require.NoError(t, err)

	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 2)}
	require.NoError(t, res.ExecuteStream(context.Background(), compactMultiBatchRequest(), sender))
	receiveResponse(t, sender.responses)
	receiveResponse(t, sender.responses)

	require.Equal(t, http.MethodGet, upstreamMethod)
	require.Equal(t, "up", upstreamQuery.Get("query"))
	require.Equal(t, "30s", upstreamQuery.Get("timeout"))
	require.NotEmpty(t, upstreamQuery.Get("start"))
	require.NotEmpty(t, upstreamQuery.Get("end"))
	require.NotEmpty(t, upstreamQuery.Get("step"))
}

func TestPrometheusMultiBatchStreamFramesNonCompactFallbackWhenUpstreamDeclines(t *testing.T) {
	payload := []byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`)
	res, err := New(&http.Client{Transport: compactRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"application/json"}},
		Body:       io.NopCloser(bytes.NewReader(payload)),
	}}}, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte(`{}`)}, log.DefaultLogger)
	require.NoError(t, err)

	req := compactMultiBatchRequest()
	delete(req.Headers, "X-Grafana-Query-Format")
	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 2)}
	require.NoError(t, res.ExecuteStream(context.Background(), req, sender))

	response := receiveResponse(t, sender.responses)
	require.Equal(t, "MBRH", string(response.Body[:4]))
	final := response.Body[multiBatchFrameHeaderSize:]
	require.Equal(t, "MBBF", string(final[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeJSONL), final[5])
	require.Equal(t, byte(multiBatchFinalFlag), final[6]&multiBatchFinalFlag)
	require.Equal(t, payload, final[multiBatchFrameHeaderSize:])
	select {
	case extra := <-sender.responses:
		t.Fatalf("unexpected extra fallback response: %#v", extra)
	default:
	}
}

func TestPrometheusMultiBatchStreamReturnsCalculatedStepForNonCompactResponses(t *testing.T) {
	var upstreamStep string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		require.NoError(t, req.ParseForm())
		upstreamStep = req.Form.Get("step")
		w.Header().Set("Content-Type", preferredMultiBatchContentType+"; version=1")
		_, err := w.Write(append(
			multiBatchResponseHeader(),
			multiBatchPayloadFrame(
				multiBatchPayloadTypeJSONL,
				multiBatchFinalFlag,
				multiBatchPayloadEncodingIdentity,
				[]byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`),
			)...,
		))
		require.NoError(t, err)
	}))
	defer server.Close()

	cfg := backend.NewGrafanaCfg(map[string]string{
		featuretoggles.EnabledFeatures: "prometheusTshirtSizeStepSize",
	})
	res, err := New(
		server.Client(),
		backend.DataSourceInstanceSettings{URL: server.URL, JSONData: []byte(`{"timeInterval":"60s"}`)},
		log.DefaultLogger,
		cfg.FeatureToggles(),
	)
	require.NoError(t, err)

	req := structuredMultiBatchRequest()
	req.Body = []byte(`{"from":"0","to":"86400000","queries":[{"expr":"up","range":true,"refId":"A","intervalMs":60000,"maxDataPoints":1500}]}`)
	req.Headers["Accept"] = []string{prometheusMultiBatchAcceptHeader}
	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 2)}
	require.NoError(t, res.ExecuteStream(context.Background(), req, sender))

	response := receiveResponse(t, sender.responses)
	require.Equal(t, "300", upstreamStep)
	require.Equal(t, "300000", http.Header(response.Headers).Get("X-Grafana-Prometheus-Calculated-Step-Ms"))
}

func TestPrometheusMultiBatchQueryFromRequestRejectsUnsupportedEnvelopes(t *testing.T) {
	res, err := New(nil, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte(`{}`)}, log.DefaultLogger)
	require.NoError(t, err)

	testCases := map[string][]byte{
		"malformed JSON":   []byte("{"),
		"no queries":       []byte(`{"from":"0","to":"120000","queries":[]}`),
		"multiple queries": []byte(`{"from":"0","to":"120000","queries":[{"expr":"up"},{"expr":"up"}]}`),
		"instant query":    []byte(`{"from":"0","to":"120000","queries":[{"expr":"up","instant":true}]}`),
	}
	for name, body := range testCases {
		t.Run(name, func(t *testing.T) {
			req := compactMultiBatchRequest()
			req.Body = body
			_, err := res.prometheusMultiBatchQueryFromRequest(context.Background(), req)
			require.Error(t, err)
		})
	}
}

func TestExecuteStreamUsesGoManagedGzipWithoutMultiBatchAccept(t *testing.T) {
	payload := []byte("{\"status\":\"success\",\"data\":{\"resultType\":\"matrix\",\"result\":[]}}")
	var upstreamAcceptEncoding string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		upstreamAcceptEncoding = req.Header.Get("Accept-Encoding")
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(upstreamAcceptEncoding, "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			writer := gzip.NewWriter(w)
			_, err := writer.Write(payload)
			require.NoError(t, err)
			require.NoError(t, writer.Close())
			return
		}

		_, err := w.Write(payload)
		require.NoError(t, err)
	}))
	defer server.Close()

	res, err := New(
		server.Client(),
		backend.DataSourceInstanceSettings{URL: server.URL, JSONData: []byte("{}")},
		log.DefaultLogger,
	)
	require.NoError(t, err)

	req := nonCompactMultiBatchRequest()
	req.Headers["Accept"] = []string{"application/json, text/plain, */*"}
	req.Headers["Accept-Encoding"] = []string{"gzip, deflate, br, zstd"}
	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 1)}
	require.NoError(t, res.ExecuteStream(context.Background(), req, sender))

	response := receiveResponse(t, sender.responses)
	require.Equal(t, "gzip", upstreamAcceptEncoding)
	require.Equal(t, "application/json", http.Header(response.Headers).Get("Content-Type"))
	require.Equal(t, payload, response.Body)
}

func TestExecuteMultiBatchStreamPassesThroughJSONLBeforeFinalArrives(t *testing.T) {
	reader, writer := io.Pipe()
	res, err := New(&http.Client{Transport: compactRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Content-Type":     []string{preferredMultiBatchContentType + "; version=1"},
			"Content-Encoding": []string{"gzip"},
		},
		Body: reader,
	}}}, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte(`{}`)}, log.DefaultLogger)
	require.NoError(t, err)

	req := compactMultiBatchRequest()
	delete(req.Headers, "X-Grafana-Query-Format")
	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 4)}
	done := make(chan error, 1)
	go func() {
		done <- res.ExecuteStream(context.Background(), req, sender)
	}()

	partialPayload := []byte(`{"type":"schema","frame":"series:1","columns":[{"name":"time","type":"time"},{"name":"value","type":"number","labels":{"job":"api"}}]}` + "\n" +
		`{"type":"data","frame":"series:1","data":["2026-06-07T19:20:00Z","1"]}` + "\n")
	_, err = writer.Write(append(multiBatchResponseHeader(), multiBatchPayloadFrame(multiBatchPayloadTypeJSONL, 0, multiBatchPayloadEncodingIdentity, partialPayload)...))
	require.NoError(t, err)

	partial := receiveResponse(t, sender.responses)
	require.Equal(t, preferredMultiBatchContentType+"; version=1", partial.Headers["Content-Type"][0])
	require.Empty(t, http.Header(partial.Headers).Get("Content-Encoding"))
	require.GreaterOrEqual(t, len(partial.Body), 24)
	require.Equal(t, "MBRH", string(partial.Body[:4]))
	require.Equal(t, "MBBF", string(partial.Body[12:16]))
	require.Equal(t, byte(multiBatchPayloadTypeJSONL), partial.Body[17])
	require.Zero(t, partial.Body[18]&multiBatchFinalFlag)

	select {
	case unexpected := <-sender.responses:
		t.Fatalf("sent response before final batch arrived: %#v", unexpected)
	case <-time.After(100 * time.Millisecond):
	}

	finalPayload := []byte(`{"type":"data","frame":"series:1","data":["2026-06-07T19:21:00Z","2"]}` + "\n")
	_, err = writer.Write(multiBatchPayloadFrame(multiBatchPayloadTypeJSONL, multiBatchFinalFlag, multiBatchPayloadEncodingIdentity, finalPayload))
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	final := receiveResponse(t, sender.responses)
	require.Equal(t, "MBBF", string(final.Body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeJSONL), final.Body[5])
	require.Equal(t, byte(multiBatchFinalFlag), final.Body[6]&multiBatchFinalFlag)
	require.NoError(t, <-done)
}

func TestExecuteMultiBatchStreamFramesReadErrorAfterResponseStart(t *testing.T) {
	logger := &recordingLogger{}
	firstPayload := []byte("{\"type\":\"status\",\"frame\":\"main\",\"data\":{\"isIncomplete\":true}}\n")
	upstreamBody := append(
		multiBatchResponseHeader(),
		multiBatchPayloadFrame(multiBatchPayloadTypeJSONL, 0, multiBatchPayloadEncodingIdentity, firstPayload)...,
	)
	upstreamBody = append(upstreamBody, []byte("{\"statusCode\":500,\"message\":\"raw error\"}")...)
	res, err := New(&http.Client{Transport: compactRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {preferredMultiBatchContentType + "; version=1"}},
		Body:       io.NopCloser(bytes.NewReader(upstreamBody)),
	}}}, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte("{}")}, logger)
	require.NoError(t, err)

	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 2)}
	require.NoError(t, res.ExecuteStream(context.Background(), nonCompactMultiBatchRequest(), sender))

	first := receiveResponse(t, sender.responses)
	final := receiveResponse(t, sender.responses)
	require.Equal(t, "MBRH", string(first.Body[:4]))
	require.Equal(t, "MBBF", string(first.Body[12:16]))
	requireFinalJSONLErrorFrame(t, final)
	require.NotContains(t, string(final.Body), "raw error")
	require.Len(t, logger.errorMessages, 1)
	require.Equal(t, "Failed to stream Prometheus multi-batch response", logger.errorMessages[0])
	loggedErr, ok := logger.errorArgs[0][1].(error)
	require.True(t, ok)
	require.ErrorContains(t, loggedErr, "invalid Prometheus multi-batch frame magic")
}

func TestExecuteMultiBatchStreamWrapsPlainJSONFallback(t *testing.T) {
	payload := []byte(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"api"},"values":[[0,"1"]]}]}}`)
	res, err := New(&http.Client{Transport: compactRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Content-Type":     {"application/json"},
			"Content-Length":   {"999"},
			"Content-Encoding": {"gzip"},
		},
		Body: io.NopCloser(bytes.NewReader(payload)),
	}}}, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte(`{}`)}, log.DefaultLogger)
	require.NoError(t, err)

	req := &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "api/v1/query_range",
		URL:    "/api/v1/query_range",
		Body:   []byte("query=up&start=0&end=120&step=60"),
		Headers: map[string][]string{
			"Accept":       {preferredMultiBatchContentType + "; version=1, " + multiBatchContentType + "; version=1, application/jsonl"},
			"Content-Type": {"application/x-www-form-urlencoded"},
		},
	}
	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 1)}
	require.NoError(t, res.ExecuteStream(context.Background(), req, sender))

	response := receiveResponse(t, sender.responses)
	responseHeaders := http.Header(response.Headers)
	require.Equal(t, preferredMultiBatchContentType+"; version=1", responseHeaders.Get("Content-Type"))
	require.Equal(t, "no-store", responseHeaders.Get("Cache-Control"))
	require.Empty(t, responseHeaders.Get("Content-Length"))
	require.Empty(t, responseHeaders.Get("Content-Encoding"))
	require.Equal(t, "MBRH", string(response.Body[:4]))
	require.Equal(t, "MBBF", string(response.Body[12:16]))
	require.Equal(t, byte(multiBatchPayloadTypeJSONL), response.Body[17])
	require.Equal(t, byte(multiBatchFinalFlag), response.Body[18]&multiBatchFinalFlag)
	payloadLength := binary.BigEndian.Uint32(response.Body[20:24])
	require.Equal(t, uint32(len(payload)), payloadLength)
	require.Equal(t, payload, response.Body[24:])
}

func TestExecuteCompactMultiBatchStreamFramesFallbackDecodeError(t *testing.T) {
	logger := &recordingLogger{}
	res, err := New(&http.Client{Transport: compactRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"application/json"}},
		Body:       io.NopCloser(strings.NewReader("not valid prometheus payload")),
	}}}, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte("{}")}, logger)
	require.NoError(t, err)

	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 2)}
	require.NoError(t, res.ExecuteStream(context.Background(), compactMultiBatchRequest(), sender))

	preamble := receiveResponse(t, sender.responses)
	final := receiveResponse(t, sender.responses)
	require.Equal(t, "MBRH", string(preamble.Body[:4]))
	requireFinalPluginErrorFrame(t, final)
	require.Len(t, logger.errorMessages, 1)
	require.Equal(t, "Failed to stream compact Prometheus multi-batch response", logger.errorMessages[0])
	require.Contains(t, logger.errorArgs[0], "error")
	loggedErr, ok := logger.errorArgs[0][1].(error)
	require.True(t, ok)
	require.ErrorContains(t, loggedErr, "decode Prometheus multi-batch JSONL event")
	require.NotContains(t, string(final.Body), "not valid prometheus payload")
}

func TestExecuteCompactMultiBatchStreamFramesMalformedUpstreamAfterPreamble(t *testing.T) {
	upstreamBody := append(multiBatchResponseHeader(), []byte("{\"statusCode\":500,\"message\":\"raw error\"}")...)
	res, err := New(&http.Client{Transport: compactRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {preferredMultiBatchContentType + "; version=1"}},
		Body:       io.NopCloser(bytes.NewReader(upstreamBody)),
	}}}, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte("{}")}, log.DefaultLogger)
	require.NoError(t, err)

	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 2)}
	require.NoError(t, res.ExecuteStream(context.Background(), compactMultiBatchRequest(), sender))

	preamble := receiveResponse(t, sender.responses)
	final := receiveResponse(t, sender.responses)
	require.Equal(t, "MBRH", string(preamble.Body[:4]))
	requireFinalPluginErrorFrame(t, final)
	require.NotContains(t, string(final.Body), "raw error")
}

func TestExecuteCompactMultiBatchStreamReturnsSenderFailure(t *testing.T) {
	senderErr := errors.New("sender failed")
	res, err := New(&http.Client{Transport: compactRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"application/json"}},
		Body:       io.NopCloser(strings.NewReader("not valid prometheus payload")),
	}}}, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte("{}")}, log.DefaultLogger)
	require.NoError(t, err)

	sender := &failingSender{
		responses: make(chan *backend.CallResourceResponse, 1),
		failAt:    2,
		err:       senderErr,
	}
	require.ErrorIs(t, res.ExecuteStream(context.Background(), compactMultiBatchRequest(), sender), senderErr)
	require.Equal(t, 2, sender.calls)
	require.Equal(t, "MBRH", string(receiveResponse(t, sender.responses).Body[:4]))
}

func TestExecuteStreamPassesPlainJSONThroughWithoutMultiBatchAccept(t *testing.T) {
	payload := []byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`)
	res, err := New(&http.Client{Transport: compactRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"application/json"}},
		Body:       io.NopCloser(bytes.NewReader(payload)),
	}}}, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte(`{}`)}, log.DefaultLogger)
	require.NoError(t, err)

	req := &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "api/v1/query_range",
		URL:    "/api/v1/query_range",
		Body:   []byte("query=up&start=0&end=120&step=60"),
		Headers: map[string][]string{
			"Accept":       {"application/json, text/plain, */*"},
			"Content-Type": {"application/x-www-form-urlencoded"},
		},
	}
	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 1)}
	require.NoError(t, res.ExecuteStream(context.Background(), req, sender))

	response := receiveResponse(t, sender.responses)
	require.Equal(t, "application/json", http.Header(response.Headers).Get("Content-Type"))
	require.Equal(t, payload, response.Body)
}

func TestExecuteStreamOscopeBackendMultiBatchMatrix(t *testing.T) {
	plainPayload := []byte(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"api"},"values":[[0,"1"],[60,"2"]]}]}}`)
	jsonlPayload := []byte(`{"type":"schema","frame":"series:1","columns":[{"name":"time","type":"time"},{"name":"value","type":"number","labels":{"job":"api"}}]}
{"type":"data","frame":"series:1","data":["2026-06-07T19:20:00Z","1"]}
`)

	zstdWithContentSizeEncoder, err := zstd.NewWriter(nil, zstd.WithSingleSegment(true))
	require.NoError(t, err)
	zstdWithContentSizePayload := zstdWithContentSizeEncoder.EncodeAll(jsonlPayload, nil)
	zstdWithContentSizeEncoder.Close()
	var zstdWithContentSizeHeader zstd.Header
	require.NoError(t, zstdWithContentSizeHeader.Decode(zstdWithContentSizePayload))
	require.True(t, zstdWithContentSizeHeader.HasFCS)

	var zstdWithoutContentSize bytes.Buffer
	zstdWithoutContentSizeEncoder, err := zstd.NewWriter(&zstdWithoutContentSize)
	require.NoError(t, err)
	_, err = zstdWithoutContentSizeEncoder.Write(jsonlPayload)
	require.NoError(t, err)
	require.NoError(t, zstdWithoutContentSizeEncoder.Close())
	var zstdWithoutContentSizeHeader zstd.Header
	require.NoError(t, zstdWithoutContentSizeHeader.Decode(zstdWithoutContentSize.Bytes()))
	require.False(t, zstdWithoutContentSizeHeader.HasFCS)

	testCases := []struct {
		name                    string
		upstreamMultiBatch      bool
		upstreamPayloadEncoding byte
		upstreamPayload         []byte
		upstreamHTTPGzip        bool
		wantPayloadEncoding     byte
		wantPayload             []byte
	}{
		{
			name:                    "multibatch type-1 identity payload passes through",
			upstreamMultiBatch:      true,
			upstreamPayloadEncoding: multiBatchPayloadEncodingIdentity,
			upstreamPayload:         jsonlPayload,
			wantPayloadEncoding:     multiBatchPayloadEncodingIdentity,
			wantPayload:             jsonlPayload,
		},
		{
			name:                    "multibatch type-1 zstd payload passes through",
			upstreamMultiBatch:      true,
			upstreamPayloadEncoding: multiBatchPayloadEncodingZstd,
			upstreamPayload:         zstdWithContentSizePayload,
			wantPayloadEncoding:     multiBatchPayloadEncodingZstd,
			wantPayload:             zstdWithContentSizePayload,
		},
		{
			name:                    "multibatch type-1 zstd payload without content size passes through",
			upstreamMultiBatch:      true,
			upstreamPayloadEncoding: multiBatchPayloadEncodingZstd,
			upstreamPayload:         zstdWithoutContentSize.Bytes(),
			wantPayloadEncoding:     multiBatchPayloadEncodingZstd,
			wantPayload:             zstdWithoutContentSize.Bytes(),
		},
		{
			name:                "plain JSON identity fallback is wrapped as final multibatch type-1",
			wantPayloadEncoding: multiBatchPayloadEncodingIdentity,
			wantPayload:         plainPayload,
		},
		{
			name:                "plain JSON gzip fallback is Go-decompressed and wrapped as final multibatch type-1",
			upstreamHTTPGzip:    true,
			wantPayloadEncoding: multiBatchPayloadEncodingIdentity,
			wantPayload:         plainPayload,
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			var upstreamHeaders http.Header
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				upstreamHeaders = req.Header.Clone()
				if testCase.upstreamMultiBatch {
					w.Header().Set("Content-Type", preferredMultiBatchContentType+"; version=1")
					_, writeErr := w.Write(append(
						multiBatchResponseHeader(),
						multiBatchPayloadFrame(
							multiBatchPayloadTypeJSONL,
							multiBatchFinalFlag,
							testCase.upstreamPayloadEncoding,
							testCase.upstreamPayload,
						)...,
					))
					require.NoError(t, writeErr)
					return
				}

				w.Header().Set("Content-Type", "application/json")
				if testCase.upstreamHTTPGzip {
					w.Header().Set("Content-Encoding", "gzip")
					writer := gzip.NewWriter(w)
					_, writeErr := writer.Write(plainPayload)
					require.NoError(t, writeErr)
					require.NoError(t, writer.Close())
					return
				}
				_, writeErr := w.Write(plainPayload)
				require.NoError(t, writeErr)
			}))
			defer server.Close()

			res, err := New(
				server.Client(),
				backend.DataSourceInstanceSettings{URL: server.URL, JSONData: []byte(`{}`)},
				log.DefaultLogger,
			)
			require.NoError(t, err)

			req := structuredMultiBatchRequest()
			req.Headers["Accept"] = []string{prometheusMultiBatchAcceptHeader}
			req.Headers["Accept-Encoding"] = []string{"gzip, deflate, br, zstd"}

			sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 4)}
			require.NoError(t, res.ExecuteStream(context.Background(), req, sender))

			responses := make([]*backend.CallResourceResponse, 0, len(sender.responses))
			for len(sender.responses) > 0 {
				responses = append(responses, <-sender.responses)
			}
			require.NotEmpty(t, responses)

			require.Equal(t, prometheusMultiBatchAcceptHeader, upstreamHeaders.Get("Accept"))
			require.Empty(t, upstreamHeaders.Get("X-Grafana-Query-Format"))
			require.Equal(t, "gzip", upstreamHeaders.Get("Accept-Encoding"))
			require.NotEqual(t, req.GetHTTPHeaders().Get("Accept-Encoding"), upstreamHeaders.Get("Accept-Encoding"))

			downstreamHeaders := http.Header(responses[0].Headers)
			require.True(t, isMultiBatchContentType(downstreamHeaders.Get("Content-Type")))
			require.Empty(t, downstreamHeaders.Get("Content-Encoding"))
			for _, response := range responses {
				require.Empty(t, http.Header(response.Headers).Get("Content-Encoding"))
			}

			var downstream bytes.Buffer
			for _, response := range responses {
				downstream.Write(response.Body)
			}
			reader := bytes.NewReader(downstream.Bytes())
			require.NoError(t, readMultiBatchResponseHeader(reader))
			responseFrame, err := readMultiBatchFrame(reader)
			require.NoError(t, err)
			require.Equal(t, byte(multiBatchPayloadTypeJSONL), responseFrame.payloadType)
			require.Equal(t, byte(multiBatchFinalFlag), responseFrame.flags&multiBatchFinalFlag)
			require.Equal(t, testCase.wantPayloadEncoding, responseFrame.payloadEncoding)
			require.Equal(t, testCase.wantPayload, responseFrame.payload)
			require.Zero(t, reader.Len())
		})
	}
}

func structuredMultiBatchRequest() *backend.CallResourceRequest {
	return &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   prometheusQueryRangePath,
		URL:    "/" + prometheusQueryRangePath,
		Body: []byte(`{
			"from":"0",
			"to":"120000",
			"queries":[{
				"expr":"up",
				"range":true,
				"refId":"A",
				"legendFormat":"{{job}}",
				"utcOffsetSec":0,
				"intervalMs":60000,
				"maxDataPoints":100
			}]
		}`),
		Headers: map[string][]string{
			"Content-Type": {"application/json"},
		},
	}
}

func compactMultiBatchRequest() *backend.CallResourceRequest {
	req := structuredMultiBatchRequest()
	req.Headers["X-Grafana-Query-Format"] = []string{"compact-v1"}
	return req
}

func TestPrometheusMultiBatchQueryFromRequestPreservesUnicodeLegendFormat(t *testing.T) {
	res, err := New(nil, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte(`{}`)}, log.DefaultLogger)
	require.NoError(t, err)
	req := compactMultiBatchRequest()
	req.Body = []byte(`{"from":"0","to":"120000","queries":[{"expr":"up","range":true,"refId":"A","legendFormat":"[{{app}}] in [{{cluster_short_name}}] ➡️ [{{oai_sd_target_service}}] in [{{oai_sd_routed_to}}] via {{route_type}}","intervalMs":60000,"maxDataPoints":100}]}`)

	query, err := res.prometheusMultiBatchQueryFromRequest(context.Background(), req)

	require.NoError(t, err)
	require.Equal(t, "[{{app}}] in [{{cluster_short_name}}] ➡️ [{{oai_sd_target_service}}] in [{{oai_sd_routed_to}}] via {{route_type}}", query.LegendFormat)
}

func TestPrometheusMultiBatchQueryFromRequestUsesNormalQueryDefaults(t *testing.T) {
	res, err := New(nil, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte(`{}`)}, log.DefaultLogger)
	require.NoError(t, err)
	req := compactMultiBatchRequest()
	req.Body = []byte(`{"from":"0","to":"120000","queries":[{"expr":"up","legendFormat":"{{job}} 100%"}]}`)

	query, err := res.prometheusMultiBatchQueryFromRequest(context.Background(), req)

	require.NoError(t, err)
	require.True(t, query.RangeQuery)
	require.Equal(t, "A", query.RefId)
	require.Equal(t, "{{job}} 100%", query.LegendFormat)
}

func nonCompactMultiBatchRequest() *backend.CallResourceRequest {
	return &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "api/v1/query_range",
		URL:    "/api/v1/query_range",
		Body:   []byte("query=up&start=0&end=120&step=60"),
		Headers: map[string][]string{
			"Content-Type": {"application/x-www-form-urlencoded"},
		},
	}
}

func requireFinalPluginErrorFrame(t *testing.T, response *backend.CallResourceResponse) {
	t.Helper()
	require.Equal(t, "MBBF", string(response.Body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeJSONL), response.Body[5])
	require.Equal(t, byte(multiBatchFinalFlag), response.Body[6]&multiBatchFinalFlag)
	payloadLength := binary.BigEndian.Uint32(response.Body[8:12])
	require.Equal(t, uint32(len(response.Body)-multiBatchFrameHeaderSize), payloadLength)

	var payload map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(response.Body[multiBatchFrameHeaderSize:], &payload))
	require.Contains(t, payload, "results")
	require.Contains(t, string(response.Body[multiBatchFrameHeaderSize:]), multiBatchPluginErrorMessage)
}

func requireFinalJSONLErrorFrame(t *testing.T, response *backend.CallResourceResponse) {
	t.Helper()
	require.Equal(t, "MBBF", string(response.Body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeJSONL), response.Body[5])
	require.Equal(t, byte(multiBatchFinalFlag), response.Body[6]&multiBatchFinalFlag)
	payloadLength := binary.BigEndian.Uint32(response.Body[8:12])
	require.Equal(t, uint32(len(response.Body)-multiBatchFrameHeaderSize), payloadLength)
	require.JSONEq(
		t,
		"{\"type\":\"error\",\"frame\":\"main\",\"message\":\""+multiBatchPluginErrorMessage+"\"}",
		strings.TrimSpace(string(response.Body[multiBatchFrameHeaderSize:])),
	)
}

func TestCompactMultiBatchJSONLDecoderKeepsSchemaAcrossBatches(t *testing.T) {
	start := time.Date(2026, 6, 7, 19, 20, 0, 0, time.UTC)
	query := compactMultiBatchQuery{
		RefID:        "A",
		Expr:         "rate(http_requests_total[5m])",
		LegendFormat: "{{job}}",
		Start:        start,
		End:          start.Add(2 * time.Minute),
		Step:         time.Minute,
	}
	decoder := newCompactMultiBatchPayloadDecoder(query, backend.StatusOK)

	first, err := decoder.decode([]byte(
		`{"type":"schema","frame":"result:0:series:1","columns":[{"name":"time","type":"time","labels":{}},{"name":"value","type":"number","labels":{"__name__":"http_requests_total","job":"api"}}]}` + "\n" +
			`{"type":"data","frame":"result:0:series:1","data":["2026-06-07T19:20:00Z","1"]}` + "\n" +
			`{"type":"data","frame":"result:0:series:1","data":["2026-06-07T19:21:00Z","2"]}` + "\n" +
			`{"type":"status","frame":"result:0:series:1","data":{"isIncomplete":true}}` + "\n",
	))
	require.NoError(t, err)

	final, err := decoder.decode([]byte(
		`{"type":"data","frame":"result:0:series:1","data":["2026-06-07T19:21:00Z","20"]}` + "\n" +
			`{"type":"data","frame":"result:0:series:1","data":["2026-06-07T19:22:00Z","3"]}` + "\n" +
			`{"type":"status","frame":"result:0:series:1","data":{"isIncomplete":false}}` + "\n",
	))
	require.NoError(t, err)

	merged := mergeDataResponses(backend.DataResponse{}, first)
	merged = mergeDataResponses(merged, final)

	require.Len(t, merged.Frames, 1)
	require.Equal(t, []time.Time{start, start.Add(time.Minute), start.Add(2 * time.Minute)}, fieldValues[time.Time](merged.Frames[0].Fields[0]))
	require.Equal(t, []float64{1, 20, 3}, fieldValues[float64](merged.Frames[0].Fields[1]))
	require.Equal(t, "api", merged.Frames[0].Fields[1].Config.DisplayNameFromDS)

	frame, err := buildCompactDataResponseFrame(context.Background(), log.NewNullLogger(), query, merged, true)
	require.NoError(t, err)
	body := multiBatchFrameBytes(frame)
	require.Equal(t, "MBBF", string(body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeCompactV1), body[5])
	require.Equal(t, byte(multiBatchFinalFlag), body[6]&multiBatchFinalFlag)
}

func TestDecodeMultiBatchPayloadUsesZstdFrameContentSize(t *testing.T) {
	encoder, err := zstd.NewWriter(nil, zstd.WithSingleSegment(true))
	require.NoError(t, err)
	payload := []byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`)
	compressed := encoder.EncodeAll(payload, nil)
	decoded, err := decodeMultiBatchPayload(multiBatchFrame{payloadEncoding: multiBatchPayloadEncodingZstd, payload: compressed})
	require.NoError(t, err)
	require.Equal(t, payload, decoded)
}

func TestDecodeMultiBatchPayloadDecodesZstdWithoutFrameContentSize(t *testing.T) {
	var compressed bytes.Buffer
	encoder, err := zstd.NewWriter(&compressed)
	require.NoError(t, err)
	payload := []byte(`{"status":"success"}`)
	_, err = encoder.Write(payload)
	require.NoError(t, err)
	require.NoError(t, encoder.Close())

	decoded, err := decodeMultiBatchPayload(multiBatchFrame{payloadEncoding: multiBatchPayloadEncodingZstd, payload: compressed.Bytes()})
	require.NoError(t, err)
	require.Equal(t, payload, decoded)
}

func TestReadMultiBatchFrameRejectsOversizedPayloadLength(t *testing.T) {
	header := make([]byte, multiBatchFrameHeaderSize)
	copy(header, "MBBF")
	header[4] = multiBatchVersion
	binary.BigEndian.PutUint32(header[8:12], maxMultiBatchPayloadSize+1)

	_, err := readMultiBatchFrame(bytes.NewReader(header))
	require.ErrorContains(t, err, "exceeds limit")
}

func TestBuildCompactDataResponseFrameFallsBackToJSONForCompactUnsupported(t *testing.T) {
	query := compactMultiBatchQuery{
		RefID:        "A",
		Start:        time.Unix(0, 0).UTC(),
		End:          time.Unix(60, 0).UTC(),
		Step:         time.Minute,
		UTCOffsetSec: 0,
	}
	response := backend.DataResponse{
		Frames: data.Frames{
			data.NewFrame(
				"unsupported",
				data.NewField(data.TimeSeriesTimeFieldName, nil, []time.Time{time.Unix(0, 0).UTC()}),
				data.NewField("value", nil, []float64{1}),
				data.NewField("extra", nil, []float64{2}),
			),
		},
		Status: backend.StatusOK,
	}
	frame, err := buildCompactDataResponseFrame(context.Background(), log.NewNullLogger(), query, response, true)
	require.NoError(t, err)
	body := multiBatchFrameBytes(frame)
	require.Equal(t, "MBBF", string(body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeJSONL), body[5])
	require.Equal(t, byte(multiBatchFinalFlag), body[6]&multiBatchFinalFlag)
	require.Contains(t, string(body[multiBatchFrameHeaderSize:]), `"results"`)
	require.Contains(t, string(body[multiBatchFrameHeaderSize:]), `"A"`)
}

func TestCompactMultiBatchPayloadDecoderTreatsPlainNonOKPayloadAsError(t *testing.T) {
	query := compactMultiBatchQuery{RefID: "A", Start: time.Unix(0, 0).UTC(), End: time.Unix(60, 0).UTC(), Step: time.Minute}
	decoder := newCompactMultiBatchPayloadDecoder(query, backend.Status(http.StatusTooManyRequests))

	response, err := decoder.decode([]byte("local_rate_limited"))
	require.NoError(t, err)
	require.Equal(t, backend.Status(http.StatusTooManyRequests), response.Status)
	require.ErrorContains(t, response.Error, "local_rate_limited")

	frame, err := buildCompactDataResponseFrame(context.Background(), log.NewNullLogger(), query, response, true)
	require.NoError(t, err)
	body := multiBatchFrameBytes(frame)
	require.Equal(t, "MBBF", string(body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeJSONL), body[5])
	require.Equal(t, byte(multiBatchFinalFlag), body[6]&multiBatchFinalFlag)
	require.Contains(t, string(body[multiBatchFrameHeaderSize:]), "local_rate_limited")
}

func TestCompactMultiBatchPayloadDecoderTreatsJSONErrorObjectAsError(t *testing.T) {
	query := compactMultiBatchQuery{RefID: "A", Start: time.Unix(0, 0).UTC(), End: time.Unix(60, 0).UTC(), Step: time.Minute}
	decoder := newCompactMultiBatchPayloadDecoder(query, backend.Status(http.StatusUnauthorized))

	response, err := decoder.decode([]byte(`{"error":{"message":"401: Unauthorized","type":"invalid_request_error"}}`))
	require.NoError(t, err)
	require.Equal(t, backend.Status(http.StatusUnauthorized), response.Status)
	require.ErrorContains(t, response.Error, "401: Unauthorized")
}

func TestBuildCompactDataResponseFrameKeepsNoDataWithNoticesAsNoData(t *testing.T) {
	query := compactMultiBatchQuery{
		RefID:        "A",
		Start:        time.Unix(0, 0).UTC(),
		End:          time.Unix(60, 0).UTC(),
		Step:         time.Minute,
		UTCOffsetSec: 0,
	}
	noDataFrame := data.NewFrame("")
	noDataFrame.Meta = &data.FrameMeta{
		Notices: []data.Notice{{
			Severity: data.NoticeSeverityWarning,
			Text:     "no data notice",
		}},
	}
	response := backend.DataResponse{
		Frames: data.Frames{noDataFrame},
		Status: backend.StatusOK,
	}
	frame, err := buildCompactDataResponseFrame(context.Background(), log.NewNullLogger(), query, response, true)
	require.NoError(t, err)
	body := multiBatchFrameBytes(frame)
	require.Equal(t, "MBBF", string(body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeCompactV1), body[5])
	require.Equal(t, byte(multiBatchFinalFlag), body[6]&multiBatchFinalFlag)
	require.NotContains(t, strings.ToValidUTF8(string(body), ""), "query response does not satisfy compact-v1")
	require.NotContains(t, strings.ToValidUTF8(string(body), ""), "no_data_notices")
}

func TestMergeDataResponsesUsesFinalBatchPrecedence(t *testing.T) {
	query := compactMultiBatchQuery{RefID: "A", Expr: "up", LegendFormat: "{{job}}", Step: time.Minute}
	cached, err := decodePrometheusPayload([]byte(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"api"},"values":[[0,"1"],[60,"2"]]}]}}`), query, backend.StatusOK)
	require.NoError(t, err)
	final, err := decodePrometheusPayload([]byte(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"api"},"values":[[60,"20"],[120,"3"]]}]}}`), query, backend.StatusOK)
	require.NoError(t, err)

	merged := mergeDataResponses(backend.DataResponse{}, cached)
	merged = mergeDataResponses(merged, final)

	require.Len(t, merged.Frames, 1)
	require.Equal(t, []time.Time{time.Unix(0, 0).UTC(), time.Unix(60, 0).UTC(), time.Unix(120, 0).UTC()}, fieldValues[time.Time](merged.Frames[0].Fields[0]))
	require.Equal(t, []float64{1, 20, 3}, fieldValues[float64](merged.Frames[0].Fields[1]))
	require.Equal(t, "api", merged.Frames[0].Fields[1].Config.DisplayNameFromDS)
}

func TestBuildCompactDataResponseFrameKeepsDistinctStreamingSeriesCompact(t *testing.T) {
	query := compactMultiBatchQuery{
		RefID:        "A",
		Expr:         "up",
		LegendFormat: "{{job}}",
		Start:        time.Unix(0, 0).UTC(),
		End:          time.Unix(120, 0).UTC(),
		Step:         time.Minute,
	}
	first, err := decodePrometheusPayload([]byte(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"api"},"values":[[0,"1"]]}]}}`), query, backend.StatusOK)
	require.NoError(t, err)
	final, err := decodePrometheusPayload([]byte(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"worker"},"values":[[60,"2"]]}]}}`), query, backend.StatusOK)
	require.NoError(t, err)

	accumulated := mergeDataResponses(backend.DataResponse{}, first)
	accumulated = mergeDataResponses(accumulated, final)
	require.Len(t, accumulated.Frames, 2)

	frame, err := buildCompactDataResponseFrame(context.Background(), log.NewNullLogger(), query, accumulated, true)
	require.NoError(t, err)
	body := multiBatchFrameBytes(frame)
	require.Equal(t, "MBBF", string(body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeCompactV1), body[5])
	require.Equal(t, byte(multiBatchFinalFlag), body[6]&multiBatchFinalFlag)
}

func TestBuildCompactDataResponseFrameLogsConflictingStreamingMetadata(t *testing.T) {
	testCases := []struct {
		name   string
		reason string
		mutate func(*data.Frame)
	}{
		{
			name:   "executed query",
			reason: "inconsistent_executed_query",
			mutate: func(frame *data.Frame) {
				frame.Meta.ExecutedQueryString = "Expr: different_query\nStep: 1m0s"
			},
		},
		{
			name:   "calculated min step",
			reason: "inconsistent_calculated_min_step",
			mutate: func(frame *data.Frame) {
				frame.Meta.Custom.(map[string]any)["calculatedMinStep"] = int64(30_000)
			},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			query := compactMultiBatchQuery{
				RefID:        "A",
				Expr:         "up",
				LegendFormat: "{{job}}",
				Start:        time.Unix(0, 0).UTC(),
				End:          time.Unix(120, 0).UTC(),
				Step:         time.Minute,
			}
			first, err := decodePrometheusPayload([]byte(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"api"},"values":[[0,"1"]]}]}}`), query, backend.StatusOK)
			require.NoError(t, err)
			final, err := decodePrometheusPayload([]byte(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"worker"},"values":[[60,"2"]]}]}}`), query, backend.StatusOK)
			require.NoError(t, err)

			accumulated := mergeDataResponses(backend.DataResponse{}, first)
			accumulated = mergeDataResponses(accumulated, final)
			testCase.mutate(accumulated.Frames[1])

			logger := &recordingLogger{}
			frame, err := buildCompactDataResponseFrame(context.Background(), logger, query, accumulated, true)
			require.NoError(t, err)

			body := multiBatchFrameBytes(frame)
			require.Equal(t, byte(multiBatchPayloadTypeJSONL), body[5])
			require.Len(t, logger.errorMessages, 1)
			require.Equal(t, "Compact multibatch response metadata disagreed across frames", logger.errorMessages[0])
			require.Contains(t, logger.errorArgs[0], testCase.reason)
		})
	}
}

func receiveResponse(t *testing.T, responses <-chan *backend.CallResourceResponse) *backend.CallResourceResponse {
	t.Helper()
	select {
	case response := <-responses:
		return response
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for resource response")
		return nil
	}
}

func cloneResponseHeaders(headers map[string][]string) map[string][]string {
	if headers == nil {
		return nil
	}
	cloned := make(map[string][]string, len(headers))
	for key, values := range headers {
		cloned[key] = append([]string(nil), values...)
	}
	return cloned
}

func fieldValues[T any](field *data.Field) []T {
	values := make([]T, 0, field.Len())
	for i := 0; i < field.Len(); i++ {
		values = append(values, field.At(i).(T))
	}
	return values
}
