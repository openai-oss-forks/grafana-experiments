import { Observable } from 'rxjs';
import { ZSTDDecoder } from 'zstddec';

import {
  AUTO_STEP_SIZE_FALLBACK_MAX_DATA_POINTS,
  DataFrame,
  DataFrameType,
  DataQueryError,
  DataQueryRequest,
  DataQueryResponse,
  FieldType,
  LoadingState,
  TIME_SERIES_TIME_FIELD_NAME,
  TIME_SERIES_VALUE_FIELD_NAME,
  rangeUtil,
  renderLegendFormat,
  resolveQueryIntervalWithStepSize,
} from '@grafana/data';
import { config, toDataQueryResponse } from '@grafana/runtime';

import { PromQuery } from './types';

export const MULTIBATCH_CONTENT_TYPE = 'application/prometheus.multibatch';
export const MULTIBATCH_PREFERRED_CONTENT_TYPE = 'application/com.openai.prometheus.multibatch';
export const MULTIBATCH_ACCEPT_HEADER = `${MULTIBATCH_PREFERRED_CONTENT_TYPE}; version=1, ${MULTIBATCH_CONTENT_TYPE}; version=1, application/jsonl`;
const QUERY_DATA_COMPACT_HEADER = 'X-Grafana-Query-Format';
const QUERY_DATA_COMPACT_MEDIA_TYPE = 'application/vnd.grafana.querydata.compact;version=1';
const QUERY_DATA_COMPACT_VERSION = 'compact-v1';

const FRAME_HEADER_SIZE = 12;
const FINAL_BATCH_FLAG = 1;
const RESERVED_FLAGS_MASK = 0xfe;
const PAYLOAD_TYPE_JSONL = 1;
const PAYLOAD_TYPE_COMPACT_V1 = 2;
const PAYLOAD_ENCODING_IDENTITY = 0;
const PAYLOAD_ENCODING_ZSTD = 1;
const RESPONSE_HEADER_MAGIC = 'MBRH';
const BATCH_FRAME_MAGIC = 'MBBF';
const ZSTD_FRAME_MAGIC = 0xfd2fb528;
const MAX_ZSTD_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

type BatchHandler = (payload: Uint8Array, isFinal: boolean, payloadType: number) => Promise<void> | void;

export interface MultiBatchFrame {
  payloadType: number;
  flags: number;
  payloadEncoding: number;
  payload: Uint8Array;
}

class ZstdPayloadDecoder {
  private decoder?: ZSTDDecoder;
  private decoderInit?: Promise<void>;

  async decode(payload: Uint8Array, encoding: number): Promise<Uint8Array> {
    if (encoding === PAYLOAD_ENCODING_IDENTITY) {
      return payload;
    }

    if (encoding !== PAYLOAD_ENCODING_ZSTD) {
      throw new Error(`Unsupported Prometheus multi-batch payload encoding: ${encoding}`);
    }

    if (!this.decoder) {
      this.decoder = new ZSTDDecoder();
    }
    this.decoderInit ??= initZstdDecoder(this.decoder);
    await this.decoderInit;

    const contentSize = zstdFrameContentSize(payload);
    if (contentSize !== undefined) {
      if (contentSize > MAX_ZSTD_DECOMPRESSED_BYTES) {
        throw new Error(`Prometheus multi-batch zstd payload is too large: ${contentSize} bytes`);
      }

      if (contentSize === 0) {
        return new Uint8Array();
      }

      return this.decoder.decode(payload, contentSize);
    }

    return this.decodeWithoutContentSize(payload);
  }

  private decodeWithoutContentSize(payload: Uint8Array): Uint8Array {
    let capacity = Math.max(256, Math.min(MAX_ZSTD_DECOMPRESSED_BYTES, payload.byteLength * 4));
    while (capacity <= MAX_ZSTD_DECOMPRESSED_BYTES) {
      const decoded = this.decoder!.decode(payload, capacity);
      if (decoded.byteLength > 0) {
        return decoded;
      }

      if (capacity === MAX_ZSTD_DECOMPRESSED_BYTES) {
        break;
      }
      capacity = Math.min(MAX_ZSTD_DECOMPRESSED_BYTES, capacity * 2);
    }

    throw new Error('Prometheus multi-batch zstd payload is missing frame content size');
  }
}

async function initZstdDecoder(decoder: ZSTDDecoder): Promise<void> {
  if (typeof globalThis.fetch !== 'function') {
    await decoder.init();
    return;
  }

  const originalFetch = globalThis.fetch;
  const patchedFetch: typeof fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith(ZSTD_WASM_DATA_URL_PREFIX)) {
      return Promise.resolve(
        new Response(copyArrayBuffer(base64ToBytes(input.slice(ZSTD_WASM_DATA_URL_PREFIX.length))))
      );
    }
    return originalFetch.call(globalThis, input, init);
  };

  globalThis.fetch = patchedFetch;
  try {
    await decoder.init();
  } finally {
    if (globalThis.fetch === patchedFetch) {
      globalThis.fetch = originalFetch;
    }
  }
}

