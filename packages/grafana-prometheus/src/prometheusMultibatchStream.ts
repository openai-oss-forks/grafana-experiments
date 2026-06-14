import { DataQueryRequest, DataQueryResponse, LoadingState, rangeUtil } from '@grafana/data';
import { config, toDataQueryResponse } from '@grafana/runtime';
import { Observable } from 'rxjs';
import { ZSTDDecoder } from 'zstddec';

import { PromQuery } from './types';

export const MULTIBATCH_CONTENT_TYPE = 'application/prometheus.multibatch';
export const MULTIBATCH_PREFERRED_CONTENT_TYPE = 'application/com.openai.prometheus.multibatch';
export const MULTIBATCH_ACCEPT_HEADER = `${MULTIBATCH_PREFERRED_CONTENT_TYPE}; version=1, ${MULTIBATCH_CONTENT_TYPE}; version=1, application/jsonl`;
const QUERY_DATA_COMPACT_HEADER = 'X-Grafana-Query-Format';
const QUERY_DATA_COMPACT_MEDIA_TYPE = 'application/vnd.grafana.querydata.compact;version=1';
const QUERY_DATA_COMPACT_VERSION = 'compact-v1';
const MULTIBATCH_REF_ID_HEADER = 'X-Grafana-Prometheus-Multibatch-Ref-Id';
const MULTIBATCH_LEGEND_FORMAT_HEADER = 'X-Grafana-Prometheus-Multibatch-Legend-Format';
const MULTIBATCH_UTC_OFFSET_HEADER = 'X-Grafana-Prometheus-Multibatch-UTC-Offset-Sec';

const FRAME_HEADER_SIZE = 12;
const FINAL_BATCH_FLAG = 1;
const RESERVED_FLAGS_MASK = 0xfe;
const PAYLOAD_TYPE_COMPACT_V1 = 2;
const PAYLOAD_ENCODING_IDENTITY = 0;
const PAYLOAD_ENCODING_ZSTD = 1;
const RESPONSE_HEADER_MAGIC = 'MBRH';
const BATCH_FRAME_MAGIC = 'MBBF';

type BatchHandler = (payload: Uint8Array, isFinal: boolean) => Promise<void> | void;

export interface MultiBatchFrame {
  payloadType: number;
  flags: number;
  payloadEncoding: number;
  payload: Uint8Array;
}

class ZstdPayloadDecoder {
  private decoder?: ZSTDDecoder;

  async decode(payload: Uint8Array, encoding: number): Promise<Uint8Array> {
    if (encoding === PAYLOAD_ENCODING_IDENTITY) {
      return payload;
    }

    if (encoding !== PAYLOAD_ENCODING_ZSTD) {
      throw new Error(`Unsupported Prometheus multi-batch payload encoding: ${encoding}`);
    }

    if (!this.decoder) {
      this.decoder = new ZSTDDecoder();
      await this.decoder.init();
    }

    return this.decoder.decode(payload);
  }
}

export class MultiBatchFrameDecoder {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private sawResponseHeader = false;
  private sawFinalBatch = false;

  push(chunk: Uint8Array): MultiBatchFrame[] {
    this.buffer = concatBytes(this.buffer, chunk);
    const frames: MultiBatchFrame[] = [];

    while (this.buffer.byteLength >= FRAME_HEADER_SIZE) {
      const header = this.buffer.subarray(0, FRAME_HEADER_SIZE);
      const magic = String.fromCharCode(...header.subarray(0, 4));

      if (magic === RESPONSE_HEADER_MAGIC) {
        const version = header[4];
        if (version !== 1) {
          throw new Error(`Unsupported Prometheus multi-batch response header version: ${version}`);
        }

        if (this.sawResponseHeader || frames.length > 0) {
          throw new Error('Prometheus multi-batch response included a duplicate response header');
        }

        if (header.subarray(5).some((byte) => byte !== 0)) {
          throw new Error('Unsupported Prometheus multi-batch response header');
        }

        this.sawResponseHeader = true;
        this.buffer = this.buffer.subarray(FRAME_HEADER_SIZE);
        continue;
      }

      if (magic !== BATCH_FRAME_MAGIC) {
        throw new Error('Invalid Prometheus multi-batch frame magic');
      }

      const version = header[4];
      if (version !== 1) {
        throw new Error(`Unsupported Prometheus multi-batch frame version: ${version}`);
      }

      const payloadLength = new DataView(header.buffer, header.byteOffset + 8, 4).getUint32(0, false);
      const frameLength = FRAME_HEADER_SIZE + payloadLength;
      if (this.buffer.byteLength < frameLength) {
        break;
      }

      if (this.sawFinalBatch) {
        throw new Error('Prometheus multi-batch response included data after the final batch');
      }

      const frame: MultiBatchFrame = {
        payloadType: header[5],
        flags: header[6],
        payloadEncoding: header[7],
        payload: this.buffer.subarray(FRAME_HEADER_SIZE, frameLength),
      };

      if ((frame.flags & RESERVED_FLAGS_MASK) !== 0) {
        throw new Error(`Unsupported Prometheus multi-batch frame flags: ${frame.flags}`);
      }

      if (frame.payloadEncoding !== PAYLOAD_ENCODING_IDENTITY && frame.payloadEncoding !== PAYLOAD_ENCODING_ZSTD) {
        throw new Error(`Unsupported Prometheus multi-batch payload encoding: ${frame.payloadEncoding}`);
      }

      if (!this.sawResponseHeader) {
        throw new Error('Prometheus multi-batch response missing response header');
      }

      if (frame.payloadType !== PAYLOAD_TYPE_COMPACT_V1) {
        throw new Error(`Unsupported Prometheus multi-batch payload type: ${frame.payloadType}`);
      }

      if ((frame.flags & FINAL_BATCH_FLAG) !== 0) {
        this.sawFinalBatch = true;
      }

      frames.push(frame);
      this.buffer = this.buffer.subarray(frameLength);
    }

    return frames;
  }

