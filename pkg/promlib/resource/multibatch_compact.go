package resource

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/json-iterator/go"
	"github.com/klauspost/compress/zstd"

	"github.com/grafana/grafana/pkg/promlib/compact"
	"github.com/grafana/grafana/pkg/promlib/converter"
	"github.com/grafana/grafana/pkg/promlib/models"
)

const (
	compactMultiBatchRefIDHeader        = "X-Grafana-Prometheus-Multibatch-Ref-Id"
	compactMultiBatchLegendFormatHeader = "X-Grafana-Prometheus-Multibatch-Legend-Format"
	compactMultiBatchUTCOffsetHeader    = "X-Grafana-Prometheus-Multibatch-UTC-Offset-Sec"

	multiBatchFrameHeaderSize = 12
	multiBatchVersion         = 1
	multiBatchFinalFlag       = 1
	multiBatchReservedFlags   = 0xfe

	multiBatchPayloadTypeJSONL     = 1
	multiBatchPayloadTypeCompactV1 = 2

	multiBatchPayloadEncodingIdentity = 0
	multiBatchPayloadEncodingZstd     = 1

	maxMultiBatchPayloadSize  = 512 * 1024 * 1024
	maxZstdDecodedPayloadSize = maxMultiBatchPayloadSize
)

var legendFormatRegexpForResource = regexp.MustCompile(`\{\{\s*(.+?)\s*\}\}`)

type compactMultiBatchQuery struct {
	RefID        string
	Expr         string
	LegendFormat string
	Start        time.Time
	End          time.Time
	Step         time.Duration
	UTCOffsetSec int64
}

type multiBatchFrame struct {
	payloadType     byte
	flags           byte
	payloadEncoding byte
	payload         []byte
}

func isCompactMultiBatchRequest(req *backend.CallResourceRequest) bool {
	return req.GetHTTPHeaders().Get(compact.Header) == compact.Version
}

func (r *Resource) executeCompactMultiBatchStream(
	req *backend.CallResourceRequest,
	resp *http.Response,
	query compactMultiBatchQuery,
	encoder *multiBatchResponseEncoder,
) error {
	return encoder.finish(streamCompactMultiBatchResponse(req, resp, query, encoder))
}

func streamCompactMultiBatchResponse(
	req *backend.CallResourceRequest,
	resp *http.Response,
	query compactMultiBatchQuery,
	encoder *multiBatchResponseEncoder,
) error {
	upstreamIsMultiBatch := isMultiBatchContentType(resp.Header.Get("Content-Type"))
	reader := bufio.NewReader(resp.Body)
	if upstreamIsMultiBatch {
		if err := readMultiBatchResponseHeader(reader); err != nil {
			return err
		}
	}

	if err := encoder.start(); err != nil {
		return err
	}

	var accumulated backend.DataResponse
	payloadDecoder := newCompactMultiBatchPayloadDecoder(query, backend.Status(resp.StatusCode))
	if !upstreamIsMultiBatch {
		payload, err := io.ReadAll(reader)
		if err != nil {
			return err
		}
		batch, err := payloadDecoder.decode(payload)
		if err != nil {
			return err
		}
		accumulated = mergeDataResponses(accumulated, batch)
		frame, err := buildCompactDataResponseFrame(encoder.ctx, encoder.logger.FromContext(encoder.ctx), query, accumulated, true)
		if err != nil {
			return err
		}
		return encoder.writeFrame(frame)
	}

	for {
		frame, err := readMultiBatchFrame(reader)
		if err != nil {
			return err
		}
		if frame.payloadType != multiBatchPayloadTypeJSONL {
			return fmt.Errorf("unsupported upstream Prometheus multi-batch payload type: %d", frame.payloadType)
		}
		payload, err := decodeMultiBatchPayload(frame)
		if err != nil {
			return err
		}
		batch, err := payloadDecoder.decode(payload)
		if err != nil {
			return err
		}
		accumulated = mergeDataResponses(accumulated, batch)
		isFinal := frame.flags&multiBatchFinalFlag != 0
		responseFrame, err := buildCompactDataResponseFrame(encoder.ctx, encoder.logger.FromContext(encoder.ctx), query, accumulated, isFinal)
		if err != nil {
			return err
		}
		if err := encoder.writeFrame(responseFrame); err != nil {
			return err
		}
		if isFinal {
			return nil
		}
	}
}

func compactMultiBatchResponseHeaders(upstream http.Header) http.Header {
	headers := upstream.Clone()
	headers.Del("Content-Length")
	headers.Del("Content-Encoding")
	headers.Del("X-Grafana-Cache")
	headers.Set("Cache-Control", "no-store")
	headers.Set("Content-Type", preferredMultiBatchContentType+"; version=1")
	headers.Set("Vary", compact.Header+", Accept-Encoding")
	return headers
}

