package api

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"net/http"
	"reflect"
	"sort"
	"time"
	"unicode/utf8"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/gtime"
	"github.com/grafana/grafana-plugin-sdk-go/data"

	"github.com/grafana/grafana/pkg/api/dtos"
	"github.com/grafana/grafana/pkg/promlib/models"
	contextmodel "github.com/grafana/grafana/pkg/services/contexthandler/model"
)

var errCompactQueryDataTooLarge = errors.New("compact query response exceeds encoding limits")
var errCompactQueryDataUnsupported = errors.New("query response does not satisfy compact-v1")

const (
	compactQueryDataHeader        = "X-Grafana-Query-Format"
	compactQueryDataVersion       = "compact-v1"
	compactQueryDataMediaType     = "application/vnd.grafana.querydata.compact;version=1"
	compactQueryDataMagic         = "GQD1"
	compactQueryDataBinaryVersion = 1

	compactResponseHeaderSize       = 32
	compactAxisRecordSize           = 24
	compactStringRecordSize         = 8
	compactResultHeaderSize         = 48
	compactFrameHeaderSize          = 48
	compactLabelRecordSize          = 8
	compactWriteChunkSize           = 64 * 1024
	maxCompactAxisPoints            = 5_000_000
	maxCompactRecordSize            = math.MaxUint32
	maxSafeInteger            int64 = 1<<53 - 1
	maxDurationMilliseconds         = math.MaxInt64 / int64(time.Millisecond)
)

type compactResultType uint16

const (
	compactResultTypeUnknown compactResultType = iota
	compactResultTypeMatrix
)

type compactFrameType uint16

const (
	compactFrameTypeUnknown compactFrameType = iota
	compactFrameTypeTimeSeriesMulti
)

const compactResultFlagCalculatedMinStep uint32 = 1 << 0

type compactQueryDataResponse struct {
	Axes              []compactRegularTimeAxis
	Strings           []string
	StringBytesLength uint32
	Results           map[string]compactDataResponse
}

type compactDataResponse struct {
	Status                backend.Status
	RefIDStringID         uint32
	ErrorStringID         uint32
	ExecutedQueryStringID uint32
	CalculatedMinStep     int64
	ResultType            compactResultType
	FrameType             compactFrameType
	FrameTypeVersionMajor uint16
	FrameTypeVersionMinor uint16
	Flags                 uint32
	Frames                []compactFrame
	RecordLength          uint32
}

type compactFrame struct {
	Frame                     *data.Frame
	AxisID                    uint32
	FrameNameStringID         uint32
	FrameRefIDStringID        uint32
	ValueNameStringID         uint32
	DisplayNameFromDSStringID uint32
	Labels                    []compactLabel
	Presence                  []byte
	PresentCount              uint32
	Padding                   int
	RecordLength              uint32
}

type compactLabel struct {
	NameStringID  uint32
	ValueStringID uint32
}

type compactRegularTimeAxis struct {
	Start int64
	Step  int64
	Count uint32
}

type compactQueryRequest struct {
	Start        time.Time
	End          time.Time
	UTCOffsetSec int64
}

type compactQueryDataStreamingResponse struct {
	body *compactQueryDataResponse
}

type compactStringTable struct {
	values      []string
	ids         map[string]uint32
	bytesLength uint64
}

func newCompactStringTable() *compactStringTable {
	return &compactStringTable{
		values: []string{""},
		ids:    map[string]uint32{"": 0},
	}
}

func (t *compactStringTable) intern(value string) (uint32, error) {
	if !utf8.ValidString(value) {
		return 0, errCompactQueryDataUnsupported
	}
	if id, ok := t.ids[value]; ok {
		return id, nil
	}
	if uint64(len(t.values)) >= uint64(math.MaxUint32) || t.bytesLength+uint64(len(value)) > math.MaxUint32 {
		return 0, errCompactQueryDataTooLarge
	}
	id := uint32(len(t.values))
	t.values = append(t.values, value)
	t.ids[value] = id
	t.bytesLength += uint64(len(value))
	return id, nil
}

func (r compactQueryDataStreamingResponse) Status() int {
	return http.StatusOK
}

func (r compactQueryDataStreamingResponse) Body() []byte {
	return nil
}