  finish() {
    if (this.buffer.byteLength > 0) {
      throw new Error('Truncated Prometheus multi-batch frame');
    }

    if (!this.sawFinalBatch) {
      throw new Error('Prometheus multi-batch response ended without a final batch');
    }
  }
}

export function isMultiBatchContentType(contentType: string | null | undefined): boolean {
  if (!contentType) {
    return false;
  }

  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  return mediaType === MULTIBATCH_CONTENT_TYPE || mediaType === MULTIBATCH_PREFERRED_CONTENT_TYPE;
}

function isCompactContentType(contentType: string | null | undefined): boolean {
  if (!contentType) {
    return false;
  }

  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  return mediaType === QUERY_DATA_COMPACT_MEDIA_TYPE.split(';')[0];
}

export async function decodeMultiBatchFrames(chunks: Uint8Array[], onBatch: BatchHandler): Promise<void> {
  const frameDecoder = new MultiBatchFrameDecoder();
  const payloadDecoder = new ZstdPayloadDecoder();

  for (const chunk of chunks) {
    for (const frame of frameDecoder.push(chunk)) {
      const payload = await payloadDecoder.decode(frame.payload, frame.payloadEncoding);
      await onBatch(payload, (frame.flags & FINAL_BATCH_FLAG) !== 0);
    }
  }

  frameDecoder.finish();
}

export function queryPrometheusMultiBatch(
  datasourceUid: string,
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  options: {
    httpMethod: string;
    customQueryParameters: URLSearchParams;
    minInterval?: string;
    queryTimeout?: string;
  }
): Observable<DataQueryResponse> {
  return new Observable<DataQueryResponse>((subscriber) => {
    const abortController = new AbortController();

    streamQueryRange(datasourceUid, request, target, options, abortController.signal, (response) => {
      subscriber.next(response);
    })
      .then(() => {
        subscriber.complete();
      })
      .catch((error) => {
        if (!abortController.signal.aborted) {
          subscriber.error(error);
        }
      });

    return () => abortController.abort();
  });
}