func buildCompactDataResponseFrame(ctx context.Context, logger log.Logger, query compactMultiBatchQuery, response backend.DataResponse, isFinal bool) (multiBatchFrame, error) {
	if response.Error != nil {
		return buildJSONDataResponseFrame(query, response, isFinal)
	}

	compactResponse, err := encodeCompactMultiBatchResponse(ctx, query, response)
	if err != nil {
		if !errors.Is(err, compact.ErrUnsupported) {
			return multiBatchFrame{}, err
		}
		if reason := compact.UnsupportedReason(err); reason == "inconsistent_executed_query" || reason == "inconsistent_calculated_min_step" {
			logger.Error(
				"Compact multibatch response metadata disagreed across frames",
				"reason", reason,
				"refID", query.RefID,
			)
		}
		return buildJSONDataResponseFrame(query, response, isFinal)
	}

	var payload bytes.Buffer
	if err := compact.WriteQueryDataResponse(ctx, compactResponse, &payload); err != nil {
		return multiBatchFrame{}, err
	}

	flags := byte(0)
	if isFinal {
		flags = multiBatchFinalFlag
	}
	return multiBatchFrame{
		payloadType:     multiBatchPayloadTypeCompactV1,
		flags:           flags,
		payloadEncoding: multiBatchPayloadEncodingIdentity,
		payload:         payload.Bytes(),
	}, nil
}

func buildJSONDataResponseFrame(query compactMultiBatchQuery, response backend.DataResponse, isFinal bool) (multiBatchFrame, error) {
	payload, err := json.Marshal(&backend.QueryDataResponse{Responses: backend.Responses{query.RefID: response}})
	if err != nil {
		return multiBatchFrame{}, err
	}

	flags := byte(0)
	if isFinal {
		flags = multiBatchFinalFlag
	}
	return multiBatchFrame{
		payloadType:     multiBatchPayloadTypeJSONL,
		flags:           flags,
		payloadEncoding: multiBatchPayloadEncodingIdentity,
		payload:         payload,
	}, nil
}

func encodeCompactMultiBatchResponse(ctx context.Context, query compactMultiBatchQuery, response backend.DataResponse) (*compact.QueryDataResponse, error) {
	response = sanitizeCompactMultiBatchNoDataResponse(response)
	qdr := &backend.QueryDataResponse{Responses: backend.Responses{query.RefID: response}}
	return compact.NewQueryDataResponseContext(ctx, qdr, map[string]compact.QueryRequest{
		query.RefID: {
			Start:        query.Start,
			End:          query.End,
			UTCOffsetSec: query.UTCOffsetSec,
		},
	})
}

func sanitizeCompactMultiBatchNoDataResponse(response backend.DataResponse) backend.DataResponse {
	if !onlyNoDataFramesForResource(response.Frames) {
		return response
	}
	var hasNoDataNotices bool
	for _, frame := range response.Frames {
		if frame != nil && frame.Meta != nil && len(frame.Meta.Notices) > 0 {
			hasNoDataNotices = true
			break
		}
	}
	if !hasNoDataNotices {
		return response
	}
	response.Frames = cloneFrames(response.Frames)
	for _, frame := range response.Frames {
		if frame != nil && frame.Meta != nil {
			frame.Meta.Notices = nil
		}
	}
	return response
}

func multiBatchResponseHeader() []byte {
	header := make([]byte, multiBatchFrameHeaderSize)
	copy(header, "MBRH")
	header[4] = multiBatchVersion
	return header
}

func multiBatchPayloadFrame(payloadType byte, flags byte, payloadEncoding byte, payload []byte) []byte {
	frame := make([]byte, multiBatchFrameHeaderSize+len(payload))
	copy(frame, "MBBF")
	frame[4] = multiBatchVersion
	frame[5] = payloadType
	frame[6] = flags
	frame[7] = payloadEncoding
	binary.BigEndian.PutUint32(frame[8:12], uint32(len(payload)))
	copy(frame[multiBatchFrameHeaderSize:], payload)
	return frame
}

func multiBatchFrameBytes(frame multiBatchFrame) []byte {
	return multiBatchPayloadFrame(frame.payloadType, frame.flags, frame.payloadEncoding, frame.payload)
}

func isSupportedMultiBatchPayloadType(payloadType byte) bool {
	return payloadType == multiBatchPayloadTypeJSONL || payloadType == multiBatchPayloadTypeCompactV1
}

func multiBatchErrorFrame(message string) multiBatchFrame {
	payload, _ := json.Marshal(struct {
		Type    string `json:"type"`
		Frame   string `json:"frame"`
		Message string `json:"message"`
	}{
		Type:    "error",
		Frame:   "main",
		Message: message,
	})
	payload = append(payload, '\n')
	return multiBatchFrame{
		payloadType:     multiBatchPayloadTypeJSONL,
		flags:           multiBatchFinalFlag,
		payloadEncoding: multiBatchPayloadEncodingIdentity,
		payload:         payload,
	}
}

