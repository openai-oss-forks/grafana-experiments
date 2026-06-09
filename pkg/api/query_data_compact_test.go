package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/promlib/models"
	contextmodel "github.com/grafana/grafana/pkg/services/contexthandler/model"
	"github.com/grafana/grafana/pkg/web"
)

func TestNewCompactQueryDataResponse(t *testing.T) {
	axis := compactRegularTimeAxis{Start: 0, Step: 1_000, Count: 5}
	qdr := &backend.QueryDataResponse{
		Responses: backend.Responses{
			"A": {
				Frames: data.Frames{
					newCompactTestFrame("A", axis, []int64{0, 1_000, 2_000, 3_000, 4_000}, []float64{1, 0, math.NaN(), math.Inf(1), math.Inf(-1)}),
					newCompactTestFrame("B", axis, []int64{0, 1_000, 2_000, 3_000, 4_000}, []float64{4, 5, 6, 7, 8}),
				},
			},
		},
	}
	qdr.Responses["A"].Frames[0].RefID = "A"
	qdr.Responses["A"].Frames[0].Fields[1].Labels = data.Labels{"__name__": "requests_total", "job": "api"}
	qdr.Responses["A"].Frames[0].Fields[1].Config = &data.FieldConfig{DisplayNameFromDS: "API requests"}
	setCompactTestQueryMetadata(qdr.Responses["A"].Frames[0], "Expr: requests_total\nStep: 1s", axis.Step)

	compact, err := newCompactQueryDataResponse(qdr, compactTestRequests(axis, "A"))
	require.NoError(t, err)
	require.Equal(t, []compactRegularTimeAxis{axis}, compact.Axes)

	response := decodeCompactTestResponse(t, compactResponseBody(t, compact))
	require.Equal(t, []compactRegularTimeAxis{axis}, response.Axes)
	require.Len(t, response.Results["A"].Frames, 2)
	require.Empty(t, response.Results["A"].Frames[0].Presence)
	require.Equal(t, []float64{1, 0}, response.Results["A"].Frames[0].Values[:2])
	require.True(t, math.IsNaN(response.Results["A"].Frames[0].Values[2]))
	require.True(t, math.IsInf(response.Results["A"].Frames[0].Values[3], 1))
	require.True(t, math.IsInf(response.Results["A"].Frames[0].Values[4], -1))
	require.Equal(t, "A", response.Results["A"].RefID)
	require.Equal(t, "Expr: requests_total\nStep: 1s", response.Results["A"].ExecutedQueryString)
	require.Equal(t, axis.Step, response.Results["A"].CalculatedMinStep)
	require.True(t, response.Results["A"].HasCalculatedMinStep)
	require.Equal(t, compactResultTypeMatrix, response.Results["A"].ResultType)
	require.Equal(t, compactFrameTypeTimeSeriesMulti, response.Results["A"].FrameType)
	require.Equal(t, uint16(0), response.Results["A"].FrameTypeVersionMajor)
	require.Equal(t, uint16(1), response.Results["A"].FrameTypeVersionMinor)
	require.Equal(t, "A", response.Results["A"].Frames[0].FrameName)
	require.Equal(t, "A", response.Results["A"].Frames[0].FrameRefID)
	require.Equal(t, "Value", response.Results["A"].Frames[0].ValueName)
	require.Equal(t, "API requests", response.Results["A"].Frames[0].DisplayNameFromDS)
	require.Equal(t, data.Labels{"__name__": "requests_total", "job": "api"}, response.Results["A"].Frames[0].Labels)
}

func TestCompactQueryDataResponseEncodesGapsSeparatelyFromZero(t *testing.T) {
	axis := compactRegularTimeAxis{Start: 0, Step: 1_000, Count: 5}
	frame := newCompactTestFrame("A", axis, []int64{0, 2_000, 4_000}, []float64{0, 4, 0})
	qdr := &backend.QueryDataResponse{Responses: backend.Responses{"A": {Frames: data.Frames{frame}}}}

	compact, err := newCompactQueryDataResponse(qdr, compactTestRequests(axis, "A"))
	require.NoError(t, err)
	response := decodeCompactTestResponse(t, compactResponseBody(t, compact))

	encoded := response.Results["A"].Frames[0]
	require.Equal(t, []byte{0b00010101}, encoded.Presence)
	require.Equal(t, []float64{0, 4, 0}, encoded.Values)
}