async function streamQueryRange(
  datasourceUid: string,
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  options: {
    httpMethod: string;
    customQueryParameters: URLSearchParams;
    minInterval?: string;
    queryTimeout?: string;
  },
  signal: AbortSignal,
  emit: (response: DataQueryResponse) => void
) {
  const method = options.httpMethod.toUpperCase();
  const response = await fetch(buildResourceUrl(datasourceUid, request, target, options), {
    body: method === 'POST' ? buildQueryParams(request, target, options).toString() : undefined,
    credentials: 'same-origin',
    headers: {
      Accept: MULTIBATCH_ACCEPT_HEADER,
      [QUERY_DATA_COMPACT_HEADER]: QUERY_DATA_COMPACT_VERSION,
      [MULTIBATCH_REF_ID_HEADER]: target.refId ?? 'A',
      [MULTIBATCH_LEGEND_FORMAT_HEADER]: target.legendFormat ?? '',
      [MULTIBATCH_UTC_OFFSET_HEADER]: String(target.utcOffsetSec ?? 0),
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    method,
    signal,
  });

  if (!isMultiBatchContentType(response.headers.get('Content-Type'))) {
    const body = await response.arrayBuffer();
    if (!response.ok && !isCompactContentType(response.headers.get('Content-Type'))) {
      throw new Error(new TextDecoder().decode(body));
    }
    emit(decodeCompactQueryDataResponse(body, response.headers, request, target, LoadingState.Done));
    return;
  }

  if (!response.body) {
    throw new Error('Prometheus multi-batch response did not include a readable body');
  }

  const frameDecoder = new MultiBatchFrameDecoder();
  const payloadDecoder = new ZstdPayloadDecoder();
  const reader = response.body.getReader();

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      for (const frame of frameDecoder.push(result.value)) {
        const payload = await payloadDecoder.decode(frame.payload, frame.payloadEncoding);
        const isFinal = (frame.flags & FINAL_BATCH_FLAG) !== 0;
        emit(
          decodeCompactQueryDataResponse(
            payload,
            compactHeaders(),
            request,
            target,
            isFinal ? LoadingState.Done : LoadingState.Streaming
          )
        );

        if (!isFinal) {
          await yieldToBrowser();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  frameDecoder.finish();
}

function decodeCompactQueryDataResponse(
  payload: Uint8Array | ArrayBuffer,
  headers: Headers,
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  state: LoadingState
): DataQueryResponse {
  const arrayBuffer = isArrayBuffer(payload) ? payload : copyArrayBuffer(payload);
  return {
    ...toDataQueryResponse(
      {
        data: arrayBuffer,
        headers,
      },
      request.targets.length === 1 ? request.targets : [target],
      true
    ),
    state,
  };
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function compactHeaders(): Headers {
  return new Headers({ 'content-type': QUERY_DATA_COMPACT_MEDIA_TYPE });
}

function copyArrayBuffer(payload: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(payload.byteLength);
  copy.set(payload);
  return copy.buffer;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildResourceUrl(
  datasourceUid: string,
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  options: {
    httpMethod: string;
    customQueryParameters: URLSearchParams;
    minInterval?: string;
    queryTimeout?: string;
  }
): string {
  const path = `${config.appSubUrl ?? ''}/api/datasources/uid/${encodeURIComponent(
    datasourceUid
  )}/resources/api/v1/query_range`;

  if (options.httpMethod.toUpperCase() === 'POST') {
    return path;
  }

  const params = buildQueryParams(request, target, options);
  return `${path}?${params.toString()}`;
}

function buildQueryParams(
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  options: {
    customQueryParameters: URLSearchParams;
    minInterval?: string;
    queryTimeout?: string;
  }
): URLSearchParams {
  const step = getPrometheusStepSeconds(request, target, options.minInterval);
  const range = getAlignedPrometheusTimeRange(request, target, step);
  const params = new URLSearchParams(options.customQueryParameters);
  params.set('query', target.expr);
  params.set('start', String(range.start));
  params.set('end', String(range.end));
  params.set('step', String(step));
  if (options.queryTimeout) {
    params.set('timeout', options.queryTimeout);
  }
  return params;
}

export function getPrometheusStepSeconds(
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  minInterval?: string
): number {
  const minIntervalMs = Math.max(
    intervalToMs(minInterval),
    intervalToMs(target.interval),
    intervalToMs(target.stepSize)
  );
  const intervalFactor = target.stepSize ? 1 : (target.intervalFactor ?? 1);
  const intervalMs = Math.max(request.intervalMs ?? 0, minIntervalMs) * intervalFactor;
  return Math.max(1, Math.ceil(intervalMs / 1000));
}

function getAlignedPrometheusTimeRange(
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  stepSeconds: number
): { start: number; end: number } {
  const offsetSeconds = target.utcOffsetSec ?? 0;

  return {
    start: alignPrometheusTime(request.range.from.valueOf(), stepSeconds, offsetSeconds),
    end: alignPrometheusTime(request.range.to.valueOf(), stepSeconds, offsetSeconds),
  };
}

function alignPrometheusTime(timestampMs: number, stepSeconds: number, offsetSeconds: number): number {
  const stepMs = stepSeconds * 1000;
  const offsetMs = offsetSeconds * 1000;
  const alignedMs = Math.floor((timestampMs + offsetMs) / stepMs) * stepMs - offsetMs;
  return Math.floor(alignedMs / 1000);
}

function intervalToMs(interval: string | null | undefined): number {
  if (!interval) {
    return 0;
  }

  return rangeUtil.intervalToMs(interval);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) {
    const result = new Uint8Array(b.byteLength);
    result.set(b, 0);
    return result;
  }

  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}