func readMultiBatchResponseHeader(reader io.Reader) error {
	header, err := readMultiBatchHeader(reader)
	if err != nil {
		return err
	}
	if string(header[0:4]) != "MBRH" {
		return errors.New("invalid Prometheus multi-batch response header magic")
	}
	if header[4] != multiBatchVersion {
		return fmt.Errorf("unsupported Prometheus multi-batch response header version: %d", header[4])
	}
	for _, value := range header[5:] {
		if value != 0 {
			return errors.New("unsupported Prometheus multi-batch response header")
		}
	}
	return nil
}

func readMultiBatchFrame(reader io.Reader) (multiBatchFrame, error) {
	header, err := readMultiBatchHeader(reader)
	if err != nil {
		return multiBatchFrame{}, err
	}
	if string(header[0:4]) != "MBBF" {
		return multiBatchFrame{}, errors.New("invalid Prometheus multi-batch frame magic")
	}
	if header[4] != multiBatchVersion {
		return multiBatchFrame{}, fmt.Errorf("unsupported Prometheus multi-batch frame version: %d", header[4])
	}
	flags := header[6]
	if flags&multiBatchReservedFlags != 0 {
		return multiBatchFrame{}, fmt.Errorf("unsupported Prometheus multi-batch frame flags: %d", flags)
	}
	encoding := header[7]
	if encoding != multiBatchPayloadEncodingIdentity && encoding != multiBatchPayloadEncodingZstd {
		return multiBatchFrame{}, fmt.Errorf("unsupported Prometheus multi-batch payload encoding: %d", encoding)
	}
	payloadLength := binary.BigEndian.Uint32(header[8:12])
	if payloadLength > maxMultiBatchPayloadSize {
		return multiBatchFrame{}, fmt.Errorf("Prometheus multi-batch payload length %d exceeds limit %d", payloadLength, maxMultiBatchPayloadSize)
	}
	payload := make([]byte, payloadLength)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return multiBatchFrame{}, err
	}
	return multiBatchFrame{payloadType: header[5], flags: flags, payloadEncoding: encoding, payload: payload}, nil
}

func readMultiBatchHeader(reader io.Reader) ([]byte, error) {
	header := make([]byte, multiBatchFrameHeaderSize)
	_, err := io.ReadFull(reader, header)
	return header, err
}

func decodeMultiBatchPayload(frame multiBatchFrame) ([]byte, error) {
	switch frame.payloadEncoding {
	case multiBatchPayloadEncodingIdentity:
		return frame.payload, nil
	case multiBatchPayloadEncodingZstd:
		return decodeZstdMultiBatchPayload(frame.payload)
	default:
		return nil, fmt.Errorf("unsupported Prometheus multi-batch payload encoding: %d", frame.payloadEncoding)
	}
}

func decodeZstdMultiBatchPayload(payload []byte) ([]byte, error) {
	var header zstd.Header
	if err := header.Decode(payload); err != nil {
		return nil, fmt.Errorf("decode zstd payload header: %w", err)
	}
	if header.HasFCS {
		if header.FrameContentSize > maxZstdDecodedPayloadSize {
			return nil, fmt.Errorf("zstd payload content size %d exceeds limit %d", header.FrameContentSize, maxZstdDecodedPayloadSize)
		}
		decoder, err := zstd.NewReader(nil, zstd.WithDecoderMaxMemory(maxZstdDecodedPayloadSize))
		if err != nil {
			return nil, err
		}
		defer decoder.Close()
		dst := make([]byte, 0, int(header.FrameContentSize))
		decoded, err := decoder.DecodeAll(payload, dst)
		if err != nil {
			return nil, err
		}
		if uint64(len(decoded)) != header.FrameContentSize {
			return nil, fmt.Errorf("zstd decoded payload size %d did not match frame content size %d", len(decoded), header.FrameContentSize)
		}
		return decoded, nil
	}

	decoder, err := zstd.NewReader(bytes.NewReader(payload), zstd.WithDecoderMaxMemory(maxZstdDecodedPayloadSize))
	if err != nil {
		return nil, err
	}
	defer decoder.Close()
	var decoded bytes.Buffer
	written, err := io.Copy(&decoded, io.LimitReader(decoder, maxZstdDecodedPayloadSize+1))
	if err != nil {
		return nil, err
	}
	if written > maxZstdDecodedPayloadSize {
		return nil, fmt.Errorf("zstd decoded payload exceeds limit %d", maxZstdDecodedPayloadSize)
	}
	return decoded.Bytes(), nil
}