func TestCompactQueryDataResponseWireLayoutGolden(t *testing.T) {
	axis := compactRegularTimeAxis{Start: 1_000, Step: 1_000, Count: 1}
	frame := newCompactTestFrame("cpu", axis, []int64{1_000}, []float64{42})
	frame.RefID = "A"
	frame.Fields[1].Labels = data.Labels{"__name__": "cpu_total"}
	frame.Fields[1].Config = &data.FieldConfig{DisplayNameFromDS: "CPU"}
	setCompactTestQueryMetadata(frame, "Expr: cpu_total\nStep: 1s", axis.Step)
	qdr := &backend.QueryDataResponse{Responses: backend.Responses{"A": {Frames: data.Frames{frame}}}}

	compact, err := newCompactQueryDataResponse(qdr, compactTestRequests(axis, "A"))
	require.NoError(t, err)
	body := compactResponseBody(t, compact)
	expected, err := hex.DecodeString(
		"4751443101000000010000000100000008000000350000000000000000000000" +
			"e803000000000000e8030000000000000100000000000000" +
			"0000000000000000000000000100000001000000180000001900000003000000" +
			"1c00000005000000210000000300000024000000080000002c00000009000000" +
			"41457870723a206370755f746f74616c0a537465703a20317363707556616c7565" +
			"4350555f5f6e616d655f5f6370755f746f74616c000000" +
			"700000000100000000000000020000000000000001000000e803000000000000" +
			"01000100000001000100000000000000" +
			"4000000000000000010000000000000003000000010000000400000005000000" +
			"0100000000000000000000000000000006000000070000000000000000004540",
	)
	require.NoError(t, err)
	require.Equal(t, expected, body)
}

func TestCompactQueryDataResponseSupportsOneSampleAndNoData(t *testing.T) {
	axis := compactRegularTimeAxis{Start: 1_000, Step: 1_000, Count: 5}
	noData := newCompactNoDataTestFrame()
	setCompactTestQueryMetadata(noData, "Expr: absent_metric\nStep: 1s", axis.Step)
	qdr := &backend.QueryDataResponse{Responses: backend.Responses{
		"A": {Frames: data.Frames{newCompactTestFrame("A", axis, []int64{3_000}, []float64{7})}},
		"B": {Frames: data.Frames{noData}},
	}}

	compact, err := newCompactQueryDataResponse(qdr, compactTestRequests(axis, "A", "B"))
	require.NoError(t, err)
	response := decodeCompactTestResponse(t, compactResponseBody(t, compact))
	require.Equal(t, []byte{0b00000100}, response.Results["A"].Frames[0].Presence)
	require.Equal(t, []float64{7}, response.Results["A"].Frames[0].Values)
	require.Empty(t, response.Results["B"].Frames)
	require.Equal(t, "Expr: absent_metric\nStep: 1s", response.Results["B"].ExecutedQueryString)
	require.Equal(t, axis.Step, response.Results["B"].CalculatedMinStep)
}

func TestCompactQueryDataResponseEncodesQueryErrors(t *testing.T) {
	qdr := &backend.QueryDataResponse{Responses: backend.Responses{
		"A": backend.ErrDataResponse(backend.StatusTimeout, "query timed out"),
	}}

	compact, err := newCompactQueryDataResponse(qdr, nil)
	require.NoError(t, err)
	response := decodeCompactTestResponse(t, compactResponseBody(t, compact))
	require.Equal(t, backend.StatusTimeout, response.Results["A"].Status)
	require.Equal(t, "query timed out", response.Results["A"].Error)
}

