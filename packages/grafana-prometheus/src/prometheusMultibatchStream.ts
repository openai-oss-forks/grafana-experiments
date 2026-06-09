import {
  DataFrame,
  DataFrameType,
  DataQueryRequest,
  DataQueryResponse,
  FieldType,
  LoadingState,
  TIME_SERIES_TIME_FIELD_NAME,
  TIME_SERIES_VALUE_FIELD_NAME,
  rangeUtil,
} from '@grafana/data';
import { config } from '@grafana/runtime';
import { Observable } from 'rxjs';
import { ZSTDDecoder } from 'zstddec';

import { getPrometheusTime } from './language_utils';
import { parseSampleValue } from './result_transformer';
import { PromQuery } from './types';

export const MULTIBATCH_CONTENT_TYPE = 'application/prometheus.multibatch';
export const MULTIBATCH_ACCEPT_HEADER = `${MULTIBATCH_CONTENT_TYPE}; version=1, application/jsonl`;

const FRAME_HEADER_SIZE = 12;
const FINAL_BATCH_FLAG = 1;
const RESERVED_FLAGS_MASK = 0xfe;
const PAYLOAD_TYPE_STREAM_HEADER = 0;
const PAYLOAD_TYPE_JSONL = 1;
const PAYLOAD_ENCODING_IDENTITY = 0;
const PAYLOAD_ENCODING_ZSTD = 1;
const MAGIC = 'OQPB';
const LEGACY_MAGIC = 'MBPB';

type BatchHandler = (payload: string, isFinal: boolean) => Promise<void> | void;

export interface MultiBatchFrame {
  payloadType: number;
  flags: number;
  payloadEncoding: number;
  payload: Uint8Array;
}

type MultiBatchColumnType = 'time' | 'number' | 'string' | 'boolean';

interface MultiBatchColumn {
  name: string;
  type: MultiBatchColumnType;
  labels?: Record<string, string>;
}

interface MultiBatchSchemaEvent {
  type: 'schema';
  refId?: string;
  name?: string;
  columns?: MultiBatchColumn[];
  fields?: MultiBatchColumn[];
}

interface MultiBatchDataEvent {
  type: 'data';
  refId?: string;
  row?: unknown[];
  rows?: unknown[][];
  values?: Record<string, unknown>;
}

interface MultiBatchStatusEvent {
  type: 'status';
  status?: string;
  isIncomplete?: boolean;
  incomplete?: boolean;
  refId?: string;
}

interface MultiBatchErrorEvent {
  type: 'error';
  error?: string;
  message?: string;
}

type MultiBatchEvent =
  | MultiBatchSchemaEvent
  | MultiBatchDataEvent
  | MultiBatchStatusEvent
  | MultiBatchErrorEvent
  | PrometheusApiResponse;

interface PrometheusApiResponse {
  status?: string;
  data?: {
    resultType?: string;
    result?: PrometheusResult[];
  };
}

interface PrometheusResult {
  metric?: Record<string, string>;
  values?: Array<[number | string, number | string]>;
  value?: [number | string, number | string];
}

interface SeriesAccumulator {
  labels: Record<string, string>;
  points: Map<number, number | null>;
}

class TextLineBuffer {
  private pending = '';

  push(text: string): string[] {
    const lines = `${this.pending}${text}`.split(/\r?\n/);
    this.pending = lines.pop() ?? '';
    return lines.filter((line) => line.trim().length > 0);
  }

  finish(): string[] {
    const line = this.pending;
    this.pending = '';
    return line.trim().length > 0 ? [line] : [];
  }
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
  private sawStreamHeader = false;
  private sawFinalBatch = false;