func compactMultiBatchQueryFromRequest(req *backend.CallResourceRequest) (compactMultiBatchQuery, error) {
	params, err := resourceRequestParams(req)
	if err != nil {
		return compactMultiBatchQuery{}, err
	}
	start, err := parsePrometheusUnixTime(params.Get("start"))
	if err != nil {
		return compactMultiBatchQuery{}, fmt.Errorf("invalid query_range start: %w", err)
	}
	end, err := parsePrometheusUnixTime(params.Get("end"))
	if err != nil {
		return compactMultiBatchQuery{}, fmt.Errorf("invalid query_range end: %w", err)
	}
	step, err := parsePrometheusStep(params.Get("step"))
	if err != nil {
		return compactMultiBatchQuery{}, fmt.Errorf("invalid query_range step: %w", err)
	}
	refID := req.GetHTTPHeaders().Get(compactMultiBatchRefIDHeader)
	if refID == "" {
		refID = "A"
	}
	utcOffsetSec, _ := strconv.ParseInt(req.GetHTTPHeaders().Get(compactMultiBatchUTCOffsetHeader), 10, 64)
	return compactMultiBatchQuery{
		RefID:        refID,
		Expr:         params.Get("query"),
		LegendFormat: req.GetHTTPHeaders().Get(compactMultiBatchLegendFormatHeader),
		Start:        start,
		End:          end,
		Step:         step,
		UTCOffsetSec: utcOffsetSec,
	}, nil
}

func resourceRequestParams(req *backend.CallResourceRequest) (url.Values, error) {
	values := url.Values{}
	if req.URL != "" {
		u, err := url.Parse(req.URL)
		if err != nil {
			return nil, err
		}
		for key, vals := range u.Query() {
			for _, value := range vals {
				values.Add(key, value)
			}
		}
	}
	if strings.EqualFold(req.Method, http.MethodPost) && len(req.Body) > 0 {
		bodyValues, err := url.ParseQuery(string(req.Body))
		if err != nil {
			return nil, err
		}
		for key, vals := range bodyValues {
			values.Del(key)
			for _, value := range vals {
				values.Add(key, value)
			}
		}
	}
	return values, nil
}

func parsePrometheusUnixTime(value string) (time.Time, error) {
	seconds, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return time.Time{}, err
	}
	integer, fractional := math.Modf(seconds)
	return time.Unix(int64(integer), int64(fractional*float64(time.Second))).UTC(), nil
}

func parsePrometheusStep(value string) (time.Duration, error) {
	seconds, err := strconv.ParseFloat(value, 64)
	if err == nil {
		return time.Duration(seconds * float64(time.Second)), nil
	}
	return time.ParseDuration(value)
}

type compactMultiBatchPayloadDecoder struct {
	query            compactMultiBatchQuery
	status           backend.Status
	jsonlAccumulator *compactMultiBatchJSONLAccumulator
}

func newCompactMultiBatchPayloadDecoder(query compactMultiBatchQuery, status backend.Status) *compactMultiBatchPayloadDecoder {
	return &compactMultiBatchPayloadDecoder{
		query:            query,
		status:           status,
		jsonlAccumulator: newCompactMultiBatchJSONLAccumulator(),
	}
}

func (d *compactMultiBatchPayloadDecoder) decode(payload []byte) (backend.DataResponse, error) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 {
		return backend.DataResponse{Status: d.status}, nil
	}
	if isPrometheusAPIJSONPayload(trimmed) {
		return decodePrometheusPayload(trimmed, d.query, d.status)
	}
	if int(d.status) >= http.StatusBadRequest {
		return decodePrometheusErrorPayload(trimmed, d.status), nil
	}
	return d.jsonlAccumulator.decode(trimmed, d.query, d.status)
}