func TestCompactQueryDataResponseRejectsInvalidFrames(t *testing.T) {
	axis := compactRegularTimeAxis{Start: 0, Step: 1_000, Count: 5}

	for name, frames := range map[string]data.Frames{
		"off grid":          {newCompactTestFrame("A", axis, []int64{0, 1_500}, []float64{1, 2})},
		"descending":        {newCompactTestFrame("A", axis, []int64{2_000, 1_000}, []float64{1, 2})},
		"duplicate":         {newCompactTestFrame("A", axis, []int64{0, 0}, []float64{1, 2})},
		"before axis start": {newCompactTestFrame("A", axis, []int64{-1_000}, []float64{1})},
		"after axis end":    {newCompactTestFrame("A", axis, []int64{5_000}, []float64{1})},
		"inconsistent interval": {
			newCompactTestFrame("A", axis, []int64{0}, []float64{1}),
			newCompactTestFrameWithInterval("B", axis, 2_000, []int64{0}, []float64{1}),
		},
	} {
		t.Run(name, func(t *testing.T) {
			qdr := &backend.QueryDataResponse{Responses: backend.Responses{"A": {Frames: frames}}}
			_, err := newCompactQueryDataResponse(qdr, compactTestRequests(axis, "A"))
			require.ErrorIs(t, err, errCompactQueryDataUnsupported)
		})
	}
}

func TestCompactQueryDataResponseRejectsMetadataItCannotReconstruct(t *testing.T) {
	axis := compactRegularTimeAxis{Start: 0, Step: 1_000, Count: 2}

	for name, mutate := range map[string]func(*data.Frame){
		"missing frame metadata": func(frame *data.Frame) { frame.Meta = nil },
		"wrong result type": func(frame *data.Frame) {
			frame.Meta.Custom = map[string]any{"resultType": models.ResultTypeVector.String()}
		},
		"unsupported custom metadata": func(frame *data.Frame) {
			frame.Meta.Custom = map[string]any{"resultType": models.ResultTypeMatrix.String(), "other": true}
		},
		"unsupported frame metadata": func(frame *data.Frame) { frame.Meta.Path = "/metric" },
		"unsupported time config":    func(frame *data.Frame) { frame.Fields[0].Config.Unit = "ms" },
		"unsupported value config":   func(frame *data.Frame) { frame.Fields[1].Config = &data.FieldConfig{Unit: "reqps"} },
		"invalid UTF-8 metadata":     func(frame *data.Frame) { frame.Name = string([]byte{0xff}) },
	} {
		t.Run(name, func(t *testing.T) {
			frame := newCompactTestFrame("A", axis, []int64{0, 1_000}, []float64{1, 2})
			mutate(frame)
			qdr := &backend.QueryDataResponse{Responses: backend.Responses{"A": {Frames: data.Frames{frame}}}}
			compact, err := newCompactQueryDataResponse(qdr, compactTestRequests(axis, "A"))
			require.Nil(t, compact)
			require.ErrorIs(t, err, errCompactQueryDataUnsupported)
		})
	}
}

func TestCompactQueryDataResponseRejectsInconsistentResultMetadata(t *testing.T) {
	axis := compactRegularTimeAxis{Start: 0, Step: 1_000, Count: 2}

	for name, mutate := range map[string]func(*data.Frame){
		"frame type version":            func(frame *data.Frame) { frame.Meta.TypeVersion = data.FrameTypeVersion{0, 2} },
		"executed query on later frame": func(frame *data.Frame) { frame.Meta.ExecutedQueryString = "Expr: other" },
		"calculated min step on later frame": func(frame *data.Frame) {
			frame.Meta.Custom.(map[string]any)["calculatedMinStep"] = int64(1_000)
		},
	} {
		t.Run(name, func(t *testing.T) {
			first := newCompactTestFrame("A", axis, []int64{0, 1_000}, []float64{1, 2})
			second := newCompactTestFrame("B", axis, []int64{0, 1_000}, []float64{3, 4})
			mutate(second)
			qdr := &backend.QueryDataResponse{Responses: backend.Responses{"A": {Frames: data.Frames{first, second}}}}

			compact, err := newCompactQueryDataResponse(qdr, compactTestRequests(axis, "A"))
			require.Nil(t, compact)
			require.ErrorIs(t, err, errCompactQueryDataUnsupported)
		})
	}
}