func (r compactQueryDataStreamingResponse) WriteTo(ctx *contextmodel.ReqContext) {
	header := ctx.Resp.Header()
	header.Set("Content-Type", compactQueryDataMediaType)
	header.Set("Vary", compactQueryDataHeader+", Accept-Encoding")
	ctx.Resp.WriteHeader(r.Status())

	writer := compactBinaryWriter{context: ctx.Req.Context(), writer: ctx.Resp}
	writeCompactQueryDataResponse(r.body, &writer)
	if writer.err != nil {
		ctx.Logger.Error("Error writing compact query response", "err", writer.err)
	}
}

// Compact v1 is intentionally all-or-nothing. Every successful frame must
// satisfy the executed regular-grid invariant before response streaming starts.
func newCompactQueryDataResponse(qdr *backend.QueryDataResponse, requests map[string]compactQueryRequest) (*compactQueryDataResponse, error) {
	return newCompactQueryDataResponseContext(context.Background(), qdr, requests)
}

func newCompactQueryDataResponseContext(
	ctx context.Context,
	qdr *backend.QueryDataResponse,
	requests map[string]compactQueryRequest,
) (*compactQueryDataResponse, error) {
	result := &compactQueryDataResponse{
		Results: make(map[string]compactDataResponse, len(qdr.Responses)),
	}
	strings := newCompactStringTable()
	axisIDs := make(map[compactRegularTimeAxis]uint32)
	totalAxisPoints := 0

	refIDs := make([]string, 0, len(qdr.Responses))
	for refID := range qdr.Responses {
		refIDs = append(refIDs, refID)
	}
	sort.Strings(refIDs)

	for _, refID := range refIDs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		dataResponse := qdr.Responses[refID]
		refIDStringID, err := strings.intern(refID)
		if err != nil {
			return nil, err
		}
		compactResponse := compactDataResponse{
			Status:        dataResponse.Status,
			RefIDStringID: refIDStringID,
			Frames:        make([]compactFrame, 0, len(dataResponse.Frames)),
		}
		if dataResponse.Error != nil {
			compactResponse.ErrorStringID, err = strings.intern(dataResponse.Error.Error())
			if err != nil {
				return nil, err
			}
		}

		if dataResponse.Error == nil && (dataResponse.Status == 0 || dataResponse.Status == backend.StatusOK) {
			if err := populateCompactResultMetadata(&compactResponse, dataResponse.Frames, strings); err != nil {
				return nil, err
			}
			if onlyNoDataFrames(dataResponse.Frames) {
				recordLength, ok := compactResultRecordLength(compactResponse)
				if !ok {
					return nil, errCompactQueryDataTooLarge
				}
				compactResponse.RecordLength = recordLength
				result.Results[refID] = compactResponse
				continue
			}

			axis, eligible := getExecutedTimeAxis(dataResponse.Frames, requests[refID])
			if !eligible {
				return nil, errCompactQueryDataUnsupported
			}

			axisID, exists := axisIDs[axis]
			if !exists {
				if totalAxisPoints+int(axis.Count) > maxCompactAxisPoints {
					return nil, errCompactQueryDataTooLarge
				}
				axisID = uint32(len(result.Axes))
				axisIDs[axis] = axisID
				result.Axes = append(result.Axes, axis)
				totalAxisPoints += int(axis.Count)
			}

			for _, frame := range dataResponse.Frames {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				if isNoDataFrame(frame) {
					continue
				}
				compactFrame, err := newCompactFrame(ctx, frame, axis, axisID, strings)
				if err != nil {
					return nil, err
				}
				compactResponse.Frames = append(compactResponse.Frames, compactFrame)
			}
		}

		recordLength, ok := compactResultRecordLength(compactResponse)
		if !ok {
			return nil, errCompactQueryDataTooLarge
		}
		compactResponse.RecordLength = recordLength
		result.Results[refID] = compactResponse
	}
	result.Strings = strings.values
	result.StringBytesLength = uint32(strings.bytesLength)

	return result, nil
}

