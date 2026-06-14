package resource

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
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

func TestDecodeMultiBatchPayloadRejectsZstdWithoutFrameContentSize(t *testing.T) {
	var compressed bytes.Buffer
	encoder, err := zstd.NewWriter(&compressed)
	require.NoError(t, err)
	_, err = encoder.Write([]byte(`{"status":"success"}`))
	require.NoError(t, err)
	require.NoError(t, encoder.Close())

	_, err = decodeMultiBatchPayload(multiBatchFrame{payloadEncoding: multiBatchPayloadEncodingZstd, payload: compressed.Bytes()})
	require.ErrorContains(t, err, "missing frame content size")
}

func TestReadMultiBatchFrameRejectsOversizedPayloadLength(t *testing.T) {
	header := make([]byte, multiBatchFrameHeaderSize)
	copy(header, "MBBF")
	header[4] = multiBatchVersion
	binary.BigEndian.PutUint32(header[8:12], maxMultiBatchPayloadSize+1)

	_, err := readMultiBatchFrame(bytes.NewReader(header))
	require.ErrorContains(t, err, "exceeds limit")
}

func TestSendCompactDataResponseFrameConvertsCompactUnsupportedToErrorFrame(t *testing.T) {
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
	require.Equal(t, byte(multiBatchPayloadTypeCompactV1), frame.Body[5])
	require.Equal(t, byte(multiBatchFinalFlag), frame.Body[6]&multiBatchFinalFlag)
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