func TestCompactQueryDataResponseRejectsMalformedNoDataFrames(t *testing.T) {
	axis := compactRegularTimeAxis{Start: 0, Step: 1_000, Count: 2}
	noDataWithType := newCompactNoDataTestFrame()
	noDataWithType.Meta.Type = data.FrameTypeTimeSeriesMulti
	noDataWithResultType := newCompactNoDataTestFrame()
	noDataWithResultType.Meta.Custom = map[string]any{"resultType": models.ResultTypeMatrix.String()}
	mixedNoData := newCompactNoDataTestFrame()

	for name, frames := range map[string]data.Frames{
		"frame type without fields":  {noDataWithType},
		"result type without fields": {noDataWithResultType},
		"mixed data and no-data": {
			mixedNoData,
			newCompactTestFrame("A", axis, []int64{0, 1_000}, []float64{1, 2}),
		},
	} {
		t.Run(name, func(t *testing.T) {
			qdr := &backend.QueryDataResponse{Responses: backend.Responses{"A": {Frames: frames}}}
			compact, err := newCompactQueryDataResponse(qdr, compactTestRequests(axis, "A"))
			require.Nil(t, compact)
			require.ErrorIs(t, err, errCompactQueryDataUnsupported)
		})
	}
}

func TestCompactQueryDataResponseIsAllOrNothing(t *testing.T) {
	axis := compactRegularTimeAxis{Start: 0, Step: 1_000, Count: 2}
	valid := newCompactTestFrame("valid", axis, []int64{0, 1_000}, []float64{1, 2})
	invalid := newCompactTestFrame("invalid", axis, []int64{0, 500}, []float64{1, 2})
	qdr := &backend.QueryDataResponse{Responses: backend.Responses{
		"A": {Frames: data.Frames{valid}},
		"B": {Frames: data.Frames{invalid}},
	}}

	compact, err := newCompactQueryDataResponse(qdr, compactTestRequests(axis, "A", "B"))
	require.Nil(t, compact)
	require.ErrorIs(t, err, errCompactQueryDataUnsupported)
}

func TestCompactQueryDataResponseReducesPayloadSize(t *testing.T) {
	axis := compactRegularTimeAxis{Start: 1_780_525_920_000, Step: 60_000, Count: 61}
	timestamps := make([]int64, axis.Count)
	for i := range timestamps {
		timestamps[i] = axis.Start + int64(i)*axis.Step
	}

	frames := make(data.Frames, 8)
	for frameIndex := range frames {
		values := make([]float64, len(timestamps))
		for valueIndex := range values {
			values[valueIndex] = float64(frameIndex*len(timestamps)+valueIndex) / 7
		}
		frames[frameIndex] = newCompactTestFrame(string(rune('A'+frameIndex)), axis, timestamps, values)
	}
	qdr := &backend.QueryDataResponse{Responses: backend.Responses{"A": {Frames: frames}}}

	legacyJSON, err := json.Marshal(qdr)
	require.NoError(t, err)
	compact, err := newCompactQueryDataResponse(qdr, compactTestRequests(axis, "A"))
	require.NoError(t, err)
	compactBody := compactResponseBody(t, compact)

	require.Less(t, len(compactBody), len(legacyJSON))
	require.Less(t, len(compactBody), previousCompactV1Size(t, "A", axis, frames))
	require.Less(t, gzipSize(t, compactBody), gzipSize(t, legacyJSON))
	require.NotContains(t, string(compactBody), `"schema"`)
}

func previousCompactV1Size(t *testing.T, refID string, axis compactRegularTimeAxis, frames data.Frames) int {
	t.Helper()
	const previousResponseHeaderSize = 24
	const previousResultHeaderSize = 24
	const previousFrameHeaderSize = 24

	size := previousResponseHeaderSize + compactAxisRecordSize
	resultSize := previousResultHeaderSize + len(refID)
	resultSize += paddingTo8(resultSize)
	for _, frame := range frames {
		frameJSON, err := data.FrameToJSON(frame, data.IncludeSchemaOnly)
		require.NoError(t, err)
		schemaLength := len(frameJSON) - len(`{"schema":`) - 1
		frameSize := previousFrameHeaderSize + schemaLength
		frameSize += paddingTo8(frameSize)
		frameSize += frame.Fields[1].Len() * 8
		resultSize += frameSize
	}
	return size + resultSize
}