func populateCompactResultMetadata(response *compactDataResponse, frames data.Frames, strings *compactStringTable) error {
	var resultType compactResultType
	var frameType compactFrameType
	var version data.FrameTypeVersion
	hasDataFrame := false
	hasNoDataFrame := false

	for frameIndex, frame := range frames {
		if frame == nil || frame.Meta == nil {
			return errCompactQueryDataUnsupported
		}
		if !compactFrameMetaSupported(frame.Meta) {
			return errCompactQueryDataUnsupported
		}

		custom, ok := frame.Meta.Custom.(map[string]any)
		if frame.Meta.Custom != nil && !ok {
			return errCompactQueryDataUnsupported
		}
		if !compactCustomMetaSupported(custom) {
			return errCompactQueryDataUnsupported
		}

		if frame.Meta.ExecutedQueryString != "" {
			if frameIndex != 0 || response.ExecutedQueryStringID != 0 {
				return errCompactQueryDataUnsupported
			}
			id, err := strings.intern(frame.Meta.ExecutedQueryString)
			if err != nil {
				return err
			}
			response.ExecutedQueryStringID = id
		}
		if calculatedMinStep, exists := custom["calculatedMinStep"]; exists {
			if frameIndex != 0 || response.Flags&compactResultFlagCalculatedMinStep != 0 {
				return errCompactQueryDataUnsupported
			}
			value, ok := calculatedMinStep.(int64)
			if !ok || value <= 0 {
				return errCompactQueryDataUnsupported
			}
			response.CalculatedMinStep = value
			response.Flags |= compactResultFlagCalculatedMinStep
		}

		if isNoDataFrame(frame) {
			if frame.Meta.Type != data.FrameTypeUnknown || !frame.Meta.TypeVersion.IsZero() {
				return errCompactQueryDataUnsupported
			}
			if _, exists := custom["resultType"]; exists {
				return errCompactQueryDataUnsupported
			}
			hasNoDataFrame = true
			continue
		}
		hasDataFrame = true
		if frame.Meta.Type != data.FrameTypeTimeSeriesMulti || frame.Meta.TypeVersion[0] > math.MaxUint16 || frame.Meta.TypeVersion[1] > math.MaxUint16 {
			return errCompactQueryDataUnsupported
		}
		if custom["resultType"] != models.ResultTypeMatrix.String() {
			return errCompactQueryDataUnsupported
		}
		if resultType == compactResultTypeUnknown {
			resultType = compactResultTypeMatrix
			frameType = compactFrameTypeTimeSeriesMulti
			version = frame.Meta.TypeVersion
		} else if frame.Meta.TypeVersion != version {
			return errCompactQueryDataUnsupported
		}
	}
	if hasDataFrame && hasNoDataFrame {
		return errCompactQueryDataUnsupported
	}

	response.ResultType = resultType
	response.FrameType = frameType
	response.FrameTypeVersionMajor = uint16(version[0])
	response.FrameTypeVersionMinor = uint16(version[1])
	return nil
}

func compactFrameMetaSupported(meta *data.FrameMeta) bool {
	return meta.Path == "" && meta.PathSeparator == "" && len(meta.Stats) == 0 && len(meta.Notices) == 0 &&
		meta.Channel == "" && meta.PreferredVisualization == "" && meta.PreferredVisualizationPluginID == "" &&
		meta.DataTopic == "" && len(meta.UniqueRowIDFields) == 0
}

func compactCustomMetaSupported(custom map[string]any) bool {
	for key := range custom {
		if key != "resultType" && key != "calculatedMinStep" {
			return false
		}
	}
	return true
}

func getExecutedTimeAxis(frames data.Frames, request compactQueryRequest) (compactRegularTimeAxis, bool) {
	if request.Start.IsZero() || request.End.IsZero() || request.End.Before(request.Start) {
		return compactRegularTimeAxis{}, false
	}

	for _, frame := range frames {
		if isNoDataFrame(frame) || len(frame.Fields) == 0 || frame.Fields[0] == nil ||
			frame.Fields[0].Type() != data.FieldTypeTime || frame.Fields[0].Config == nil {
			continue
		}

		step := int64(frame.Fields[0].Config.Interval)
		if float64(step) != frame.Fields[0].Config.Interval || step <= 0 ||
			step > maxSafeInteger || step > maxDurationMilliseconds {
			return compactRegularTimeAxis{}, false
		}
		start := models.AlignTimeRange(request.Start, time.Duration(step)*time.Millisecond, request.UTCOffsetSec).UnixMilli()
		end := models.AlignTimeRange(request.End, time.Duration(step)*time.Millisecond, request.UTCOffsetSec).UnixMilli()
		if start < -maxSafeInteger || start > maxSafeInteger || end < start || end > maxSafeInteger {
			return compactRegularTimeAxis{}, false
		}
		count := (end-start)/step + 1
		if count < 1 || count > math.MaxUint32 ||
			count-1 > (maxSafeInteger-start)/step {
			return compactRegularTimeAxis{}, false
		}
		return compactRegularTimeAxis{Start: start, Step: step, Count: uint32(count)}, true
	}
	return compactRegularTimeAxis{}, false
}

