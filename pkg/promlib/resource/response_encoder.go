package resource

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// jsonResponseEncoder is deliberately single-shot. A JSON resource response is
// fully buffered before it is sent, so there is no valid second body to write.
type jsonResponseEncoder struct {
	sender     backend.CallResourceResponseSender
	statusCode int
	headers    http.Header
	wrote      bool
}

func newJSONResponseEncoder(
	sender backend.CallResourceResponseSender,
	statusCode int,
	headers http.Header,
) *jsonResponseEncoder {
	return &jsonResponseEncoder{
		sender:     sender,
		statusCode: statusCode,
		headers:    headers,
	}
}

func (e *jsonResponseEncoder) write(body []byte) error {
	if e.wrote {
		return errors.New("JSON resource response was already written")
	}
	if err := e.sender.Send(&backend.CallResourceResponse{
		Status:  e.statusCode,
		Headers: e.headers,
		Body:    body,
	}); err != nil {
		return err
	}
	e.wrote = true
	return nil
}

func (e *jsonResponseEncoder) finish(streamErr error) error {
	return streamErr
}

type multiBatchErrorFrameBuilder func() multiBatchFrame

// multiBatchResponseEncoder is the only writer used after a downstream
// multibatch response has been selected. It accepts typed frames rather than
// arbitrary response bytes, so neither callers nor the generic resource error
// path can append ordinary JSON after MBRH.
//
// Streaming write contract:
//   - MBRH is written before the first batch, but is not a flush boundary by
//     itself.
//   - A batch is written as its MBBF header followed by its complete payload,
//     then flushed exactly once; never flush between the frame header and its
//     payload.
//   - Forwarding only needs fixed-size header and copy buffers. It must not
//     accumulate a whole batch payload merely to preserve these boundaries.
//   - If an error occurs after any MBBF bytes are written, stop the stream;
//     never append another frame or ordinary JSON to a possibly partial batch.
//   - Once multibatch bytes have been written, only multibatch frames may
//     follow; ordinary JSON is never a valid fallback body.
type multiBatchResponseEncoder struct {
	ctx             context.Context
	logger          log.Logger
	sender          backend.CallResourceResponseSender
	statusCode      int
	headers         http.Header
	logMessage      string
	buildErrorFrame multiBatchErrorFrameBuilder
	started         bool
	finished        bool
}

func newMultiBatchResponseEncoder(
	ctx context.Context,
	logger log.Logger,
	sender backend.CallResourceResponseSender,
	statusCode int,
	headers http.Header,
	logMessage string,
	buildErrorFrame multiBatchErrorFrameBuilder,
) *multiBatchResponseEncoder {
	return &multiBatchResponseEncoder{
		ctx:             ctx,
		logger:          logger,
		sender:          sender,
		statusCode:      statusCode,
		headers:         headers,
		logMessage:      logMessage,
		buildErrorFrame: buildErrorFrame,
	}
}

// start commits the selected multibatch encoding without a payload frame.
// Compact conversion uses this to preserve streaming behavior while it waits
// for the first upstream batch.
func (e *multiBatchResponseEncoder) start() error {
	if e.started {
		return nil
	}
	if err := e.send(multiBatchResponseHeader(), true); err != nil {
		return err
	}
	e.started = true
	return nil
}

// writeFrame is the only payload write operation for multibatch responses.
// The encoder serializes the typed frame itself, so it cannot emit raw JSON.
func (e *multiBatchResponseEncoder) writeFrame(frame multiBatchFrame) error {
	if e.finished {
		return errors.New("Prometheus multi-batch response was already finalized")
	}
	if err := validateMultiBatchFrame(frame); err != nil {
		return err
	}

	body := multiBatchFrameBytes(frame)
	includeHeaders := !e.started
	if includeHeaders {
		body = append(multiBatchResponseHeader(), body...)
	}
	if err := e.send(body, includeHeaders); err != nil {
		return err
	}
	e.started = true
	if frame.flags&multiBatchFinalFlag != 0 {
		e.finished = true
	}
	return nil
}

func (e *multiBatchResponseEncoder) finish(streamErr error) error {
	if streamErr == nil {
		return nil
	}

	var sendErr *multiBatchSendError
	if errors.As(streamErr, &sendErr) {
		return sendErr.err
	}
	if !e.started || e.finished {
		return streamErr
	}

	e.logger.FromContext(e.ctx).Error(e.logMessage, "error", streamErr)
	frame := e.buildErrorFrame()
	if err := e.writeFrame(frame); err != nil {
		if errors.As(err, &sendErr) {
			return sendErr.err
		}
		return err
	}
	return nil
}

func (e *multiBatchResponseEncoder) send(body []byte, includeHeaders bool) error {
	response := &backend.CallResourceResponse{
		Status: e.statusCode,
		Body:   body,
	}
	if includeHeaders {
		response.Headers = e.headers
	}
	if err := e.sender.Send(response); err != nil {
		return &multiBatchSendError{err: err}
	}
	return nil
}

type multiBatchSendError struct {
	err error
}

func (e *multiBatchSendError) Error() string {
	return e.err.Error()
}

func (e *multiBatchSendError) Unwrap() error {
	return e.err
}

func validateMultiBatchFrame(frame multiBatchFrame) error {
	if !isSupportedMultiBatchPayloadType(frame.payloadType) {
		return fmt.Errorf("unsupported Prometheus multi-batch payload type: %d", frame.payloadType)
	}
	if frame.flags&multiBatchReservedFlags != 0 {
		return fmt.Errorf("unsupported Prometheus multi-batch flags: %d", frame.flags)
	}
	switch frame.payloadEncoding {
	case multiBatchPayloadEncodingIdentity, multiBatchPayloadEncodingZstd:
		return nil
	default:
		return fmt.Errorf("unsupported Prometheus multi-batch payload encoding: %d", frame.payloadEncoding)
	}
}
