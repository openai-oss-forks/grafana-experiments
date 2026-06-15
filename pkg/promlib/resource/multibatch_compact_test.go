package resource

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/data"
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

func TestExecuteCompactMultiBatchStreamSendsFirstBatchBeforeFinalArrives(t *testing.T) {
	reader, writer := io.Pipe()
	res, err := New(&http.Client{Transport: compactRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{preferredMultiBatchContentType + "; version=1"}},
		Body:       reader,
	}}}, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte(`{}`)}, log.DefaultLogger)
	require.NoError(t, err)

	req := &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "api/v1/query_range",
		URL:    "/api/v1/query_range",
		Body:   []byte("query=up&start=0&end=120&step=60"),
		Headers: map[string][]string{
			"Content-Type":                      {"application/x-www-form-urlencoded"},
			"X-Grafana-Query-Format":            {"compact-v1"},
			compactMultiBatchRefIDHeader:        {"A"},
			compactMultiBatchLegendFormatHeader: {"{{job}}"},
			compactMultiBatchUTCOffsetHeader:    {"0"},
		},
	}
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

	req := &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "api/v1/query_range",
		URL:    "/api/v1/query_range",
		Body:   []byte("query=up&start=0&end=120&step=60"),
		Headers: map[string][]string{
			"Content-Type":                      {"application/x-www-form-urlencoded"},
			"X-Grafana-Query-Format":            {"compact-v1"},
			compactMultiBatchRefIDHeader:        {"A"},
			compactMultiBatchLegendFormatHeader: {"{{job}}"},
			compactMultiBatchUTCOffsetHeader:    {"0"},
		},
	}
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

	req := &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "api/v1/query_range",
		URL:    "/api/v1/query_range",
		Body:   []byte("query=up&start=0&end=120&step=60"),
		Headers: map[string][]string{
			"Accept":                              {preferredMultiBatchContentType + "; version=1, " + multiBatchContentType + "; version=1, application/jsonl"},
			"Content-Type":                        {"application/x-www-form-urlencoded"},
			"X-Grafana-Query-Format":              {"compact-v1"},
			"X-OQP-Source":                        {"grafana-prometheus"},
			compactMultiBatchRefIDHeader:          {"A"},
			compactMultiBatchLegendFormatHeader:   {"{{job}}"},
			compactMultiBatchUTCOffsetHeader:      {"0"},
			"X-Grafana-Prometheus-Unrelated-Test": {"keep"},
		},
	}
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
	require.Equal(t, "A", req.GetHTTPHeaders().Get(compactMultiBatchRefIDHeader))
	require.Equal(t, preferredMultiBatchContentType+"; version=1, "+multiBatchContentType+"; version=1, application/jsonl", forwarded.Get("Accept"))
	require.Equal(t, "application/x-www-form-urlencoded", forwarded.Get("Content-Type"))
	require.Equal(t, "grafana-prometheus", forwarded.Get("X-Oqp-Source"))
	require.Equal(t, "keep", forwarded.Get("X-Grafana-Prometheus-Unrelated-Test"))
	require.Empty(t, forwarded.Get("X-Grafana-Query-Format"))
	require.Empty(t, forwarded.Get(compactMultiBatchRefIDHeader))
	require.Empty(t, forwarded.Get(compactMultiBatchLegendFormatHeader))
	require.Empty(t, forwarded.Get(compactMultiBatchUTCOffsetHeader))
}

func TestExecuteMultiBatchStreamPassesThroughJSONLBeforeFinalArrives(t *testing.T) {
	reader, writer := io.Pipe()
	res, err := New(&http.Client{Transport: compactRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{preferredMultiBatchContentType + "; version=1"}},
		Body:       reader,
	}}}, backend.DataSourceInstanceSettings{URL: "http://prometheus", JSONData: []byte(`{}`)}, log.DefaultLogger)
	require.NoError(t, err)

	req := &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "api/v1/query_range",
		URL:    "/api/v1/query_range",
		Body:   []byte("query=up&start=0&end=120&step=60"),
		Headers: map[string][]string{
			"Content-Type": {"application/x-www-form-urlencoded"},
		},
	}
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

	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 1)}
	require.NoError(t, sendCompactDataResponseFrame(context.Background(), sender, http.StatusOK, query, merged, true))
	frame := receiveResponse(t, sender.responses)
	require.Equal(t, "MBBF", string(frame.Body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeCompactV1), frame.Body[5])
	require.Equal(t, byte(multiBatchFinalFlag), frame.Body[6]&multiBatchFinalFlag)
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

func TestSendCompactDataResponseFrameFallsBackToJSONForCompactUnsupported(t *testing.T) {
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
	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 1)}

	require.NoError(t, sendCompactDataResponseFrame(context.Background(), sender, http.StatusOK, query, response, true))
	frame := receiveResponse(t, sender.responses)
	require.Equal(t, "MBBF", string(frame.Body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeJSONL), frame.Body[5])
	require.Equal(t, byte(multiBatchFinalFlag), frame.Body[6]&multiBatchFinalFlag)
	require.Contains(t, string(frame.Body[multiBatchFrameHeaderSize:]), `"results"`)
	require.Contains(t, string(frame.Body[multiBatchFrameHeaderSize:]), `"A"`)
}

func TestSendCompactDataResponseFrameKeepsNoDataWithNoticesAsNoData(t *testing.T) {
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
	sender := recordingSender{responses: make(chan *backend.CallResourceResponse, 1)}

	require.NoError(t, sendCompactDataResponseFrame(context.Background(), sender, http.StatusOK, query, response, true))
	frame := receiveResponse(t, sender.responses)
	require.Equal(t, "MBBF", string(frame.Body[:4]))
	require.Equal(t, byte(multiBatchPayloadTypeCompactV1), frame.Body[5])
	require.Equal(t, byte(multiBatchFinalFlag), frame.Body[6]&multiBatchFinalFlag)
	require.NotContains(t, strings.ToValidUTF8(string(frame.Body), ""), "query response does not satisfy compact-v1")
	require.NotContains(t, strings.ToValidUTF8(string(frame.Body), ""), "no_data_notices")
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