func onlyNoDataFrames(frames data.Frames) bool {
	for _, frame := range frames {
		if !isNoDataFrame(frame) {
			return false
		}
	}
	return true
}

func isNoDataFrame(frame *data.Frame) bool {
	return frame != nil && len(frame.Fields) == 0
}

func newCompactFrame(
	ctx context.Context,
	frame *data.Frame,
	axis compactRegularTimeAxis,
	axisID uint32,
	strings *compactStringTable,
) (compactFrame, error) {
	if frame == nil || len(frame.Fields) != 2 || frame.Fields[0] == nil || frame.Fields[1] == nil ||
		frame.Fields[0].Type() != data.FieldTypeTime || frame.Fields[1].Type() != data.FieldTypeFloat64 ||
		frame.Fields[0].Name != data.TimeSeriesTimeFieldName || len(frame.Fields[0].Labels) != 0 ||
		!reflect.DeepEqual(frame.Fields[0].Config, &data.FieldConfig{Interval: float64(axis.Step)}) ||
		!compactValueFieldConfigSupported(frame.Fields[1].Config) {
		return compactFrame{}, errCompactQueryDataUnsupported
	}

	rowCount, err := frame.RowLen()
	if err != nil || rowCount < 0 || uint64(rowCount) > uint64(axis.Count) {
		return compactFrame{}, errCompactQueryDataUnsupported
	}

	presenceLength := uint64(0)
	if rowCount != int(axis.Count) {
		presenceLength = (uint64(axis.Count) + 7) / 8
	}
	metadataLength := uint64(compactFrameHeaderSize) + uint64(len(frame.Fields[1].Labels))*compactLabelRecordSize + presenceLength
	padding := paddingTo8(int(metadataLength))
	recordLength := metadataLength + uint64(padding) + uint64(rowCount)*8
	if metadataLength > maxCompactRecordSize || recordLength > maxCompactRecordSize {
		return compactFrame{}, errCompactQueryDataTooLarge
	}

	presence, err := compactFramePresence(ctx, frame.Fields[0], axis, rowCount, int(presenceLength))
	if err != nil {
		return compactFrame{}, err
	}

	frameNameStringID, err := strings.intern(frame.Name)
	if err != nil {
		return compactFrame{}, err
	}
	frameRefIDStringID, err := strings.intern(frame.RefID)
	if err != nil {
		return compactFrame{}, err
	}
	valueNameStringID, err := strings.intern(frame.Fields[1].Name)
	if err != nil {
		return compactFrame{}, err
	}
	displayNameFromDS := ""
	if frame.Fields[1].Config != nil {
		displayNameFromDS = frame.Fields[1].Config.DisplayNameFromDS
	}
	displayNameFromDSStringID, err := strings.intern(displayNameFromDS)
	if err != nil {
		return compactFrame{}, err
	}

	labelNames := make([]string, 0, len(frame.Fields[1].Labels))
	for name := range frame.Fields[1].Labels {
		labelNames = append(labelNames, name)
	}
	sort.Strings(labelNames)
	labels := make([]compactLabel, 0, len(labelNames))
	for _, name := range labelNames {
		nameStringID, err := strings.intern(name)
		if err != nil {
			return compactFrame{}, err
		}
		valueStringID, err := strings.intern(frame.Fields[1].Labels[name])
		if err != nil {
			return compactFrame{}, err
		}
		labels = append(labels, compactLabel{NameStringID: nameStringID, ValueStringID: valueStringID})
	}

	return compactFrame{
		Frame:                     frame,
		AxisID:                    axisID,
		FrameNameStringID:         frameNameStringID,
		FrameRefIDStringID:        frameRefIDStringID,
		ValueNameStringID:         valueNameStringID,
		DisplayNameFromDSStringID: displayNameFromDSStringID,
		Labels:                    labels,
		Presence:                  presence,
		PresentCount:              uint32(rowCount),
		Padding:                   padding,
		RecordLength:              uint32(recordLength),
	}, nil
}