const ZSTD_WASM_DATA_URL_PREFIX = 'data:application/wasm;base64,';

function base64ToBytes(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function zstdFrameContentSize(payload: Uint8Array): number | undefined {
  if (payload.byteLength < 6) {
    throw new Error('Prometheus multi-batch zstd payload is missing frame content size');
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (view.getUint32(0, true) !== ZSTD_FRAME_MAGIC) {
    throw new Error('Prometheus multi-batch zstd payload has invalid frame magic');
  }

  const descriptor = payload[4];
  const dictionaryIdFlag = descriptor & 0x03;
  const reservedBit = descriptor & 0x08;
  const singleSegment = (descriptor & 0x20) !== 0;
  const frameContentSizeFlag = descriptor >> 6;
  if (reservedBit !== 0) {
    throw new Error('Prometheus multi-batch zstd payload has unsupported frame descriptor');
  }

  let offset = 5;
  if (!singleSegment) {
    offset += 1;
  }

  const dictionaryIdSize = dictionaryIdFlag === 3 ? 4 : dictionaryIdFlag;
  offset += dictionaryIdSize;

  const contentSizeFieldSize = frameContentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << frameContentSizeFlag;
  if (contentSizeFieldSize === 0) {
    return undefined;
  }

  if (offset + contentSizeFieldSize > payload.byteLength) {
    throw new Error('Prometheus multi-batch zstd payload is missing frame content size');
  }

  switch (contentSizeFieldSize) {
    case 1:
      return payload[offset];
    case 2:
      return view.getUint16(offset, true) + 256;
    case 4:
      return view.getUint32(offset, true);
    case 8: {
      const size = view.getBigUint64(offset, true);
      if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`Prometheus multi-batch zstd payload is too large: ${size.toString()} bytes`);
      }
      return Number(size);
    }
    default:
      throw new Error('Prometheus multi-batch zstd payload has unsupported frame content size');
  }
}

export class MultiBatchFrameDecoder {
  private buffer = new ChunkBuffer();
  private sawResponseHeader = false;
  private sawFinalBatch = false;