func TestCompactQueryDataStreamingResponse(t *testing.T) {
	const pointCount = 20_000
	axis := compactRegularTimeAxis{Start: 1_000, Step: 1_000, Count: pointCount}
	timestamps := make([]int64, pointCount)
	values := make([]float64, pointCount)
	for i := range pointCount {
		timestamps[i] = axis.Start + int64(i)*axis.Step
		values[i] = float64(i) / 7
	}
	qdr := &backend.QueryDataResponse{Responses: backend.Responses{
		"A": {Frames: data.Frames{newCompactTestFrame("A", axis, timestamps, values)}},
	}}
	compact, err := newCompactQueryDataResponse(qdr, compactTestRequests(axis, "A"))
	require.NoError(t, err)

	writer := newTrackingResponseWriter()
	req := httptest.NewRequest(http.MethodPost, "/api/ds/query", nil)
	ctx := &contextmodel.ReqContext{
		Context: &web.Context{Req: req, Resp: web.NewResponseWriter(http.MethodPost, writer)},
		Logger:  log.New("compact-query-data-test"),
	}

	compactQueryDataStreamingResponse{body: compact}.WriteTo(ctx)

	require.Equal(t, compactQueryDataMediaType, writer.header.Get("Content-Type"))
	require.Equal(t, compactQueryDataHeader+", Accept-Encoding", writer.header.Get("Vary"))
	require.Greater(t, writer.writes, 1)
	require.LessOrEqual(t, writer.maxWrite, compactWriteChunkSize)
	decodeCompactTestResponse(t, writer.body.Bytes())
}

func TestCompactQueryDataResponseStopsOnCancellation(t *testing.T) {
	axis := compactRegularTimeAxis{Start: 0, Step: 1_000, Count: 2}
	qdr := &backend.QueryDataResponse{Responses: backend.Responses{
		"A": {Frames: data.Frames{newCompactTestFrame("A", axis, []int64{0, 1_000}, []float64{1, 2})}},
	}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	compact, err := newCompactQueryDataResponseContext(ctx, qdr, compactTestRequests(axis, "A"))

	require.Nil(t, compact)
	require.ErrorIs(t, err, context.Canceled)
}

func TestCompactBinaryWriterStopsOnCancellationAndShortWrites(t *testing.T) {
	t.Run("cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		target := newTrackingResponseWriter()
		writer := compactBinaryWriter{context: ctx, writer: target}

		writer.writeBytes([]byte("value"))

		require.ErrorIs(t, writer.err, context.Canceled)
		require.Zero(t, target.writes)
	})

	t.Run("short write", func(t *testing.T) {
		writer := compactBinaryWriter{context: context.Background(), writer: shortCompactWriter{}}

		writer.writeBytes([]byte("value"))

		require.ErrorIs(t, writer.err, io.ErrShortWrite)
	})

	t.Run("frame header failure avoids value scratch", func(t *testing.T) {
		axis := compactRegularTimeAxis{Start: 0, Step: 1_000, Count: 2}
		frame := compactFrame{
			Frame:        newCompactTestFrame("A", axis, []int64{0, 1_000}, []float64{1, 2}),
			PresentCount: 2,
		}
		writer := compactBinaryWriter{context: context.Background(), writer: failingCompactWriter{}}

		writeCompactFrame(frame, &writer)

		require.Error(t, writer.err)
		require.Nil(t, writer.valueScratch)
	})
}

func TestCompactQueryDataResponseRejectsOverflowingStep(t *testing.T) {
	axis := compactRegularTimeAxis{Start: 0, Step: maxDurationMilliseconds + 1, Count: 1}
	frame := newCompactTestFrameWithInterval("A", axis, axis.Step, []int64{0}, []float64{1})
	qdr := &backend.QueryDataResponse{Responses: backend.Responses{"A": {Frames: data.Frames{frame}}}}

	compact, err := newCompactQueryDataResponse(qdr, compactTestRequests(axis, "A"))

	require.Nil(t, compact)
	require.ErrorIs(t, err, errCompactQueryDataUnsupported)
}