func compactFramePresence(
	ctx context.Context,
	timeField *data.Field,
	axis compactRegularTimeAxis,
	rowCount int,
	presenceLength int,
) ([]byte, error) {
	axisEnd := axis.Start + int64(axis.Count-1)*axis.Step
	if rowCount == int(axis.Count) {
		for rowIndex := 0; rowIndex < rowCount; rowIndex++ {
			if rowIndex%compactWriteChunkSize == 0 {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
			}
			timestamp := *timeField.PointerAt(rowIndex).(*time.Time)
			if timestamp.Nanosecond()%int(time.Millisecond) != 0 ||
				timestamp.UnixMilli() != axis.Start+int64(rowIndex)*axis.Step {
				return nil, errCompactQueryDataUnsupported
			}
		}
		return nil, nil
	}

	presence := make([]byte, presenceLength)
	previousIndex := int64(-1)
	for rowIndex := 0; rowIndex < rowCount; rowIndex++ {
		if rowIndex%compactWriteChunkSize == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		timestamp := *timeField.PointerAt(rowIndex).(*time.Time)
		if timestamp.Nanosecond()%int(time.Millisecond) != 0 {
			return nil, errCompactQueryDataUnsupported
		}
		timestampMillis := timestamp.UnixMilli()
		if timestampMillis < axis.Start || timestampMillis > axisEnd {
			return nil, errCompactQueryDataUnsupported
		}
		delta := timestampMillis - axis.Start
		if delta%axis.Step != 0 {
			return nil, errCompactQueryDataUnsupported
		}
		gridIndex := delta / axis.Step
		if gridIndex <= previousIndex {
			return nil, errCompactQueryDataUnsupported
		}
		presence[gridIndex>>3] |= 1 << (gridIndex & 7)
		previousIndex = gridIndex
	}
	return presence, nil
}

func compactValueFieldConfigSupported(config *data.FieldConfig) bool {
	if config == nil {
		return true
	}
	return reflect.DeepEqual(config, &data.FieldConfig{DisplayNameFromDS: config.DisplayNameFromDS})
}

func newCompactQueryRequests(reqDTO dtos.MetricRequest, supportLocalTimeRange bool) map[string]compactQueryRequest {
	requests := make(map[string]compactQueryRequest, len(reqDTO.Queries))
	for _, query := range reqDTO.Queries {
		from, to := reqDTO.From, reqDTO.To
		if supportLocalTimeRange {
			if timeRange, ok := query.CheckGet("timeRange"); ok {
				from = timeRange.Get("from").MustString()
				to = timeRange.Get("to").MustString()
			}
		}
		queryTimeRange := gtime.NewTimeRange(from, to)
		requests[query.Get("refId").MustString("A")] = compactQueryRequest{
			Start:        queryTimeRange.GetFromAsTimeUTC(),
			End:          queryTimeRange.GetToAsTimeUTC(),
			UTCOffsetSec: query.Get("utcOffsetSec").MustInt64(),
		}
	}
	return requests
}

func compactResultRecordLength(response compactDataResponse) (uint32, bool) {
	length := uint64(compactResultHeaderSize)
	for _, frame := range response.Frames {
		length += uint64(frame.RecordLength)
	}
	return uint32(length), length <= maxCompactRecordSize
}

func paddingTo8(length int) int {
	return (8 - length%8) % 8
}

func writeCompactQueryDataResponse(response *compactQueryDataResponse, writer *compactBinaryWriter) {
	writer.writeBytes([]byte(compactQueryDataMagic))
	writer.writeUint16(compactQueryDataBinaryVersion)
	writer.writeUint16(0)
	writer.writeUint32(uint32(len(response.Axes)))
	writer.writeUint32(uint32(len(response.Results)))
	writer.writeUint32(uint32(len(response.Strings)))
	writer.writeUint32(response.StringBytesLength)
	writer.writeUint64(0)

	for _, axis := range response.Axes {
		if writer.err != nil {
			return
		}
		writer.writeInt64(axis.Start)
		writer.writeUint64(uint64(axis.Step))
		writer.writeUint32(axis.Count)
		writer.writeUint32(0)
	}

	stringOffset := uint32(0)
	for _, value := range response.Strings {
		if writer.err != nil {
			return
		}
		writer.writeUint32(stringOffset)
		writer.writeUint32(uint32(len(value)))
		stringOffset += uint32(len(value))
	}
	for _, value := range response.Strings {
		if writer.err != nil {
			return
		}
		writer.writeBytes([]byte(value))
	}
	writer.writeZeros(paddingTo8(int(response.StringBytesLength)))

	refIDs := make([]string, 0, len(response.Results))
	for refID := range response.Results {
		refIDs = append(refIDs, refID)
	}
	sort.Strings(refIDs)

	for _, refID := range refIDs {
		if writer.err != nil {
			return
		}
		writeCompactDataResponse(response.Results[refID], writer)
	}
}