func isPrometheusAPIJSONPayload(payload []byte) bool {
	var envelope struct {
		Type   string          `json:"type"`
		Status string          `json:"status"`
		Data   json.RawMessage `json:"data"`
		Error  string          `json:"error"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return false
	}
	if envelope.Type != "" {
		return false
	}
	return envelope.Status != "" || envelope.Error != "" || bytes.Contains(envelope.Data, []byte(`"resultType"`))
}

func decodePrometheusErrorPayload(payload []byte, status backend.Status) backend.DataResponse {
	message := prometheusErrorMessage(payload)
	if message == "" {
		message = http.StatusText(int(status))
	}
	if message == "" {
		message = fmt.Sprintf("Prometheus multi-batch request failed with status %d", status)
	}
	return backend.DataResponse{Status: status, Error: errors.New(message)}
}

func prometheusErrorMessage(payload []byte) string {
	var envelope struct {
		Error     json.RawMessage `json:"error"`
		ErrorType string          `json:"errorType"`
		Message   string          `json:"message"`
	}
	if err := json.Unmarshal(payload, &envelope); err == nil {
		if envelope.Message != "" {
			return envelope.Message
		}
		if len(envelope.Error) > 0 {
			var errorString string
			if err := json.Unmarshal(envelope.Error, &errorString); err == nil && errorString != "" {
				return errorString
			}
			var errorObject struct {
				Message string `json:"message"`
				Type    string `json:"type"`
				Code    string `json:"code"`
			}
			if err := json.Unmarshal(envelope.Error, &errorObject); err == nil {
				switch {
				case errorObject.Message != "":
					return errorObject.Message
				case errorObject.Type != "":
					return errorObject.Type
				case errorObject.Code != "":
					return errorObject.Code
				}
			}
		}
		if envelope.ErrorType != "" {
			return envelope.ErrorType
		}
	}

	text := strings.TrimSpace(string(payload))
	if len(text) > 512 {
		return text[:512]
	}
	return text
}

type compactMultiBatchJSONLAccumulator struct {
	schemas map[string]compactMultiBatchJSONLSchema
}

type compactMultiBatchJSONLSchema struct {
	Frame   string
	RefID   string
	Name    string
	SQL     string
	Columns []compactMultiBatchJSONLColumn
}

type compactMultiBatchJSONLColumn struct {
	Name   string            `json:"name"`
	Type   string            `json:"type"`
	Labels map[string]string `json:"labels"`
}

type compactMultiBatchJSONLEvent struct {
	Type         string                         `json:"type"`
	Frame        string                         `json:"frame"`
	RefID        string                         `json:"refId"`
	Name         string                         `json:"name"`
	SQL          string                         `json:"sql"`
	Columns      []compactMultiBatchJSONLColumn `json:"columns"`
	Fields       []compactMultiBatchJSONLColumn `json:"fields"`
	Data         json.RawMessage                `json:"data"`
	Row          []any                          `json:"row"`
	Rows         [][]any                        `json:"rows"`
	Values       map[string]any                 `json:"values"`
	Status       string                         `json:"status"`
	IsIncomplete *bool                          `json:"isIncomplete"`
	Incomplete   *bool                          `json:"incomplete"`
	Error        string                         `json:"error"`
	Message      string                         `json:"message"`
}

type compactMultiBatchJSONLBatch struct {
	frames map[string]*data.Frame
	order  []string
}

type compactMultiBatchJSONLRow struct {
	values []any
	named  map[string]any
}

func newCompactMultiBatchJSONLAccumulator() *compactMultiBatchJSONLAccumulator {
	return &compactMultiBatchJSONLAccumulator{schemas: map[string]compactMultiBatchJSONLSchema{}}
}

func (a *compactMultiBatchJSONLAccumulator) decode(payload []byte, query compactMultiBatchQuery, status backend.Status) (backend.DataResponse, error) {
	batch := compactMultiBatchJSONLBatch{frames: map[string]*data.Frame{}}
	lines := bytes.Split(payload, []byte("\n"))
	response := backend.DataResponse{Status: status}

	for _, rawLine := range lines {
		line := bytes.TrimSpace(rawLine)
		if len(line) == 0 {
			continue
		}
		var event compactMultiBatchJSONLEvent
		if err := json.Unmarshal(line, &event); err != nil {
			return response, fmt.Errorf("decode Prometheus multi-batch JSONL event: %w", err)
		}
		frameKey := compactMultiBatchFrameKey(event)
		switch event.Type {
		case "schema":
			columns := event.Columns
			if len(columns) == 0 {
				columns = event.Fields
			}
			a.schemas[frameKey] = compactMultiBatchJSONLSchema{
				Frame:   frameKey,
				RefID:   event.RefID,
				Name:    event.Name,
				SQL:     event.SQL,
				Columns: columns,
			}
		case "data":
			rows, err := compactMultiBatchJSONLRows(event)
			if err != nil {
				return response, err
			}
			for _, row := range rows {
				frame, err := a.batchFrame(&batch, frameKey, query)
				if err != nil {
					return response, err
				}
				values, err := compactMultiBatchJSONLRowValues(a.schemas[frameKey], row)
				if err != nil {
					return response, err
				}
				frame.AppendRow(values...)
			}
		case "status":
			continue
		case "error":
			message := event.Error
			if message == "" {
				message = event.Message
			}
			if message == "" && len(event.Data) > 0 {
				var dataMessage string
				if err := json.Unmarshal(event.Data, &dataMessage); err == nil {
					message = dataMessage
				}
			}
			if message == "" {
				message = "Prometheus multi-batch response returned an error event"
			}
			response.Error = errors.New(message)
			return response, nil
		default:
			return response, fmt.Errorf("unsupported Prometheus multi-batch JSONL event type: %s", event.Type)
		}
	}

	for _, frameKey := range batch.order {
		response.Frames = append(response.Frames, batch.frames[frameKey])
	}
	applyCompactQueryMetadata(&response, query)
	return response, nil
}

func compactMultiBatchFrameKey(event compactMultiBatchJSONLEvent) string {
	if event.Frame != "" {
		return event.Frame
	}
	if event.RefID != "" {
		return event.RefID
	}
	return "main"
}

func compactMultiBatchJSONLRows(event compactMultiBatchJSONLEvent) ([]compactMultiBatchJSONLRow, error) {
	if len(event.Rows) > 0 {
		rows := make([]compactMultiBatchJSONLRow, 0, len(event.Rows))
		for _, row := range event.Rows {
			rows = append(rows, compactMultiBatchJSONLRow{values: row})
		}
		return rows, nil
	}
	if len(event.Row) > 0 {
		return []compactMultiBatchJSONLRow{{values: event.Row}}, nil
	}
	if len(event.Values) > 0 {
		return []compactMultiBatchJSONLRow{{named: event.Values}}, nil
	}
	if len(event.Data) == 0 || bytes.Equal(bytes.TrimSpace(event.Data), []byte("null")) {
		return nil, nil
	}
	var rows [][]any
	if err := json.Unmarshal(event.Data, &rows); err == nil {
		result := make([]compactMultiBatchJSONLRow, 0, len(rows))
		for _, row := range rows {
			result = append(result, compactMultiBatchJSONLRow{values: row})
		}
		return result, nil
	}
	var row []any
	if err := json.Unmarshal(event.Data, &row); err == nil {
		return []compactMultiBatchJSONLRow{{values: row}}, nil
	}
	var values map[string]any
	if err := json.Unmarshal(event.Data, &values); err == nil {
		return []compactMultiBatchJSONLRow{{named: values}}, nil
	}
	return nil, errors.New("unsupported Prometheus multi-batch JSONL data event shape")
}

func (a *compactMultiBatchJSONLAccumulator) batchFrame(batch *compactMultiBatchJSONLBatch, frameKey string, query compactMultiBatchQuery) (*data.Frame, error) {
	if frame, ok := batch.frames[frameKey]; ok {
		return frame, nil
	}
	schema, ok := a.schemas[frameKey]
	if !ok {
		return nil, fmt.Errorf("Prometheus multi-batch data event referenced unknown frame: %s", frameKey)
	}
	frame, err := compactMultiBatchJSONLFrame(schema, query)
	if err != nil {
		return nil, err
	}
	batch.frames[frameKey] = frame
	batch.order = append(batch.order, frameKey)
	return frame, nil
}

func compactMultiBatchJSONLFrame(schema compactMultiBatchJSONLSchema, query compactMultiBatchQuery) (*data.Frame, error) {
	if len(schema.Columns) != 2 {
		return nil, fmt.Errorf("Prometheus multi-batch compact-v1 requires two-column time series frames, got %d columns", len(schema.Columns))
	}
	if schema.Columns[0].Type != "time" || schema.Columns[1].Type != "number" {
		return nil, fmt.Errorf("Prometheus multi-batch compact-v1 only supports time/number frames, got %s/%s", schema.Columns[0].Type, schema.Columns[1].Type)
	}
	name := schema.Name
	if name == "" {
		name = schema.Frame
	}
	refID := schema.RefID
	if refID == "" {
		refID = query.RefID
	}
	valueName := schema.Columns[1].Name
	if valueName == "" {
		valueName = data.TimeSeriesValueFieldName
	}
	frame := data.NewFrame(name,
		data.NewField(data.TimeSeriesTimeFieldName, nil, []time.Time{}),
		data.NewField(valueName, data.Labels(schema.Columns[1].Labels), []float64{}),
	)
	frame.RefID = refID
	frame.Meta = &data.FrameMeta{
		Type:        data.FrameTypeTimeSeriesMulti,
		TypeVersion: data.FrameTypeVersion{0, 1},
		Custom:      map[string]any{"resultType": models.ResultTypeMatrix.String()},
	}
	return frame, nil
}

func compactMultiBatchJSONLRowValues(schema compactMultiBatchJSONLSchema, row compactMultiBatchJSONLRow) ([]any, error) {
	values := row.values
	if len(row.named) > 0 {
		values = make([]any, 0, len(schema.Columns))
		for _, column := range schema.Columns {
			values = append(values, row.named[column.Name])
		}
	}
	if len(values) != len(schema.Columns) {
		return nil, fmt.Errorf("Prometheus multi-batch data row has %d values for %d columns", len(values), len(schema.Columns))
	}
	timestamp, err := compactMultiBatchTimeValue(values[0])
	if err != nil {
		return nil, err
	}
	value, err := compactMultiBatchFloatValue(values[1])
	if err != nil {
		return nil, err
	}
	return []any{timestamp, value}, nil
}

func compactMultiBatchTimeValue(value any) (time.Time, error) {
	switch v := value.(type) {
	case time.Time:
		return v.UTC(), nil
	case string:
		if timestamp, err := time.Parse(time.RFC3339Nano, v); err == nil {
			return timestamp.UTC(), nil
		}
		seconds, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return time.Time{}, fmt.Errorf("invalid Prometheus multi-batch time value %q", v)
		}
		return compactMultiBatchUnixTime(seconds), nil
	case float64:
		return compactMultiBatchUnixTime(v), nil
	case json.Number:
		seconds, err := v.Float64()
		if err != nil {
			return time.Time{}, err
		}
		return compactMultiBatchUnixTime(seconds), nil
	default:
		return time.Time{}, fmt.Errorf("invalid Prometheus multi-batch time value %T", value)
	}
}

func compactMultiBatchUnixTime(value float64) time.Time {
	if math.Abs(value) > 1e12 {
		return time.UnixMilli(int64(value)).UTC()
	}
	integer, fractional := math.Modf(value)
	return time.Unix(int64(integer), int64(fractional*float64(time.Second))).UTC()
}

func compactMultiBatchFloatValue(value any) (float64, error) {
	switch v := value.(type) {
	case float64:
		return v, nil
	case json.Number:
		return v.Float64()
	case string:
		if v == "" {
			return math.NaN(), nil
		}
		parsed, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return 0, fmt.Errorf("invalid Prometheus multi-batch numeric value %q", v)
		}
		return parsed, nil
	default:
		return 0, fmt.Errorf("invalid Prometheus multi-batch numeric value %T", value)
	}
}

func decodePrometheusPayload(payload []byte, query compactMultiBatchQuery, status backend.Status) (backend.DataResponse, error) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 {
		return backend.DataResponse{Status: status, Frames: data.Frames{data.NewFrame("")}}, nil
	}
	iter := jsoniter.ParseBytes(jsoniter.ConfigDefault, trimmed)
	response := converter.ReadPrometheusStyleResult(iter, converter.Options{})
	response.Status = status
	if response.Error != nil {
		return response, nil
	}
	if len(response.Frames) == 0 {
		response.Frames = append(response.Frames, data.NewFrame(""))
	}
	applyCompactQueryMetadata(&response, query)
	return response, nil
}

func applyCompactQueryMetadata(response *backend.DataResponse, query compactMultiBatchQuery) {
	for i, frame := range response.Frames {
		if frame == nil {
			continue
		}
		if frame.Meta == nil {
			frame.Meta = &data.FrameMeta{}
		}
		if len(frame.Fields) >= 2 {
			frame.Fields[0].Config = &data.FieldConfig{Interval: float64(query.Step.Milliseconds())}
			customName := compactLegendName(query.LegendFormat, frame.Fields[1])
			if customName != "" {
				frame.Fields[1].Config = &data.FieldConfig{DisplayNameFromDS: customName}
			}
			if frame.Meta.Type != "heatmap-cells" {
				if name, ok := frame.Fields[1].Labels["__name__"]; ok {
					frame.Fields[1].Name = name
				}
			}
		}
		frame.RefID = query.RefID
		if i == 0 {
			frame.Meta.ExecutedQueryString = "Expr: " + query.Expr + "\n" + "Step: " + query.Step.String()
			custom, ok := frame.Meta.Custom.(map[string]any)
			if !ok || custom == nil {
				custom = map[string]any{}
				frame.Meta.Custom = custom
			}
			custom["calculatedMinStep"] = query.Step.Milliseconds()
		}
	}
}

func compactLegendName(legendFormat string, field *data.Field) string {
	if field == nil {
		return ""
	}
	labels := field.Labels
	legend := compactMetricNameFromLabels(field)
	if legendFormat == "__auto" {
		if len(labels) > 0 {
			legend = ""
		}
	} else if legendFormat != "" {
		legend = string(legendFormatRegexpForResource.ReplaceAllFunc([]byte(legendFormat), func(in []byte) []byte {
			labelName := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(string(in), "{{"), "}}"))
			if value, exists := labels[labelName]; exists {
				return []byte(value)
			}
			return []byte{}
		}))
	}
	if legend == "" && len(labels) == 1 {
		for _, value := range labels {
			legend = value
		}
	}
	return legend
}

func compactMetricNameFromLabels(field *data.Field) string {
	labels := field.Labels
	metricName, hasName := labels["__name__"]
	numLabels := len(labels) - 1
	if !hasName {
		numLabels = len(labels)
	}
	labelStrings := make([]string, 0, numLabels)
	for label, value := range labels {
		if label != "__name__" {
			labelStrings = append(labelStrings, fmt.Sprintf("%s=%q", label, value))
		}
	}
	switch numLabels {
	case 0:
		if hasName {
			return metricName
		}
		return "{}"
	default:
		sort.Strings(labelStrings)
		return fmt.Sprintf("%s{%s}", metricName, strings.Join(labelStrings, ", "))
	}
}

func mergeDataResponses(base backend.DataResponse, delta backend.DataResponse) backend.DataResponse {
	if delta.Error != nil {
		base.Error = delta.Error
		base.ErrorSource = delta.ErrorSource
		base.Status = delta.Status
	}
	if base.Status == 0 {
		base.Status = delta.Status
	}
	if len(delta.Frames) == 0 {
		return base
	}
	if len(base.Frames) == 0 || onlyNoDataFramesForResource(base.Frames) {
		base.Frames = cloneFrames(delta.Frames)
		return base
	}
	if onlyNoDataFramesForResource(delta.Frames) {
		return base
	}
	index := make(map[string]int, len(base.Frames))
	for i, frame := range base.Frames {
		if key, ok := mergeFrameKey(frame); ok {
			index[key] = i
		}
	}
	for _, frame := range delta.Frames {
		key, ok := mergeFrameKey(frame)
		if !ok {
			base.Frames = append(base.Frames, cloneFrame(frame))
			continue
		}
		if existingIndex, exists := index[key]; exists {
			base.Frames[existingIndex] = mergeTimeSeriesFrame(base.Frames[existingIndex], frame)
			continue
		}
		index[key] = len(base.Frames)
		base.Frames = append(base.Frames, cloneFrame(frame))
	}
	return base
}

func onlyNoDataFramesForResource(frames data.Frames) bool {
	for _, frame := range frames {
		if frame != nil && len(frame.Fields) != 0 {
			return false
		}
	}
	return true
}

func mergeFrameKey(frame *data.Frame) (string, bool) {
	if frame == nil || len(frame.Fields) < 2 || frame.Fields[0].Type() != data.FieldTypeTime || frame.Fields[1].Type() != data.FieldTypeFloat64 {
		return "", false
	}
	labels := frame.Fields[1].Labels
	labelKeys := make([]string, 0, len(labels))
	for key := range labels {
		labelKeys = append(labelKeys, key)
	}
	sort.Strings(labelKeys)
	parts := []string{frame.RefID, frame.Name, frame.Fields[1].Name}
	for _, key := range labelKeys {
		parts = append(parts, key, labels[key])
	}
	return strings.Join(parts, "\x00"), true
}

func mergeTimeSeriesFrame(base *data.Frame, delta *data.Frame) *data.Frame {
	points := make(map[int64]float64)
	for i := 0; i < base.Fields[0].Len(); i++ {
		timestamp := base.Fields[0].At(i).(time.Time).UnixMilli()
		points[timestamp] = base.Fields[1].At(i).(float64)
	}
	for i := 0; i < delta.Fields[0].Len(); i++ {
		timestamp := delta.Fields[0].At(i).(time.Time).UnixMilli()
		points[timestamp] = delta.Fields[1].At(i).(float64)
	}
	timestamps := make([]int64, 0, len(points))
	for timestamp := range points {
		timestamps = append(timestamps, timestamp)
	}
	sort.Slice(timestamps, func(i, j int) bool { return timestamps[i] < timestamps[j] })
	times := make([]time.Time, 0, len(timestamps))
	values := make([]float64, 0, len(timestamps))
	for _, timestamp := range timestamps {
		times = append(times, time.UnixMilli(timestamp).UTC())
		values = append(values, points[timestamp])
	}
	merged := data.NewFrame(base.Name,
		data.NewField(base.Fields[0].Name, cloneLabels(base.Fields[0].Labels), times),
		data.NewField(base.Fields[1].Name, cloneLabels(base.Fields[1].Labels), values),
	)
	merged.RefID = base.RefID
	merged.Meta = cloneFrameMeta(delta.Meta)
	merged.Fields[0].Config = cloneFieldConfig(delta.Fields[0].Config)
	merged.Fields[1].Config = cloneFieldConfig(delta.Fields[1].Config)
	return merged
}

func cloneFrames(frames data.Frames) data.Frames {
	cloned := make(data.Frames, 0, len(frames))
	for _, frame := range frames {
		cloned = append(cloned, cloneFrame(frame))
	}
	return cloned
}

func cloneFrame(frame *data.Frame) *data.Frame {
	if frame == nil {
		return nil
	}
	if len(frame.Fields) == 0 {
		copyFrame := data.NewFrame(frame.Name)
		copyFrame.RefID = frame.RefID
		copyFrame.Meta = cloneFrameMeta(frame.Meta)
		return copyFrame
	}
	if len(frame.Fields) >= 2 && frame.Fields[0].Type() == data.FieldTypeTime && frame.Fields[1].Type() == data.FieldTypeFloat64 {
		return mergeTimeSeriesFrame(frame.EmptyCopy(), frame)
	}
	copyFrame := frame.EmptyCopy()
	copyFrame.RefID = frame.RefID
	copyFrame.Meta = cloneFrameMeta(frame.Meta)
	for row := 0; row < frame.Fields[0].Len(); row++ {
		copyFrame.AppendRow(frame.RowCopy(row)...)
	}
	return copyFrame
}

func cloneLabels(labels data.Labels) data.Labels {
	if labels == nil {
		return nil
	}
	cloned := make(data.Labels, len(labels))
	for key, value := range labels {
		cloned[key] = value
	}
	return cloned
}

func cloneFieldConfig(config *data.FieldConfig) *data.FieldConfig {
	if config == nil {
		return nil
	}
	cloned := *config
	return &cloned
}

func cloneFrameMeta(meta *data.FrameMeta) *data.FrameMeta {
	if meta == nil {
		return nil
	}
	cloned := *meta
	if custom, ok := meta.Custom.(map[string]any); ok {
		customCopy := make(map[string]any, len(custom))
		for key, value := range custom {
			customCopy[key] = value
		}
		cloned.Custom = customCopy
	}
	if meta.Notices != nil {
		cloned.Notices = append([]data.Notice(nil), meta.Notices...)
	}
	return &cloned
}