  push(chunk: Uint8Array): MultiBatchFrame[] {
    this.buffer = concatBytes(this.buffer, chunk);
    const frames: MultiBatchFrame[] = [];

    while (this.buffer.byteLength >= FRAME_HEADER_SIZE) {
      const header = this.buffer.subarray(0, FRAME_HEADER_SIZE);
      const magic = String.fromCharCode(...header.subarray(0, 4));
      if (magic !== MAGIC && magic !== LEGACY_MAGIC) {
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

      if (frame.payloadType === PAYLOAD_TYPE_STREAM_HEADER) {
        if (this.sawStreamHeader || frames.length > 0) {
          throw new Error('Prometheus multi-batch response included a duplicate stream header');
        }
        if ((frame.flags & FINAL_BATCH_FLAG) !== 0) {
          throw new Error('Prometheus multi-batch stream header cannot be final');
        }
        this.sawStreamHeader = true;
      } else if (frame.payloadType === PAYLOAD_TYPE_JSONL) {
        if (!this.sawStreamHeader) {
          if (magic !== LEGACY_MAGIC) {
            throw new Error('Prometheus multi-batch response missing stream header');
          }
          this.sawStreamHeader = true;
        }
      } else {
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

  return contentType.split(';')[0].trim().toLowerCase() === MULTIBATCH_CONTENT_TYPE;
}

export async function decodeMultiBatchFrames(chunks: Uint8Array[], onBatch: BatchHandler): Promise<void> {
  const frameDecoder = new MultiBatchFrameDecoder();
  const payloadDecoder = new ZstdPayloadDecoder();
  const textDecoder = new TextDecoder();

  for (const chunk of chunks) {
    for (const frame of frameDecoder.push(chunk)) {
      if (frame.payloadType === PAYLOAD_TYPE_STREAM_HEADER) {
        await payloadDecoder.decode(frame.payload, frame.payloadEncoding);
        continue;
      }

      const payload = await payloadDecoder.decode(frame.payload, frame.payloadEncoding);
      await onBatch(textDecoder.decode(payload), (frame.flags & FINAL_BATCH_FLAG) !== 0);
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
  },
  signal: AbortSignal,
  emit: (response: DataQueryResponse) => void
) {
  const accumulator = new MultiBatchResponseAccumulator(target);
  const method = options.httpMethod.toUpperCase();
  const response = await fetch(buildResourceUrl(datasourceUid, request, target, options), {
    body: method === 'POST' ? buildQueryParams(request, target, options.customQueryParameters).toString() : undefined,
    credentials: 'same-origin',
    headers: {
      Accept: MULTIBATCH_ACCEPT_HEADER,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    method,
    signal,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  if (!isMultiBatchContentType(response.headers.get('Content-Type'))) {
    const body = await response.text();
    accumulator.pushText(body);
    emit({ data: accumulator.snapshotFrames(false), state: LoadingState.Done });
    return;
  }

  if (!response.body) {
    throw new Error('Prometheus multi-batch response did not include a readable body');
  }

  const frameDecoder = new MultiBatchFrameDecoder();
  const payloadDecoder = new ZstdPayloadDecoder();
  const textDecoder = new TextDecoder();
  const reader = response.body.getReader();

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      for (const frame of frameDecoder.push(result.value)) {
        if (frame.payloadType === PAYLOAD_TYPE_STREAM_HEADER) {
          await payloadDecoder.decode(frame.payload, frame.payloadEncoding);
          continue;
        }

        const payload = await payloadDecoder.decode(frame.payload, frame.payloadEncoding);
        accumulator.pushText(textDecoder.decode(payload));
        const isFinal = (frame.flags & FINAL_BATCH_FLAG) !== 0;

        emit({
          data: accumulator.snapshotFrames(!isFinal),
          state: isFinal ? LoadingState.Done : LoadingState.Streaming,
        });
      }
    }
  } finally {
    reader.releaseLock();
  }

  frameDecoder.finish();
}

function buildResourceUrl(
  datasourceUid: string,
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  options: {
    httpMethod: string;
    customQueryParameters: URLSearchParams;
  }
): string {
  const path = `${config.appSubUrl ?? ''}/api/datasources/uid/${encodeURIComponent(
    datasourceUid
  )}/resources/api/v1/query_range`;

  if (options.httpMethod.toUpperCase() === 'POST') {
    return path;
  }

  const params = buildQueryParams(request, target, options.customQueryParameters);
  return `${path}?${params.toString()}`;
}

function buildQueryParams(
  request: DataQueryRequest<PromQuery>,
  target: PromQuery,
  customQueryParameters: URLSearchParams
): URLSearchParams {
  const params = new URLSearchParams(customQueryParameters);
  params.set('query', target.expr);
  params.set('start', String(getPrometheusTime(request.range.from, false)));
  params.set('end', String(getPrometheusTime(request.range.to, true)));
  params.set('step', String(getPrometheusStepSeconds(request, target)));
  return params;
}

function getPrometheusStepSeconds(request: DataQueryRequest<PromQuery>, target: PromQuery): number {
  const minIntervalMs = target.interval ? rangeUtil.intervalToMs(target.interval) : 0;
  const intervalFactor = target.intervalFactor ?? 1;
  const intervalMs = Math.max(request.intervalMs ?? 0, minIntervalMs) * intervalFactor;
  return Math.max(1, Math.ceil(intervalMs / 1000));
}

class MultiBatchResponseAccumulator {
  private framesByRefId = new Map<string, DataFrame>();
  private lineBuffer = new TextLineBuffer();
  private seriesByKey = new Map<string, SeriesAccumulator>();
  private resultType = 'matrix';

  constructor(private readonly target: PromQuery) {}

  pushText(text: string) {
    const lines = this.lineBuffer.push(text);
    for (const line of lines) {
      this.processLine(line);
    }
  }

  snapshotFrames(isIncomplete: boolean): DataFrame[] {
    for (const line of this.lineBuffer.finish()) {
      this.processLine(line);
    }

    const eventFrames = Array.from(this.framesByRefId.values()).map((frame) => cloneFrame(frame, isIncomplete));
    const prometheusFrames = this.prometheusFrames(isIncomplete);
    return eventFrames.length > 0 ? eventFrames : prometheusFrames;
  }

  private processLine(line: string) {
    const event = JSON.parse(line) as MultiBatchEvent;

    if (isPrometheusApiResponse(event)) {
      this.processPrometheusResponse(event);
      return;
    }

    switch (event.type) {
      case 'schema':
        this.processSchema(event);
        return;
      case 'data':
        this.processData(event);
        return;
      case 'status':
        this.processStatus(event);
        return;
      case 'error':
        throw new Error(event.error ?? event.message ?? 'Prometheus multi-batch response returned an error event');
      default:
        throw new Error(`Unsupported Prometheus multi-batch event type: ${(event as { type?: string }).type}`);
    }
  }

  private processSchema(event: MultiBatchSchemaEvent) {
    const columns = event.columns ?? event.fields ?? [];
    const frame: DataFrame = {
      fields: columns.map((column) => ({
        config: {},
        labels: column.labels,
        name: column.name,
        type: toFieldType(column.type),
        values: [],
      })),
      length: 0,
      meta: {
        custom: {
          isIncomplete: true,
        },
        type: DataFrameType.TimeSeriesMulti,
        typeVersion: [0, 1],
      },
      name: event.name,
      refId: event.refId ?? this.target.refId,
    };

    this.framesByRefId.set(frame.refId ?? this.target.refId, frame);
  }

  private processData(event: MultiBatchDataEvent) {
    const refId = event.refId ?? this.target.refId;
    const frame = this.framesByRefId.get(refId);
    if (!frame) {
      throw new Error(`Prometheus multi-batch data event referenced unknown frame: ${refId}`);
    }

    const rows = event.rows ?? (event.row ? [event.row] : event.values ? [event.values] : []);
    for (const row of rows) {
      frame.fields.forEach((field, index) => {
        const raw = getRowValue(row, field.name, index);
        field.values.push(convertValue(raw, field.type));
      });
      frame.length += 1;
    }
  }

  private processStatus(event: MultiBatchStatusEvent) {
    const isIncomplete =
      event.isIncomplete ?? event.incomplete ?? (event.status ? event.status.toLowerCase() !== 'done' : undefined);

    if (isIncomplete === undefined) {
      return;
    }

    const refId = event.refId ?? this.target.refId;
    const frame = this.framesByRefId.get(refId);
    if (frame) {
      frame.meta = {
        ...frame.meta,
        custom: {
          ...frame.meta?.custom,
          isIncomplete,
        },
      };
    }
  }

  private processPrometheusResponse(response: PrometheusApiResponse) {
    const resultType = response.data?.resultType ?? 'matrix';
    this.resultType = resultType;

    for (const result of response.data?.result ?? []) {
      const labels = result.metric ?? {};
      const key = metricKey(labels);
      let series = this.seriesByKey.get(key);
      if (!series) {
        series = { labels, points: new Map() };
        this.seriesByKey.set(key, series);
      }

      const values = result.values ?? (result.value ? [result.value] : []);
      for (const [timestamp, value] of values) {
        series.points.set(toTimestampMs(timestamp), parseSampleValue(String(value)));
      }
    }
  }

  private prometheusFrames(isIncomplete: boolean): DataFrame[] {
    return Array.from(this.seriesByKey.values()).map((series) => {
      const points = Array.from(series.points.entries()).sort(([a], [b]) => a - b);
      const labels = { ...series.labels };
      const valueName = labels.__name__ ?? TIME_SERIES_VALUE_FIELD_NAME;
      const displayNameFromDS = getDisplayName(this.target.legendFormat, labels);

      return {
        fields: [
          {
            config: {},
            name: TIME_SERIES_TIME_FIELD_NAME,
            type: FieldType.time,
            values: points.map(([timestamp]) => timestamp),
          },
          {
            config: displayNameFromDS ? { displayNameFromDS } : {},
            labels,
            name: valueName,
            type: FieldType.number,
            values: points.map(([, value]) => value),
          },
        ],
        length: points.length,
        meta: {
          custom: {
            isIncomplete,
            resultType: this.resultType,
          },
          type: DataFrameType.TimeSeriesMulti,
          typeVersion: [0, 1],
        },
        refId: this.target.refId,
      };
    });
  }
}

function cloneFrame(frame: DataFrame, isIncomplete: boolean): DataFrame {
  return {
    ...frame,
    fields: frame.fields.map((field) => ({
      ...field,
      config: { ...field.config },
      labels: field.labels ? { ...field.labels } : undefined,
      values: [...field.values],
    })),
    meta: {
      ...frame.meta,
      custom: {
        ...frame.meta?.custom,
        isIncomplete,
      },
    },
  };
}

function isPrometheusApiResponse(event: MultiBatchEvent): event is PrometheusApiResponse {
  return Boolean((event as PrometheusApiResponse).data?.resultType);
}

function toFieldType(type: MultiBatchColumnType): FieldType {
  switch (type) {
    case 'time':
      return FieldType.time;
    case 'number':
      return FieldType.number;
    case 'boolean':
      return FieldType.boolean;
    case 'string':
    default:
      return FieldType.string;
  }
}

function convertValue(value: unknown, type: FieldType): unknown {
  if (type === FieldType.time) {
    return toTimestampMs(value);
  }

  if (type === FieldType.number) {
    return parseSampleValue(String(value));
  }

  return value;
}

function getRowValue(row: unknown, fieldName: string, index: number): unknown {
  if (Array.isArray(row)) {
    return row[index];
  }

  if (row && typeof row === 'object') {
    return (row as Record<string, unknown>)[fieldName];
  }

  return undefined;
}

function toTimestampMs(timestamp: unknown): number {
  if (typeof timestamp === 'number') {
    return timestamp > 1e12 ? timestamp : timestamp * 1000;
  }

  if (typeof timestamp === 'string') {
    const numeric = Number(timestamp);
    if (!Number.isNaN(numeric)) {
      return numeric > 1e12 ? numeric : numeric * 1000;
    }

    return new Date(timestamp).getTime();
  }

  return Number(timestamp);
}

function getDisplayName(legendFormat: string | undefined, labels: Record<string, string>): string | undefined {
  if (!legendFormat || legendFormat === '__auto') {
    return undefined;
  }

  return legendFormat.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, label: string) => labels[label] ?? '');
}

function metricKey(metric: Record<string, string>): string {
  return Object.keys(metric)
    .sort()
    .map((key) => `${key}=${metric[key]}`)
    .join('\xff');
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