func writeCompactDataResponse(response compactDataResponse, writer *compactBinaryWriter) {
	writer.writeUint32(response.RecordLength)
	writer.writeUint32(response.RefIDStringID)
	writer.writeUint32(response.ErrorStringID)
	writer.writeUint32(response.ExecutedQueryStringID)
	writer.writeInt32(int32(response.Status))
	writer.writeUint32(uint32(len(response.Frames)))
	writer.writeInt64(response.CalculatedMinStep)
	writer.writeUint16(uint16(response.ResultType))
	writer.writeUint16(uint16(response.FrameType))
	writer.writeUint16(response.FrameTypeVersionMajor)
	writer.writeUint16(response.FrameTypeVersionMinor)
	writer.writeUint32(response.Flags)
	writer.writeUint32(0)

	for _, frame := range response.Frames {
		if writer.err != nil {
			return
		}
		writeCompactFrame(frame, writer)
	}
}

func writeCompactFrame(frame compactFrame, writer *compactBinaryWriter) {
	writer.writeUint32(frame.RecordLength)
	writer.writeUint32(frame.AxisID)
	writer.writeUint32(frame.PresentCount)
	writer.writeUint32(uint32(len(frame.Presence)))
	writer.writeUint32(frame.FrameNameStringID)
	writer.writeUint32(frame.FrameRefIDStringID)
	writer.writeUint32(frame.ValueNameStringID)
	writer.writeUint32(frame.DisplayNameFromDSStringID)
	writer.writeUint32(uint32(len(frame.Labels)))
	writer.writeUint32(0)
	writer.writeUint64(0)
	for _, label := range frame.Labels {
		if writer.err != nil {
			return
		}
		writer.writeUint32(label.NameStringID)
		writer.writeUint32(label.ValueStringID)
	}
	writer.writeBytes(frame.Presence)
	writer.writeZeros(frame.Padding)
	if writer.err != nil {
		return
	}

	if frame.Frame.Fields[1].Len() == 0 {
		return
	}

	valueBytes := writer.valueBuffer()
	valueOffset := 0
	for i := 0; i < frame.Frame.Fields[1].Len(); i++ {
		value := *frame.Frame.Fields[1].PointerAt(i).(*float64)
		binary.LittleEndian.PutUint64(valueBytes[valueOffset:], math.Float64bits(value))
		valueOffset += 8
		if valueOffset == len(valueBytes) {
			writer.writeBytes(valueBytes)
			if writer.err != nil {
				return
			}
			valueOffset = 0
		}
	}
	writer.writeBytes(valueBytes[:valueOffset])
}

type compactBinaryWriter struct {
	context      context.Context
	writer       io.Writer
	err          error
	scratch      [8]byte
	valueScratch []byte
}

func (w *compactBinaryWriter) valueBuffer() []byte {
	if w.valueScratch == nil {
		w.valueScratch = make([]byte, compactWriteChunkSize)
	}
	return w.valueScratch
}

func (w *compactBinaryWriter) writeUint16(value uint16) {
	binary.LittleEndian.PutUint16(w.scratch[:2], value)
	w.writeBytes(w.scratch[:2])
}

func (w *compactBinaryWriter) writeUint32(value uint32) {
	binary.LittleEndian.PutUint32(w.scratch[:4], value)
	w.writeBytes(w.scratch[:4])
}

func (w *compactBinaryWriter) writeInt32(value int32) {
	w.writeUint32(uint32(value))
}

func (w *compactBinaryWriter) writeUint64(value uint64) {
	binary.LittleEndian.PutUint64(w.scratch[:], value)
	w.writeBytes(w.scratch[:])
}

func (w *compactBinaryWriter) writeInt64(value int64) {
	w.writeUint64(uint64(value))
}

func (w *compactBinaryWriter) writeZeros(length int) {
	var zeros [8]byte
	for length > 0 {
		chunk := min(length, len(zeros))
		w.writeBytes(zeros[:chunk])
		length -= chunk
	}
}

func (w *compactBinaryWriter) writeBytes(value []byte) {
	if w.err != nil {
		return
	}
	for len(value) > 0 {
		if w.context != nil {
			if err := w.context.Err(); err != nil {
				w.err = err
				return
			}
		}
		chunk := min(len(value), compactWriteChunkSize)
		var written int
		written, w.err = w.writer.Write(value[:chunk])
		if w.err != nil {
			return
		}
		if written != chunk {
			w.err = io.ErrShortWrite
			return
		}
		value = value[chunk:]
	}
}