func BenchmarkCompactQueryDataResponseGapless(b *testing.B) {
	axis, qdr := compactBenchmarkResponse(100, 360)
	requests := compactTestRequests(axis, "A")
	b.ReportAllocs()
	for b.Loop() {
		compact, err := newCompactQueryDataResponse(qdr, requests)
		if err != nil {
			b.Fatal(err)
		}
		if compact.Results["A"].Frames[0].Presence != nil {
			b.Fatal("gapless frame allocated a presence bitmap")
		}
	}
}

func BenchmarkWriteCompactQueryDataResponse(b *testing.B) {
	axis, qdr := compactBenchmarkResponse(100, 360)
	compact, err := newCompactQueryDataResponse(qdr, compactTestRequests(axis, "A"))
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.SetBytes(int64(100 * 360 * float64Bytes))
	for b.Loop() {
		writer := compactBinaryWriter{context: context.Background(), writer: io.Discard}
		writeCompactQueryDataResponse(compact, &writer)
		if writer.err != nil {
			b.Fatal(writer.err)
		}
	}
}

const float64Bytes = 8

func compactBenchmarkResponse(frameCount, pointCount int) (compactRegularTimeAxis, *backend.QueryDataResponse) {
	axis := compactRegularTimeAxis{Start: 1_000, Step: 1_000, Count: uint32(pointCount)}
	timestamps := make([]int64, pointCount)
	for pointIndex := range timestamps {
		timestamps[pointIndex] = axis.Start + int64(pointIndex)*axis.Step
	}
	frames := make(data.Frames, frameCount)
	for frameIndex := range frames {
		values := make([]float64, pointCount)
		for pointIndex := range values {
			values[pointIndex] = float64(frameIndex*pointCount + pointIndex)
		}
		frames[frameIndex] = newCompactTestFrame("series", axis, timestamps, values)
	}
	return axis, &backend.QueryDataResponse{Responses: backend.Responses{"A": {Frames: frames}}}
}

func newCompactTestFrame(name string, axis compactRegularTimeAxis, timestamps []int64, values []float64) *data.Frame {
	return newCompactTestFrameWithInterval(name, axis, axis.Step, timestamps, values)
}

func newCompactTestFrameWithInterval(
	name string,
	axis compactRegularTimeAxis,
	interval int64,
	timestamps []int64,
	values []float64,
) *data.Frame {
	times := make([]time.Time, len(timestamps))
	for i, timestamp := range timestamps {
		times[i] = time.UnixMilli(timestamp)
	}
	timeField := data.NewField("Time", nil, times)
	timeField.Config = &data.FieldConfig{Interval: float64(interval)}
	frame := data.NewFrame(name, timeField, data.NewField("Value", nil, values))
	frame.Meta = &data.FrameMeta{
		Type:        data.FrameTypeTimeSeriesMulti,
		TypeVersion: data.FrameTypeVersion{0, 1},
		Custom:      map[string]any{"resultType": models.ResultTypeMatrix.String()},
	}
	return frame
}

func newCompactNoDataTestFrame() *data.Frame {
	frame := data.NewFrame("")
	frame.Meta = &data.FrameMeta{}
	return frame
}

func setCompactTestQueryMetadata(frame *data.Frame, executedQuery string, calculatedMinStep int64) {
	frame.Meta.ExecutedQueryString = executedQuery
	custom, ok := frame.Meta.Custom.(map[string]any)
	if !ok {
		custom = make(map[string]any)
		frame.Meta.Custom = custom
	}
	custom["calculatedMinStep"] = calculatedMinStep
}

func compactTestRequests(axis compactRegularTimeAxis, refIDs ...string) map[string]compactQueryRequest {
	requests := make(map[string]compactQueryRequest, len(refIDs))
	for _, refID := range refIDs {
		requests[refID] = compactQueryRequest{
			Start: time.UnixMilli(axis.Start),
			End:   time.UnixMilli(axis.Start + int64(axis.Count-1)*axis.Step),
		}
	}
	return requests
}

type compactTestResponse struct {
	Strings []string
	Axes    []compactRegularTimeAxis
	Results map[string]compactTestResult
}