  push(chunk: Uint8Array): MultiBatchFrame[] {
    this.buffer.append(chunk);
    const frames: MultiBatchFrame[] = [];

    while (this.buffer.byteLength >= FRAME_HEADER_SIZE) {
      const header = this.buffer.peek(FRAME_HEADER_SIZE);
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
        this.buffer.consume(FRAME_HEADER_SIZE);
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
        payload: this.buffer.readFramePayload(payloadLength),
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

      if (frame.payloadType !== PAYLOAD_TYPE_JSONL && frame.payloadType !== PAYLOAD_TYPE_COMPACT_V1) {
        throw new Error(`Unsupported Prometheus multi-batch payload type: ${frame.payloadType}`);
      }

      if ((frame.flags & FINAL_BATCH_FLAG) !== 0) {
        this.sawFinalBatch = true;
      }

      frames.push(frame);
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

class ChunkBuffer {
  private chunks: Uint8Array[] = [];
  byteLength = 0;

  append(chunk: Uint8Array) {
    if (chunk.byteLength === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.byteLength += chunk.byteLength;
  }

  peek(length: number): Uint8Array {
    if (this.byteLength < length) {
      throw new Error('Prometheus multi-batch buffer underflow');
    }
    const first = this.chunks[0];
    if (first.byteLength >= length) {
      return first.subarray(0, length);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      const copyLength = Math.min(chunk.byteLength, length - offset);
      result.set(chunk.subarray(0, copyLength), offset);
      offset += copyLength;
      if (offset === length) {
        break;
      }
    }
    return result;
  }

  consume(length: number) {
    if (length > this.byteLength) {
      throw new Error('Prometheus multi-batch buffer underflow');
    }
    let remaining = length;
    while (remaining > 0) {
      const first = this.chunks[0];
      if (remaining < first.byteLength) {
        this.chunks[0] = first.subarray(remaining);
        this.byteLength -= length;
        return;
      }
      remaining -= first.byteLength;
      this.chunks.shift();
    }
    this.byteLength -= length;
  }

  read(length: number): Uint8Array {
    if (length === 0) {
      return new Uint8Array();
    }
    if (length > this.byteLength) {
      throw new Error('Prometheus multi-batch buffer underflow');
    }
    const first = this.chunks[0];
    if (first.byteLength === length) {
      this.chunks.shift();
      this.byteLength -= length;
      return first;
    }
    if (first.byteLength > length) {
      this.chunks[0] = first.subarray(length);
      this.byteLength -= length;
      return first.subarray(0, length);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    let remaining = length;
    while (remaining > 0) {
      const chunk = this.chunks[0];
      const copyLength = Math.min(chunk.byteLength, remaining);
      result.set(chunk.subarray(0, copyLength), offset);
      offset += copyLength;
      remaining -= copyLength;
      if (copyLength === chunk.byteLength) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(copyLength);
      }
    }
    this.byteLength -= length;
    return result;
  }

  readFramePayload(payloadLength: number): Uint8Array {
    this.consume(FRAME_HEADER_SIZE);
    return this.read(payloadLength);
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

interface MultiBatchQueryContext {
  expr: string;
  legendFormat?: string;
  refId: string;
  stepMs: number;
}

interface JsonlColumn {
  name?: string;
  type?: string;
  labels?: Record<string, string>;
}

interface JsonlSchema {
  frame: string;
  refId?: string;
  name?: string;
  sql?: string;
  columns: JsonlColumn[];
}

interface JsonlEvent {
  type?: string;
  frame?: string;
  refId?: string;
  name?: string;
  sql?: string;
  columns?: JsonlColumn[];
  fields?: JsonlColumn[];
  data?: unknown;
  row?: unknown[];
  rows?: unknown[][];
  values?: Record<string, unknown>;
  status?: string;
  isIncomplete?: boolean;
  incomplete?: boolean;
  error?: string;
  message?: string;
}

interface JsonlRow {
  values?: unknown[];
  named?: Record<string, unknown>;
}

interface PrometheusApiResult {
  histogram?: PrometheusHistogramSample;
  histograms?: PrometheusHistogramSample[];
  metric?: Record<string, string>;
  values?: Array<[number | string, number | string]>;
  value?: [number | string, number | string];
}

type PrometheusHistogramSample = [
  number | string,
  {
    buckets?: Array<[number | string, number | string, number | string, number | string]>;
  },
];

interface PrometheusApiPayload {
  status?: string;
  error?: string | { message?: string; type?: string; code?: string };
  errorType?: string;
  message?: string;
  infos?: string[];
  warnings?: string[];
  data?: {
    resultType?: string;
    result?: PrometheusApiResult[];
  };
}

class JsonlMultiBatchAccumulator {
  private schemas = new Map<string, JsonlSchema>();
  private frames = new Map<string, DataFrame>();
  private frameOrder: string[] = [];

  decode(payload: Uint8Array, query: MultiBatchQueryContext, state: LoadingState): DataQueryResponse {
    const text = new TextDecoder().decode(payload).trim();
    if (!text) {
      return { data: this.snapshot(), state };
    }

    if (isPrometheusApiPayload(text)) {
      const error = prometheusApiPayloadError(text);
      if (error) {
        return { data: this.snapshot(), error, errors: [error], state };
      }

      this.mergeFrames(decodePrometheusApiResponse(text, query));
      return { data: this.snapshot(), state };
    }

    const batchFrames = new Map<string, DataFrame>();
    const batchOrder: string[] = [];
    let error: DataQueryError | undefined;

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let event: JsonlEvent;
      try {
        event = JSON.parse(trimmed) as JsonlEvent;
      } catch {
        const payloadError = dataQueryErrorFromText(trimmed);
        return { data: this.snapshot(), error: payloadError, errors: [payloadError], state };
      }

      const frameKey = jsonlFrameKey(event);
      switch (event.type) {
        case 'schema': {
          const columns = event.columns?.length ? event.columns : event.fields;
          this.schemas.set(frameKey, {
            frame: frameKey,
            refId: event.refId,
            name: event.name,
            sql: event.sql,
            columns: columns ?? [],
          });
          break;
        }
        case 'data': {
          const schema = this.schemas.get(frameKey);
          if (!schema) {
            throw new Error(`Prometheus multi-batch data event referenced unknown frame: ${frameKey}`);
          }
          const rows = jsonlRows(event);
          for (const row of rows) {
            const frame = this.batchFrame(batchFrames, batchOrder, frameKey, query);
            const values = jsonlRowValues(schema, row);
            frame.fields[0].values.push(parseTimeValue(values[0]));
            frame.fields[1].values.push(parseNumberValue(values[1]));
            frame.length = frame.fields[0].values.length;
          }
          break;
        }
        case 'status':
          break;
        case 'error':
          error = {
            message: event.error || event.message || 'Prometheus multi-batch response returned an error event',
          };
          break;
        default:
          throw new Error(`Unsupported Prometheus multi-batch JSONL event type: ${event.type}`);
      }
    }

    this.mergeFrames(
      batchOrder.map((key) => batchFrames.get(key)).filter((frame): frame is DataFrame => Boolean(frame))
    );
    return { data: this.snapshot(), error, errors: error ? [error] : undefined, state };
  }

  private batchFrame(
    batchFrames: Map<string, DataFrame>,
    batchOrder: string[],
    frameKey: string,
    query: MultiBatchQueryContext
  ): DataFrame {
    const existing = batchFrames.get(frameKey);
    if (existing) {
      return existing;
    }

    const schema = this.schemas.get(frameKey);
    if (!schema) {
      throw new Error(`Prometheus multi-batch data event referenced unknown frame: ${frameKey}`);
    }

    const frame = jsonlFrame(schema, query);
    batchFrames.set(frameKey, frame);
    batchOrder.push(frameKey);
    return frame;
  }

  private mergeFrames(frames: DataFrame[]) {
    if (frames.length === 0) {
      return;
    }

    for (const frame of frames) {
      const key = mergeFrameKey(frame);
      const existing = this.frames.get(key);
      const merged = existing ? mergeTimeSeriesFrame(existing, frame) : cloneFrame(frame);
      this.frames.set(key, merged);
      if (!this.frameOrder.includes(key)) {
        this.frameOrder.push(key);
      }
    }
  }

  private snapshot(): DataFrame[] {
    return this.frameOrder.map((key) => cloneFrame(this.frames.get(key)!));
  }
}

function isPrometheusApiPayload(payload: string): boolean {
  let parsed: PrometheusApiPayload & { type?: string };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== 'object' || parsed.type) {
    return false;
  }

  return Boolean(parsed.status || parsed.error || parsed.data?.resultType);
}

function prometheusApiPayloadError(payload: string): DataQueryError | undefined {
  const parsed = JSON.parse(payload) as PrometheusApiPayload;
  if (parsed.status !== 'error' && !parsed.error) {
    return undefined;
  }
  return {
    message: prometheusApiErrorMessage(parsed),
  };
}

function decodePrometheusApiResponse(payload: string, query: MultiBatchQueryContext): DataFrame[] {
  const parsed = JSON.parse(payload) as PrometheusApiPayload;
  if (parsed.status === 'error' || parsed.error) {
    throw new Error(prometheusApiErrorMessage(parsed));
  }

  const resultType = parsed.data?.resultType ?? 'matrix';
  const results = parsed.data?.result ?? [];
  if (resultType !== 'matrix' && resultType !== 'vector') {
    throw new Error(`Unsupported Prometheus multi-batch result type: ${resultType}`);
  }

  const notices = prometheusNotices(parsed);
  const frames = results.map((result, index) => {
    const labels = cloneLabels(result.metric ?? {});
    const histogramSamples =
      resultType === 'vector' && result.histogram ? [result.histogram] : (result.histograms ?? []);
    if (histogramSamples.length > 0) {
      return nativeHistogramFrame(histogramSamples, labels, query);
    }

    const samples = resultType === 'vector' && result.value ? [result.value] : (result.values ?? []);
    const timeValues: number[] = [];
    const numberValues: number[] = [];
    for (const sample of samples) {
      timeValues.push(parseTimeValue(sample[0]));
      numberValues.push(parseNumberValue(sample[1]));
    }

    const name = metricNameFromLabels(labels) || `series-${index}`;
    const displayNameFromDS = legendDisplayName(query.legendFormat, labels);
    return timeSeriesFrame({
      labels,
      name,
      query,
      refId: query.refId,
      resultType,
      valueFieldName: labels.__name__ || TIME_SERIES_VALUE_FIELD_NAME,
      displayNameFromDS,
      timeValues,
      numberValues,
    });
  });
  if (frames.length === 0 && notices.length > 0) {
    frames.push({
      fields: [],
      length: 0,
      meta: { notices },
      name: 'Warnings',
      refId: query.refId,
    });
  }
  return notices.length > 0 ? frames.map((frame) => withNotices(frame, notices)) : frames;
}

function prometheusApiErrorMessage(payload: PrometheusApiPayload): string {
  if (payload.message) {
    return payload.message;
  }

  if (typeof payload.error === 'string' && payload.error) {
    return payload.error;
  }

  if (payload.error && typeof payload.error === 'object') {
    return (
      payload.error.message ||
      payload.error.type ||
      payload.error.code ||
      'Prometheus multi-batch response returned an error'
    );
  }

  return payload.errorType || 'Prometheus multi-batch response returned an error';
}

function dataQueryErrorFromText(text: string): DataQueryError {
  return {
    message: text.length > 512 ? text.slice(0, 512) : text,
  };
}

function prometheusNotices(payload: PrometheusApiPayload) {
  const notices = [
    ...(payload.warnings ?? []).map((text) => ({ severity: 'warning' as const, text })),
    ...(payload.infos ?? []).map((text) => ({ severity: 'info' as const, text })),
  ];
  return notices;
}

function withNotices(frame: DataFrame, notices: Array<{ severity: 'warning' | 'info'; text: string }>): DataFrame {
  return {
    ...frame,
    meta: {
      ...frame.meta,
      notices,
    },
  };
}

function nativeHistogramFrame(
  samples: PrometheusHistogramSample[],
  labels: Record<string, string>,
  query: MultiBatchQueryContext
): DataFrame {
  const timeValues: number[] = [];
  const yMinValues: number[] = [];
  const yMaxValues: number[] = [];
  const countValues: number[] = [];
  const yLayoutValues: number[] = [];

  for (const [timestamp, histogram] of samples) {
    const parsedTime = parseTimeValue(timestamp);
    for (const bucket of histogram.buckets ?? []) {
      timeValues.push(parsedTime);
      yLayoutValues.push(parseNumberValue(bucket[0]));
      yMinValues.push(parseNumberValue(bucket[1]));
      yMaxValues.push(parseNumberValue(bucket[2]));
      countValues.push(parseNumberValue(bucket[3]));
    }
  }

  return {
    fields: [
      { name: 'xMax', type: FieldType.time, labels: cloneLabels(labels), config: {}, values: timeValues },
      { name: 'yMin', type: FieldType.number, labels: cloneLabels(labels), config: {}, values: yMinValues },
      { name: 'yMax', type: FieldType.number, labels: cloneLabels(labels), config: {}, values: yMaxValues },
      { name: 'count', type: FieldType.number, labels: cloneLabels(labels), config: {}, values: countValues },
      { name: 'yLayout', type: FieldType.number, labels: cloneLabels(labels), config: {}, values: yLayoutValues },
    ],
    length: timeValues.length,
    meta: { type: DataFrameType.HeatmapCells },
    name: metricNameFromLabels(labels),
    refId: query.refId,
  };
}

function jsonlFrameKey(event: JsonlEvent): string {
  return event.frame || event.refId || 'main';
}

function jsonlRows(event: JsonlEvent): JsonlRow[] {
  if (event.rows?.length) {
    return event.rows.map((values) => ({ values }));
  }

  if (event.row?.length) {
    return [{ values: event.row }];
  }

  if (event.values && Object.keys(event.values).length > 0) {
    return [{ named: event.values }];
  }

  if (event.data == null) {
    return [];
  }

  if (Array.isArray(event.data)) {
    if (event.data.length === 0) {
      return [];
    }

    if (Array.isArray(event.data[0])) {
      return (event.data as unknown[][]).map((values) => ({ values }));
    }

    return [{ values: event.data }];
  }

  if (typeof event.data === 'object') {
    return [{ named: event.data as Record<string, unknown> }];
  }

  throw new Error('Unsupported Prometheus multi-batch JSONL data event shape');
}

function jsonlRowValues(schema: JsonlSchema, row: JsonlRow): unknown[] {
  const values = row.named ? schema.columns.map((column) => row.named?.[column.name ?? '']) : row.values;
  if (!values || values.length !== schema.columns.length) {
    throw new Error(
      `Prometheus multi-batch data row has ${values?.length ?? 0} values for ${schema.columns.length} columns`
    );
  }
  return values;
}

function jsonlFrame(schema: JsonlSchema, query: MultiBatchQueryContext): DataFrame {
  if (schema.columns.length !== 2) {
    throw new Error(
      `Prometheus multi-batch JSONL requires two-column time series frames, got ${schema.columns.length}`
    );
  }

  if (schema.columns[0].type !== 'time' || schema.columns[1].type !== 'number') {
    throw new Error(
      `Prometheus multi-batch JSONL only supports time/number frames, got ${schema.columns[0].type}/${schema.columns[1].type}`
    );
  }

  const labels = cloneLabels(schema.columns[1].labels ?? {});
  const displayNameFromDS = legendDisplayName(query.legendFormat, labels);
  return timeSeriesFrame({
    labels,
    name: schema.name || schema.frame,
    query,
    refId: schema.refId || query.refId,
    resultType: 'matrix',
    valueFieldName: schema.columns[1].name || labels.__name__ || TIME_SERIES_VALUE_FIELD_NAME,
    displayNameFromDS,
  });
}

function timeSeriesFrame(options: {
  labels: Record<string, string>;
  name: string;
  query: MultiBatchQueryContext;
  refId: string;
  resultType: string;
  valueFieldName: string;
  displayNameFromDS?: string;
  timeValues?: number[];
  numberValues?: number[];
}): DataFrame {
  const length = options.timeValues?.length ?? 0;
  return {
    length,
    name: options.name,
    refId: options.refId,
    fields: [
      {
        name: TIME_SERIES_TIME_FIELD_NAME,
        type: FieldType.time,
        config: { interval: options.query.stepMs },
        values: options.timeValues ? [...options.timeValues] : [],
      },
      {
        name: options.valueFieldName,
        type: FieldType.number,
        labels: cloneLabels(options.labels),
        config: options.displayNameFromDS ? { displayNameFromDS: options.displayNameFromDS } : {},
        values: options.numberValues ? [...options.numberValues] : [],
      },
    ],
    meta: {
      type: DataFrameType.TimeSeriesMulti,
      typeVersion: [0, 1],
      custom: {
        calculatedMinStep: options.query.stepMs,
        resultType: options.resultType,
      },
      executedQueryString: `Expr: ${options.query.expr}\nStep: ${rangeUtil.secondsToHms(options.query.stepMs / 1000)}`,
    },
  };
}

function parseTimeValue(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === 'string') {
    const numeric = Number(value);
    if (value.trim() !== '' && !Number.isNaN(numeric)) {
      return parseUnixTime(numeric);
    }

    const timestamp = Date.parse(value);
    if (!Number.isNaN(timestamp)) {
      return timestamp;
    }

    throw new Error(`Invalid Prometheus multi-batch time value: ${value}`);
  }

  if (typeof value === 'number') {
    return parseUnixTime(value);
  }

  throw new Error(`Invalid Prometheus multi-batch time value: ${typeof value}`);
}

function parseUnixTime(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid Prometheus multi-batch time value: ${value}`);
  }

  return Math.abs(value) > 1e12 ? Math.trunc(value) : Math.trunc(value * 1000);
}

function parseNumberValue(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value !== 'string') {
    throw new Error(`Invalid Prometheus multi-batch numeric value: ${typeof value}`);
  }

  if (value === '') {
    return Number.NaN;
  }

  if (/^\+?inf(?:inity)?$/i.test(value)) {
    return Number.POSITIVE_INFINITY;
  }

  if (/^-inf(?:inity)?$/i.test(value)) {
    return Number.NEGATIVE_INFINITY;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid Prometheus multi-batch numeric value: ${value}`);
  }
  return parsed;
}

function mergeFrameKey(frame: DataFrame): string {
  const valueField = frame.fields[1];
  const labels = valueField?.labels ?? {};
  const labelKeys = Object.keys(labels).sort();
  return [
    frame.refId ?? '',
    frame.name ?? '',
    valueField?.name ?? '',
    ...labelKeys.flatMap((key) => [key, labels[key]]),
  ].join('\x00');
}

function mergeTimeSeriesFrame(base: DataFrame, delta: DataFrame): DataFrame {
  if (base.fields.length !== 2 || delta.fields.length !== 2) {
    return mergeDataFrameRows(base, delta);
  }

  const points = new Map<number, number>();
  for (let index = 0; index < base.fields[0].values.length; index++) {
    points.set(Number(base.fields[0].values[index]), Number(base.fields[1].values[index]));
  }
  for (let index = 0; index < delta.fields[0].values.length; index++) {
    points.set(Number(delta.fields[0].values[index]), Number(delta.fields[1].values[index]));
  }

  const timestamps = [...points.keys()].sort((a, b) => a - b);
  const merged = cloneFrame(delta);
  merged.name = base.name;
  merged.refId = base.refId;
  merged.fields[0].values = timestamps;
  merged.fields[1].values = timestamps.map((timestamp) => points.get(timestamp)!);
  merged.length = timestamps.length;
  return merged;
}

function mergeDataFrameRows(base: DataFrame, delta: DataFrame): DataFrame {
  const rows = new Map<string, unknown[]>();
  for (let index = 0; index < base.length; index++) {
    rows.set(rowMergeKey(base, index), frameRow(base, index));
  }
  for (let index = 0; index < delta.length; index++) {
    rows.set(rowMergeKey(delta, index), frameRow(delta, index));
  }

  const mergedRows = [...rows.values()].sort(compareFrameRows);
  const merged = cloneFrame(delta);
  merged.name = base.name;
  merged.refId = base.refId;
  for (let fieldIndex = 0; fieldIndex < merged.fields.length; fieldIndex++) {
    merged.fields[fieldIndex].values = mergedRows.map((row) => row[fieldIndex]);
  }
  merged.length = mergedRows.length;
  return merged;
}

function frameRow(frame: DataFrame, index: number): unknown[] {
  return frame.fields.map((field) => field.values[index]);
}

function rowMergeKey(frame: DataFrame, index: number): string {
  if (frame.meta?.type === DataFrameType.HeatmapCells && frame.fields.length >= 5) {
    return [
      frame.fields[0].values[index],
      frame.fields[1].values[index],
      frame.fields[2].values[index],
      frame.fields[4].values[index],
    ].join('\x00');
  }
  return frameRow(frame, index).join('\x00');
}

function compareFrameRows(left: unknown[], right: unknown[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const leftValue = Number(left[index]);
    const rightValue = Number(right[index]);
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return left.length - right.length;
}

function cloneFrame(frame: DataFrame): DataFrame {
  return {
    ...frame,
    fields: frame.fields.map((field) => ({
      ...field,
      config: { ...field.config },
      labels: field.labels ? cloneLabels(field.labels) : undefined,
      values: [...field.values],
    })),
    meta: frame.meta
      ? {
          ...frame.meta,
          custom:
            frame.meta.custom && typeof frame.meta.custom === 'object' && !Array.isArray(frame.meta.custom)
              ? { ...frame.meta.custom }
              : frame.meta.custom,
          notices: frame.meta.notices ? [...frame.meta.notices] : undefined,
        }
      : undefined,
  };
}

function cloneLabels(labels: Record<string, string>): Record<string, string> {
  return { ...labels };
}

function legendDisplayName(legendFormat: string | undefined, labels: Record<string, string>): string | undefined {
  let legend = metricNameFromLabels(labels);
  if (legendFormat === '__auto') {
    if (Object.keys(labels).length > 0) {
      legend = '';
    }
  } else if (legendFormat) {
    legend = renderLegendFormat(legendFormat, labels);
  }

  if (!legend && Object.keys(labels).length === 1) {
    legend = Object.values(labels)[0];
  }

  return legend || undefined;
}

function metricNameFromLabels(labels: Record<string, string>): string {
  const metricName = labels.__name__ ?? '';
  const labelKeys = Object.keys(labels)
    .filter((key) => key !== '__name__')
    .sort();
  if (labelKeys.length === 0) {
    return metricName || '{}';
  }

  const labelString = labelKeys.map((key) => `${key}="${labels[key]}"`).join(', ');
  return `${metricName}{${labelString}}`;
}

export async function decodeMultiBatchFrames(chunks: Uint8Array[], onBatch: BatchHandler): Promise<void> {
  const frameDecoder = new MultiBatchFrameDecoder();
  const payloadDecoder = new ZstdPayloadDecoder();

  for (const chunk of chunks) {
    for (const frame of frameDecoder.push(chunk)) {
      const payload = await payloadDecoder.decode(frame.payload, frame.payloadEncoding);
      await onBatch(payload, (frame.flags & FINAL_BATCH_FLAG) !== 0, frame.payloadType);
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
  const requestCompactResponse = request.preferredQueryResultFormat === QUERY_DATA_COMPACT_VERSION;
  const queryContext = buildMultiBatchQueryContext(request, target, options);
  const headers: Record<string, string> = {
    Accept: MULTIBATCH_ACCEPT_HEADER,
    'Content-Type': 'application/json',
  };
  if (requestCompactResponse) {
    headers[QUERY_DATA_COMPACT_HEADER] = QUERY_DATA_COMPACT_VERSION;
  }

  const response = await fetch(buildResourceUrl(datasourceUid), {
    body: buildStreamingQueryBody(datasourceUid, request, target, options.minInterval),
    credentials: 'same-origin',
    headers,
    method: 'POST',
    signal,
  });

  const responseContentType = response.headers.get('Content-Type');
  if (!isMultiBatchContentType(responseContentType)) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (isCompactContentType(responseContentType)) {
      emit(decodeCompactQueryDataResponse(body, response.headers, request, target, LoadingState.Done));
      return;
    }

    if (!response.ok) {
      throw new Error(new TextDecoder().decode(body));
    }

    if (isQueryDataJsonPayload(body)) {
      const decoded = decodeQueryDataJsonResponse(body, response.headers, request, target, LoadingState.Done);
      emit(decoded);
      return;
    }

    const decoded = new JsonlMultiBatchAccumulator().decode(body, queryContext, LoadingState.Done);
    emit(decoded);
    return;
  }

  if (!response.body) {
    throw new Error('Prometheus multi-batch response did not include a readable body');
  }

  const frameDecoder = new MultiBatchFrameDecoder();
  const payloadDecoder = new ZstdPayloadDecoder();
  const jsonlAccumulator = new JsonlMultiBatchAccumulator();
  const reader = response.body.getReader();
  const emitWithRetainedData = retainLastRenderableDataOnError(emit);

  try {
    const initialChunks: Uint8Array[] = [];
    let result = await reader.read();
    if (!result.done) {
      initialChunks.push(result.value);
      while (byteLength(initialChunks) < RESPONSE_HEADER_MAGIC.length) {
        result = await reader.read();
        if (result.done) {
          break;
        }
        initialChunks.push(result.value);
      }
    }

    if (!response.ok && !chunksStartWithMagic(initialChunks, RESPONSE_HEADER_MAGIC)) {
      throw new Error(await readStreamText(reader, initialChunks, response));
    }

    for (const chunk of initialChunks) {
      await processMultiBatchChunk(
        chunk,
        frameDecoder,
        payloadDecoder,
        request,
        target,
        queryContext,
        jsonlAccumulator,
        emitWithRetainedData
      );
    }

    while (true) {
      result = await reader.read();
      if (result.done) {
        break;
      }

      await processMultiBatchChunk(
        result.value,
        frameDecoder,
        payloadDecoder,
        request,
        target,
        queryContext,
        jsonlAccumulator,
        emitWithRetainedData
      );
    }
  } finally {
    reader.releaseLock();
  }

  frameDecoder.finish();
}

function retainLastRenderableDataOnError(
  emit: (response: DataQueryResponse) => void
): (response: DataQueryResponse) => void {
  let lastRenderableData: Pick<DataQueryResponse, 'data' | 'compactSeries'> | undefined;

  return (response) => {
    const hasRenderableData = response.data.length > 0 || (response.compactSeries?.series?.length ?? 0) > 0;
    if (hasRenderableData) {
      lastRenderableData = {
        data: response.data,
        compactSeries: response.compactSeries,
      };
    }

    const hasError = Boolean(response.error || response.errors?.length);
    if (hasError && !hasRenderableData && lastRenderableData) {
      emit({
        ...response,
        ...lastRenderableData,
      });
      return;
    }

    emit(response);
  };
}

async function processMultiBatchChunk(
  chunk: Uint8Array,
  frameDecoder: MultiBatchFrameDecoder,
  payloadDecoder: ZstdPayloadDecoder,
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  queryContext: MultiBatchQueryContext,
  jsonlAccumulator: JsonlMultiBatchAccumulator,
  emit: (response: DataQueryResponse) => void
) {
  for (const frame of frameDecoder.push(chunk)) {
    const payload = await payloadDecoder.decode(frame.payload, frame.payloadEncoding);
    const isFinal = (frame.flags & FINAL_BATCH_FLAG) !== 0;
    const state = isFinal ? LoadingState.Done : LoadingState.Streaming;
    let response: DataQueryResponse;
    if (frame.payloadType === PAYLOAD_TYPE_COMPACT_V1) {
      response = decodeCompactQueryDataResponse(payload, compactHeaders(), request, target, state);
    } else if (isQueryDataJsonPayload(payload)) {
      response = decodeQueryDataJsonResponse(payload, jsonHeaders(), request, target, state);
    } else {
      response = jsonlAccumulator.decode(payload, queryContext, state);
    }
    emit(response);

    if (!isFinal) {
      await yieldToBrowser();
    }
  }
}

async function readStreamText(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  initialChunks: Uint8Array[],
  response: Response
): Promise<string> {
  const chunks = [...initialChunks];

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    chunks.push(result.value);
  }

  const text = new TextDecoder().decode(concatChunks(chunks)).trim();
  return text || response.statusText || `Prometheus multi-batch request failed with status ${response.status}`;
}

function chunksStartWithMagic(chunks: Uint8Array[], magic: string): boolean {
  if (byteLength(chunks) < magic.length) {
    return false;
  }

  const magicBytes = [...magic].map((char) => char.charCodeAt(0));
  let chunkIndex = 0;
  let offset = 0;

  for (const expected of magicBytes) {
    while (chunkIndex < chunks.length && offset >= chunks[chunkIndex].byteLength) {
      chunkIndex += 1;
      offset = 0;
    }

    if (chunkIndex >= chunks.length || chunks[chunkIndex][offset] !== expected) {
      return false;
    }

    offset += 1;
  }

  return true;
}

function byteLength(chunks: Uint8Array[]): number {
  return chunks.reduce((length, chunk) => length + chunk.byteLength, 0);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(byteLength(chunks));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
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

function jsonHeaders(): Headers {
  return new Headers({ 'content-type': 'application/json' });
}

function isQueryDataJsonPayload(payload: Uint8Array): boolean {
  const text = new TextDecoder().decode(payload).trim();
  if (!text.startsWith('{')) {
    return false;
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && 'results' in parsed;
  } catch {
    return false;
  }
}

function decodeQueryDataJsonResponse(
  payload: Uint8Array,
  headers: Headers,
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  state: LoadingState
): DataQueryResponse {
  return {
    ...toDataQueryResponse(
      {
        data: copyArrayBuffer(payload),
        headers,
      },
      request.targets.length === 1 ? request.targets : [target],
      request.preferredQueryResultFormat === QUERY_DATA_COMPACT_VERSION
    ),
    state,
  };
}

function copyArrayBuffer(payload: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(payload.byteLength);
  copy.set(payload);
  return copy.buffer;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildResourceUrl(datasourceUid: string): string {
  return `${config.appSubUrl ?? ''}/api/datasources/uid/${encodeURIComponent(
    datasourceUid
  )}/resources/api/v1/query_range`;
}

function buildStreamingQueryBody(
  datasourceUid: string,
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  minInterval?: string
): string {
  const intervalMs = Math.max(request.intervalMs ?? 1000, intervalToMs(minInterval));
  return JSON.stringify({
    from: String(request.range.from.valueOf()),
    to: String(request.range.to.valueOf()),
    queries: [
      {
        ...target,
        datasource: { uid: datasourceUid },
        intervalMs,
        maxDataPoints: request.maxDataPoints ?? AUTO_STEP_SIZE_FALLBACK_MAX_DATA_POINTS,
      },
    ],
  });
}

function buildMultiBatchQueryContext(
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  options: {
    minInterval?: string;
  }
): MultiBatchQueryContext {
  return {
    expr: target.expr,
    legendFormat: target.legendFormat,
    refId: target.refId ?? 'A',
    stepMs: getPrometheusStepSeconds(request, target, options.minInterval) * 1000,
  };
}

export function getPrometheusStepSeconds(
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  minInterval?: string
): number {
  return getPrometheusMultiBatchIntervals(request, target, minInterval).stepSeconds;
}

export function getPrometheusMultiBatchIntervals(
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  minInterval?: string
): { rateIntervalBaseMs: number; stepMs: number; stepSeconds: number } {
  const queryMinInterval = target.interval || minInterval;
  const baseIntervalMs = Math.max(request.intervalMs ?? 0, intervalToMs(queryMinInterval));

  if (target.stepSize) {
    const resolved = resolveQueryIntervalWithStepSize({
      range: request.range,
      maxDataPoints: request.maxDataPoints ?? AUTO_STEP_SIZE_FALLBACK_MAX_DATA_POINTS,
      minInterval: queryMinInterval,
      stepSize: target.stepSize,
    });
    const stepSeconds = Math.max(1, Math.ceil(resolved.intervalMs / 1000));
    return {
      rateIntervalBaseMs: baseIntervalMs,
      stepMs: stepSeconds * 1000,
      stepSeconds,
    };
  }

  const intervalMs = baseIntervalMs * (target.intervalFactor ?? 1);
  const stepSeconds = Math.max(1, Math.ceil(intervalMs / 1000));
  return {
    rateIntervalBaseMs: baseIntervalMs,
    stepMs: stepSeconds * 1000,
    stepSeconds,
  };
}

function intervalToMs(interval: string | null | undefined): number {
  if (!interval) {
    return 0;
  }

  return rangeUtil.intervalToMs(interval);
}