type compactTestResult struct {
	RefID                 string
	Status                backend.Status
	Error                 string
	ExecutedQueryString   string
	CalculatedMinStep     int64
	HasCalculatedMinStep  bool
	ResultType            compactResultType
	FrameType             compactFrameType
	FrameTypeVersionMajor uint16
	FrameTypeVersionMinor uint16
	Frames                []compactTestFrame
}

type compactTestFrame struct {
	FrameName         string
	FrameRefID        string
	ValueName         string
	DisplayNameFromDS string
	Labels            data.Labels
	AxisID            uint32
	Presence          []byte
	Values            []float64
}

func decodeCompactTestResponse(t *testing.T, body []byte) compactTestResponse {
	t.Helper()
	reader := bytes.NewReader(body)
	read := func(value any) { require.NoError(t, binary.Read(reader, binary.LittleEndian, value)) }
	readBytes := func(length uint32) []byte {
		value := make([]byte, length)
		_, err := io.ReadFull(reader, value)
		require.NoError(t, err)
		return value
	}
	skipPadding := func() {
		padding := (8 - (len(body)-reader.Len())%8) % 8
		require.Equal(t, make([]byte, padding), readBytes(uint32(padding)))
	}

	require.Equal(t, compactQueryDataMagic, string(readBytes(4)))
	var version, flags uint16
	var axisCount, resultCount, stringCount, stringBytesLength uint32
	var reserved uint64
	read(&version)
	read(&flags)
	read(&axisCount)
	read(&resultCount)
	read(&stringCount)
	read(&stringBytesLength)
	read(&reserved)
	require.Equal(t, uint16(compactQueryDataBinaryVersion), version)
	require.Zero(t, flags)
	require.Zero(t, reserved)
	require.Equal(t, compactResponseHeaderSize, len(body)-reader.Len())

	response := compactTestResponse{Axes: make([]compactRegularTimeAxis, axisCount), Results: make(map[string]compactTestResult, resultCount)}
	for i := range response.Axes {
		var start int64
		var step uint64
		var count, axisReserved uint32
		read(&start)
		read(&step)
		read(&count)
		read(&axisReserved)
		require.Zero(t, axisReserved)
		response.Axes[i] = compactRegularTimeAxis{Start: start, Step: int64(step), Count: count}
	}

	type stringRecord struct {
		offset uint32
		length uint32
	}
	stringRecords := make([]stringRecord, stringCount)
	stringRecordsStart := len(body) - reader.Len()
	for i := range stringRecords {
		read(&stringRecords[i].offset)
		read(&stringRecords[i].length)
	}
	require.Equal(t, int(stringCount)*compactStringRecordSize, len(body)-reader.Len()-stringRecordsStart)
	stringBytes := readBytes(stringBytesLength)
	skipPadding()
	response.Strings = make([]string, stringCount)
	for i, record := range stringRecords {
		end := uint64(record.offset) + uint64(record.length)
		require.LessOrEqual(t, end, uint64(len(stringBytes)))
		response.Strings[i] = string(stringBytes[record.offset:uint32(end)])
	}
	require.NotEmpty(t, response.Strings)
	require.Empty(t, response.Strings[0])
	resolveString := func(id uint32) string {
		require.Less(t, id, uint32(len(response.Strings)))
		return response.Strings[id]
	}

	for range resultCount {
		resultStart := len(body) - reader.Len()
		var recordLength, refIDStringID, errorStringID, executedQueryStringID uint32
		var status int32
		var frameCount uint32
		var calculatedMinStep int64
		var resultType, frameType, frameTypeVersionMajor, frameTypeVersionMinor uint16
		var resultFlags, resultReserved uint32
		read(&recordLength)
		read(&refIDStringID)
		read(&errorStringID)
		read(&executedQueryStringID)
		read(&status)
		read(&frameCount)
		read(&calculatedMinStep)
		read(&resultType)
		read(&frameType)
		read(&frameTypeVersionMajor)
		read(&frameTypeVersionMinor)
		read(&resultFlags)
		read(&resultReserved)
		require.Zero(t, resultReserved)
		require.Zero(t, resultFlags & ^compactResultFlagCalculatedMinStep)

		refID := resolveString(refIDStringID)
		result := compactTestResult{
			RefID:                 refID,
			Status:                backend.Status(status),
			Error:                 resolveString(errorStringID),
			ExecutedQueryString:   resolveString(executedQueryStringID),
			CalculatedMinStep:     calculatedMinStep,
			HasCalculatedMinStep:  resultFlags&compactResultFlagCalculatedMinStep != 0,
			ResultType:            compactResultType(resultType),
			FrameType:             compactFrameType(frameType),
			FrameTypeVersionMajor: frameTypeVersionMajor,
			FrameTypeVersionMinor: frameTypeVersionMinor,
			Frames:                make([]compactTestFrame, frameCount),
		}
		for i := range result.Frames {
			frameStart := len(body) - reader.Len()
			var frameLength, axisID, presentCount, bitmapLength uint32
			var frameNameStringID, frameRefIDStringID, valueNameStringID, displayNameStringID uint32
			var labelCount, frameFlags uint32
			var frameReserved uint64
			read(&frameLength)
			read(&axisID)
			read(&presentCount)
			read(&bitmapLength)
			read(&frameNameStringID)
			read(&frameRefIDStringID)
			read(&valueNameStringID)
			read(&displayNameStringID)
			read(&labelCount)
			read(&frameFlags)
			read(&frameReserved)
			require.Zero(t, frameFlags)
			require.Zero(t, frameReserved)
			frame := compactTestFrame{
				FrameName:         resolveString(frameNameStringID),
				FrameRefID:        resolveString(frameRefIDStringID),
				ValueName:         resolveString(valueNameStringID),
				DisplayNameFromDS: resolveString(displayNameStringID),
				Labels:            make(data.Labels, labelCount),
				AxisID:            axisID,
			}
			for range labelCount {
				var nameStringID, valueStringID uint32
				read(&nameStringID)
				read(&valueStringID)
				frame.Labels[resolveString(nameStringID)] = resolveString(valueStringID)
			}
			frame.Presence = readBytes(bitmapLength)
			skipPadding()
			frame.Values = make([]float64, presentCount)
			for valueIndex := range frame.Values {
				read(&frame.Values[valueIndex])
			}
			require.Equal(t, uint32(compactFrameHeaderSize+int(labelCount)*compactLabelRecordSize+int(bitmapLength)+paddingTo8(compactFrameHeaderSize+int(labelCount)*compactLabelRecordSize+int(bitmapLength))+int(presentCount)*8), frameLength)
			require.Equal(t, int(frameLength), len(body)-reader.Len()-frameStart)
			result.Frames[i] = frame
		}
		require.Equal(t, int(recordLength), len(body)-reader.Len()-resultStart)
		response.Results[refID] = result
	}
	require.Zero(t, reader.Len())
	return response
}

func gzipSize(t *testing.T, body []byte) int {
	t.Helper()
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, err := writer.Write(body)
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	return compressed.Len()
}

func compactResponseBody(t *testing.T, compact *compactQueryDataResponse) []byte {
	t.Helper()
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/ds/query", nil)
	ctx := &contextmodel.ReqContext{
		Context: &web.Context{Req: req, Resp: web.NewResponseWriter(http.MethodPost, recorder)},
		Logger:  log.New("compact-query-data-test"),
	}
	compactQueryDataStreamingResponse{body: compact}.WriteTo(ctx)
	return recorder.Body.Bytes()
}

type trackingResponseWriter struct {
	body     bytes.Buffer
	header   http.Header
	maxWrite int
	writes   int
}

func newTrackingResponseWriter() *trackingResponseWriter {
	return &trackingResponseWriter{header: make(http.Header)}
}

func (w *trackingResponseWriter) Header() http.Header { return w.header }
func (w *trackingResponseWriter) WriteHeader(_ int)   {}
func (w *trackingResponseWriter) Write(value []byte) (int, error) {
	w.writes++
	w.maxWrite = max(w.maxWrite, len(value))
	return w.body.Write(value)
}

type shortCompactWriter struct{}

func (shortCompactWriter) Write(value []byte) (int, error) {
	return max(0, len(value)-1), nil
}

type failingCompactWriter struct{}

func (failingCompactWriter) Write([]byte) (int, error) {
	return 0, errors.New("write failed")
}
