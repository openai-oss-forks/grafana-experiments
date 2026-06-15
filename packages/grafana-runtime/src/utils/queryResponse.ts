import {
  COMPACT_TIME_SERIES_FORMAT,
  CompactTimeSeriesAxis,
  CompactTimeSeriesData,
  CompactTimeSeriesMetadata,
  CompactTimeSeriesNotice,
  CompactTimeSeriesSeries,
  DataQueryResponse,
  KeyValue,
  LoadingState,
  DataQueryError,
  TimeSeries,
  TableData,
  toDataFrame,
  DataFrame,
  MetricFindValue,
  FieldType,
  DataQuery,
  DataFrameJSON,
  DataFrameType,
  dataFrameFromJSON,
  QueryResultMeta,
  QueryResultMetaNotice,
  Labels,
} from '@grafana/data';

import { FetchError, FetchResponse } from '../services';

import { HealthCheckResultDetails } from './DataSourceWithBackend';
import { toDataQueryError } from './toDataQueryError';

export const cachedResponseNotice: QueryResultMetaNotice = { severity: 'info', text: 'Cached response' };
export const QUERY_DATA_COMPACT_HEADER = 'X-Grafana-Query-Format';
export const QUERY_DATA_COMPACT_VERSION = 'compact-v1';
export const QUERY_DATA_COMPACT_MEDIA_TYPE = 'application/vnd.grafana.querydata.compact;version=1';

const COMPACT_RESPONSE_HEADER_SIZE = 32;
const COMPACT_AXIS_RECORD_SIZE = 24;
const COMPACT_STRING_RECORD_SIZE = 8;
const COMPACT_RESULT_HEADER_SIZE = 48;
const COMPACT_NOTICE_RECORD_SIZE = 16;
const COMPACT_FRAME_HEADER_SIZE = 48;
const COMPACT_LABEL_RECORD_SIZE = 8;
const COMPACT_BINARY_VERSION = 1;
const COMPACT_MAGIC = 'GQD1';
const COMPACT_RESULT_TYPE_MATRIX = 1;
const COMPACT_FRAME_TYPE_TIME_SERIES_MULTI = 1;
const COMPACT_RESULT_FLAG_CALCULATED_MIN_STEP = 1 << 0;
const textDecoder = new TextDecoder(undefined, { fatal: true });

/**
 * Single response object from a backend data source. Properties are optional but response should contain at least
 * an error or a some data (but can contain both). Main way to send data is with dataframes attribute as series and
 * tables data attributes are legacy formats.
 *
 * @internal
 */
export interface DataResponse {
  error?: string;
  refId?: string;
  frames?: DataFrameJSON[];
  dataFrames?: DataFrame[];
  status?: number;

  // Legacy TSDB format...
  series?: TimeSeries[];
  tables?: TableData[];
}

/**
 * This is the type of response expected form backend datasource.
 *
 * @internal
 */
export interface BackendDataSourceResponse {
  results: KeyValue<DataResponse>;
  proxied_upstream_headers?: Record<string, Record<string, string>>;
}

interface QueryFetchResponse {
  data?: unknown;
  status?: number;
  headers?: Pick<Headers, 'get'>;
}

/**
 * Parse the results from /api/ds/query into a DataQueryResponse
 *
 * @param res - the HTTP response data.
 * @param queries - optional DataQuery array that will order the response based on the order of query refId's.
 *
 * @public
 */
export function toDataQueryResponse(
  res:
    | { data: BackendDataSourceResponse | ArrayBuffer | undefined }
    | FetchResponse<BackendDataSourceResponse | ArrayBuffer | undefined>
    | DataQueryError,
  queries?: DataQuery[],
  expectedCompactResponse = false
): DataQueryResponse {
  const rsp: DataQueryResponse = { data: [], state: LoadingState.Done };

  const traceId = 'traceId' in res ? res.traceId : undefined;

  if (traceId != null) {
    rsp.traceIds = [traceId];
  }

  // If the response isn't in a correct shape we just ignore the data and pass empty DataQueryResponse.
  const fetchResponse: QueryFetchResponse = {
    data: res.data,
    status: 'status' in res ? res.status : undefined,
    headers: 'headers' in res ? res.headers : undefined,
  };
  const mediaType = getMediaType(fetchResponse.headers);
  if (mediaType === QUERY_DATA_COMPACT_MEDIA_TYPE) {
    if (!expectedCompactResponse) {
      throw new Error('Received an unexpected compact query response');
    }
    const compactResponse = decodeCompactQueryDataResponse(fetchResponse.data, queries);
    if (traceId != null) {
      compactResponse.traceIds = [traceId];
      compactResponse.error = compactResponse.error ? { ...compactResponse.error, traceId } : undefined;
      compactResponse.errors = compactResponse.errors?.map((error) => ({ ...error, traceId }));
    }
    return compactResponse;
  }
  if (expectedCompactResponse && mediaType !== 'application/json') {
    throw new Error(`Expected ${QUERY_DATA_COMPACT_MEDIA_TYPE} or application/json fallback response`);
  }
  const responseData = decodeQueryDataResponse(fetchResponse);
  if (responseData?.results) {
    rsp.proxied_upstream_headers = responseData.proxied_upstream_headers;
    const results = responseData.results;
    const refIDs = queries?.length ? queries.map((q) => q.refId) : Object.keys(results);
    const cachedResponse = isCachedResponse(fetchResponse);
    const data: DataResponse[] = [];

    for (const refId of refIDs) {
      const dr = results[refId];
      if (!dr) {
        continue;
      }
      dr.refId = refId;
      data.push(dr);
    }

    for (const dr of data) {
      if (dr.error) {
        const errorObj: DataQueryError = {
          refId: dr.refId,
          message: dr.error,
          status: dr.status,
        };
        if (traceId != null) {
          errorObj.traceId = traceId;
        }
        if (!rsp.error) {
          rsp.error = { ...errorObj };
        }
        if (rsp.errors) {
          rsp.errors.push({ ...errorObj });
        } else {
          rsp.errors = [{ ...errorObj }];
        }
        rsp.state = LoadingState.Error;
      }

      if (dr.dataFrames?.length) {
        for (let frame of dr.dataFrames) {
          if (cachedResponse) {
            frame = addCacheNoticeToDataFrame(frame);
          }
          if (!frame.refId) {
            frame.refId = dr.refId;
          }
          rsp.data.push(frame);
        }
        continue;
      }

      if (dr.frames?.length) {
        for (let frame of dr.frames) {
          if (cachedResponse) {
            frame = addCacheNotice(frame);
          }
          const df = dataFrameFromJSON(frame);
          if (!df.refId) {
            df.refId = dr.refId;
          }
          rsp.data.push(df);
        }
        continue; // the other tests are legacy
      }

      if (dr.series?.length) {
        for (const s of dr.series) {
          if (!s.refId) {
            s.refId = dr.refId;
          }
          rsp.data.push(toDataFrame(s));
        }
      }

      if (dr.tables?.length) {
        for (const s of dr.tables) {
          if (!s.refId) {
            s.refId = dr.refId;
          }
          rsp.data.push(toDataFrame(s));
        }
      }
    }
  }

  // When it is not an OK response, make sure the error gets added
  if (fetchResponse.status && fetchResponse.status !== 200) {
    if (rsp.state !== LoadingState.Error) {
      rsp.state = LoadingState.Error;
    }
    if (!rsp.error) {
      rsp.error = toDataQueryError(res);
    }
  }

  if (!fetchResponse.data && hasErrorMessage(res)) {
    rsp.state = LoadingState.Error;
    rsp.error = toDataQueryError(res);
    rsp.errors = [rsp.error];
  }

  return rsp;
}

function decodeQueryDataResponse(res: QueryFetchResponse): BackendDataSourceResponse | undefined {
  if (isQueryDataResponse(res.data)) {
    return res.data;
  }
  if (isArrayBuffer(res.data) && getMediaType(res.headers) === 'application/json') {
    let decoded: unknown;
    try {
      decoded = JSON.parse(textDecoder.decode(new Uint8Array(res.data)));
    } catch {
      throw new Error('Invalid JSON query response');
    }
    if (!isQueryDataResponse(decoded)) {
      throw new Error('Invalid JSON query response');
    }
    return decoded;
  }
  return undefined;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function getMediaType(headers: QueryFetchResponse['headers']): string | undefined {
  const contentType = headers?.get('content-type')?.trim().toLowerCase();
  if (!contentType) {
    return undefined;
  }
  if (contentType === QUERY_DATA_COMPACT_MEDIA_TYPE || contentType.startsWith(`${QUERY_DATA_COMPACT_MEDIA_TYPE};`)) {
    return QUERY_DATA_COMPACT_MEDIA_TYPE;
  }
  return contentType.split(';', 1)[0];
}

function isQueryDataResponse(data: unknown): data is BackendDataSourceResponse {
  return typeof data === 'object' && data !== null && 'results' in data;
}

function decodeCompactQueryDataResponse(response: unknown, queries?: DataQuery[]): DataQueryResponse {
  if (!isArrayBuffer(response)) {
    throw new Error('Invalid compact query response');
  }

  let decoded: CompactV1DecodedResponse;
  try {
    decoded = new CompactV1Reader(response).readResponse();
  } catch {
    throw new Error('Invalid compact query response');
  }
  const resultsByRefID = new Map<string, CompactV1Result>();
  for (const result of decoded.results) {
    if (resultsByRefID.has(result.refId)) {
      throw new Error(`Invalid compact query response: duplicate result refId ${result.refId}`);
    }
    resultsByRefID.set(result.refId, result);
  }
  let orderedResults = decoded.results;
  if (queries?.length) {
    const requestedRefIDs = new Set<string>();
    for (const query of queries) {
      if (requestedRefIDs.has(query.refId)) {
        throw new Error(`Invalid compact query request: duplicate refId ${query.refId}`);
      }
      requestedRefIDs.add(query.refId);
    }
    if (resultsByRefID.size !== requestedRefIDs.size) {
      throw new Error('Invalid compact query response: result refIds do not match the request');
    }
    orderedResults = queries.map((query) => {
      const result = resultsByRefID.get(query.refId);
      if (!result) {
        throw new Error(`Invalid compact query response: missing result refId ${query.refId}`);
      }
      return result;
    });
  }
  const series = decoded.series.selectResults(orderedResults);
  const errors: DataQueryError[] = [];

  for (const result of orderedResults) {
    if (result.error) {
      errors.push({ refId: result.refId, message: result.error, status: result.status });
    }
  }

  return {
    data: [],
    compactSeries:
      series.length > 0
        ? {
            kind: 'compact-response-view',
            format: COMPACT_TIME_SERIES_FORMAT,
            buffer: response,
            axes: decoded.axes,
            series,
            metadata: decoded.metadata,
            notices: orderedResults.flatMap((result) => result.notices),
            decodeStats: decoded.stats,
          }
        : undefined,
    state: errors.length > 0 ? LoadingState.Error : LoadingState.Done,
    error: errors[0],
    errors: errors.length > 0 ? errors : undefined,
  };
}

interface CompactV1Header {
  axisCount: number;
  resultCount: number;
  stringCount: number;
  stringBytesLength: number;
}

interface CompactV1DecodedResponse {
  axes: CompactTimeSeriesAxis[];
  results: CompactV1Result[];
  series: CompactV1SeriesCollection;
  metadata: CompactTimeSeriesMetadata;
  stats: CompactTimeSeriesData['decodeStats'];
}

interface CompactV1Result {
  refId: string;
  status: number;
  error?: string;
  notices: CompactTimeSeriesNotice[];
  seriesStart: number;
  seriesCount: number;
}

type CompactSeriesCollection = Exclude<CompactTimeSeriesData['series'], readonly CompactTimeSeriesSeries[]>;
type CompactSeriesColumns = CompactSeriesCollection['columns'];

const POPCOUNT = Uint8Array.from({ length: 256 }, (_, value) => {
  let count = 0;
  while (value > 0) {
    count += value & 1;
    value >>= 1;
  }
  return count;
});

class CompactV1Reader {
  private readonly binary: CompactBinaryReader;

  constructor(buffer: ArrayBuffer) {
    if (buffer.byteLength < COMPACT_RESPONSE_HEADER_SIZE) {
      throw new Error('Invalid compact query response');
    }
    this.binary = new CompactBinaryReader(buffer);
  }

  readResponse(): CompactV1DecodedResponse {
    const { axisCount, resultCount, stringCount, stringBytesLength } = this.readHeader();
    const axes = this.readAxes(axisCount);
    const strings = this.readStrings(stringCount, stringBytesLength);
    const seriesWriter = new CompactV1SeriesWriter(this.countResultFrames(resultCount));
    const results = this.readResults(resultCount, axes, strings, seriesWriter);
    const series = seriesWriter.finish(strings);
    this.assertComplete();
    return {
      axes,
      results,
      series,
      metadata: new CompactV1MetadataReader(this.binary.buffer, strings),
      stats: {
        responseBytes: this.binary.byteLength,
        axisCount,
        resultCount,
        stringCount,
        stringBytes: stringBytesLength,
        seriesCount: series.length,
      },
    };
  }

  readHeader(): CompactV1Header {
    if (
      this.binary.readString(4) !== COMPACT_MAGIC ||
      this.binary.readUint16() !== COMPACT_BINARY_VERSION ||
      this.binary.readUint16() !== 0
    ) {
      throw new Error('Invalid compact query response');
    }

    const axisCount = this.binary.readUint32();
    const resultCount = this.binary.readUint32();
    const stringCount = this.binary.readUint32();
    const stringBytesLength = this.binary.readUint32();
    if (
      axisCount > Math.floor(this.binary.remaining / COMPACT_AXIS_RECORD_SIZE) ||
      resultCount > Math.floor(this.binary.remaining / COMPACT_RESULT_HEADER_SIZE) ||
      stringCount < 1 ||
      stringCount > Math.floor(this.binary.remaining / COMPACT_STRING_RECORD_SIZE) ||
      this.binary.readUint64() !== 0
    ) {
      throw new Error('Invalid compact query response');
    }
    return { axisCount, resultCount, stringCount, stringBytesLength };
  }

  readAxes(axisCount: number): CompactTimeSeriesAxis[] {
    const axes: CompactTimeSeriesAxis[] = [];
    for (let axisIndex = 0; axisIndex < axisCount; axisIndex++) {
      axes.push(this.readAxis());
    }
    return axes;
  }

  private readAxis(): CompactTimeSeriesAxis {
    this.binary.ensureRemaining(COMPACT_AXIS_RECORD_SIZE);
    const start = this.binary.readSafeInt64();
    const step = this.binary.readSafeUint64();
    const count = this.binary.readUint32();
    if (this.binary.readUint32() !== 0 || step <= 0 || count < 1 || !Number.isSafeInteger(start + step * (count - 1))) {
      throw new Error('Invalid compact query response');
    }

    return Object.freeze({ start, step, count });
  }

  private readStrings(stringCount: number, stringBytesLength: number): CompactV1StringTable {
    const recordsOffset = this.binary.offset;
    this.binary.ensureRemaining(stringCount * COMPACT_STRING_RECORD_SIZE + stringBytesLength);
    let expectedOffset = 0;
    for (let index = 0; index < stringCount; index++) {
      const offset = this.binary.readUint32();
      const length = this.binary.readUint32();
      if (offset !== expectedOffset || offset + length > stringBytesLength || (index === 0 && length !== 0)) {
        throw new Error('Invalid compact query response');
      }
      expectedOffset += length;
    }
    if (expectedOffset !== stringBytesLength) {
      throw new Error('Invalid compact query response');
    }
    const bytesOffset = this.binary.offset;
    this.binary.skip(stringBytesLength);
    this.binary.alignTo8WithZeros();
    const strings = new CompactV1StringTable(this.binary.buffer, stringCount, recordsOffset, bytesOffset);
    strings.validateEncoding();
    return strings;
  }

  private countResultFrames(resultCount: number): number {
    let offset = this.binary.offset;
    let frameCount = 0;
    for (let resultIndex = 0; resultIndex < resultCount; resultIndex++) {
      if (offset + COMPACT_RESULT_HEADER_SIZE > this.binary.byteLength) {
        throw new Error('Invalid compact query response');
      }
      const recordLength = this.binary.getUint32At(offset);
      const resultFrameCount = this.binary.getUint32At(offset + 20);
      const noticeCount = this.binary.getUint32At(offset + 44);
      const metadataLength = COMPACT_RESULT_HEADER_SIZE + noticeCount * COMPACT_NOTICE_RECORD_SIZE;
      if (
        !Number.isSafeInteger(metadataLength) ||
        recordLength < metadataLength ||
        offset + recordLength > this.binary.byteLength ||
        resultFrameCount > Math.floor((recordLength - metadataLength) / COMPACT_FRAME_HEADER_SIZE) ||
        frameCount + resultFrameCount > Math.floor(this.binary.byteLength / COMPACT_FRAME_HEADER_SIZE)
      ) {
        throw new Error('Invalid compact query response');
      }
      frameCount += resultFrameCount;
      offset += recordLength;
    }
    return frameCount;
  }

  readResults(
    resultCount: number,
    axes: CompactTimeSeriesAxis[],
    strings: CompactV1StringTable,
    seriesWriter: CompactV1SeriesWriter
  ): CompactV1Result[] {
    const results: CompactV1Result[] = [];
    const refIDs = new Set<string>();
    for (let resultIndex = 0; resultIndex < resultCount; resultIndex++) {
      const result = this.readResult(axes, strings, seriesWriter);
      if (refIDs.has(result.refId)) {
        throw new Error('Invalid compact query response');
      }
      refIDs.add(result.refId);
      results.push(result);
    }
    return results;
  }

  private readResult(
    axes: CompactTimeSeriesAxis[],
    strings: CompactV1StringTable,
    seriesWriter: CompactV1SeriesWriter
  ): CompactV1Result {
    const resultStart = this.binary.offset;
    this.binary.ensureRemaining(COMPACT_RESULT_HEADER_SIZE);
    const recordLength = this.binary.readUint32();
    const refIDStringID = this.binary.readUint32();
    const errorStringID = this.binary.readUint32();
    const executedQueryStringID = this.binary.readUint32();
    const status = this.binary.readInt32();
    const frameCount = this.binary.readUint32();
    const calculatedMinStep = this.binary.readSafeInt64();
    const resultType = this.binary.readUint16();
    const frameType = this.binary.readUint16();
    const versionMajor = this.binary.readUint16();
    const versionMinor = this.binary.readUint16();
    const flags = this.binary.readUint32();
    const noticeCount = this.binary.readUint32();
    const resultEnd = resultStart + recordLength;
    const metadataLength = COMPACT_RESULT_HEADER_SIZE + noticeCount * COMPACT_NOTICE_RECORD_SIZE;
    if (
      !Number.isSafeInteger(metadataLength) ||
      recordLength < metadataLength ||
      frameCount > Math.floor((recordLength - metadataLength) / COMPACT_FRAME_HEADER_SIZE) ||
      resultEnd > this.binary.byteLength ||
      refIDStringID >= strings.count ||
      errorStringID >= strings.count ||
      executedQueryStringID >= strings.count ||
      (flags & ~COMPACT_RESULT_FLAG_CALCULATED_MIN_STEP) !== 0 ||
      ((flags & COMPACT_RESULT_FLAG_CALCULATED_MIN_STEP) !== 0 ? calculatedMinStep <= 0 : calculatedMinStep !== 0) ||
      (frameCount > 0 &&
        (resultType !== COMPACT_RESULT_TYPE_MATRIX || frameType !== COMPACT_FRAME_TYPE_TIME_SERIES_MULTI)) ||
      (frameCount === 0 && (resultType !== 0 || frameType !== 0 || versionMajor !== 0 || versionMinor !== 0))
    ) {
      throw new Error('Invalid compact query response');
    }

    const refId = strings.get(refIDStringID);
    const error = strings.get(errorStringID);
    const executedQueryString = strings.get(executedQueryStringID);
    if ((error !== '' && frameCount !== 0) || (error === '' && status !== 0 && status !== 200)) {
      throw new Error('Invalid compact query response');
    }
    const notices = this.readNotices(noticeCount, strings, refId);

    let firstMetaId = 0;
    let sharedMetaId = 0;
    if (frameCount > 0) {
      firstMetaId = seriesWriter.addMeta(
        this.createFrameMeta({
          resultType,
          frameType,
          versionMajor,
          versionMinor,
          calculatedMinStep,
          flags,
          executedQueryString,
          notices,
          frameIndex: 0,
        })
      );
      sharedMetaId =
        frameCount > 1
          ? seriesWriter.addMeta(
              this.createFrameMeta({
                resultType,
                frameType,
                versionMajor,
                versionMinor,
                calculatedMinStep,
                flags,
                executedQueryString,
                notices,
                frameIndex: 1,
              })
            )
          : firstMetaId;
    }
    const seriesStart = seriesWriter.length;
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      this.readFrame(
        axes,
        strings,
        resultEnd,
        seriesWriter,
        refIDStringID,
        frameIndex === 0 ? firstMetaId : sharedMetaId
      );
    }
    this.assertOffset(resultEnd);

    return { refId, status, error: error || undefined, notices, seriesStart, seriesCount: frameCount };
  }

  private readNotices(noticeCount: number, strings: CompactV1StringTable, refId: string): CompactTimeSeriesNotice[] {
    this.binary.ensureRemaining(noticeCount * COMPACT_NOTICE_RECORD_SIZE);
    const notices: CompactTimeSeriesNotice[] = [];
    const severities = ['info', 'warning', 'error'] as const;
    const inspectTypes = [undefined, 'meta', 'error', 'data', 'stats'] as const;
    for (let noticeIndex = 0; noticeIndex < noticeCount; noticeIndex++) {
      const textStringID = this.binary.readUint32();
      const linkStringID = this.binary.readUint32();
      const severity = this.binary.readUint8();
      const inspect = this.binary.readUint8();
      if (
        this.binary.readUint16() !== 0 ||
        this.binary.readUint32() !== 0 ||
        textStringID >= strings.count ||
        linkStringID >= strings.count ||
        severity >= severities.length ||
        inspect >= inspectTypes.length
      ) {
        throw new Error('Invalid compact query response');
      }
      const link = strings.get(linkStringID);
      notices.push({
        refId,
        severity: severities[severity],
        text: strings.get(textStringID),
        link: link || undefined,
        inspect: inspectTypes[inspect],
      });
    }
    return notices;
  }

  private readFrame(
    axes: CompactTimeSeriesAxis[],
    strings: CompactV1StringTable,
    resultEnd: number,
    seriesWriter: CompactV1SeriesWriter,
    resultRefIDStringID: number,
    metaId: number
  ): void {
    const frameStart = this.binary.offset;
    this.binary.ensureRemaining(COMPACT_FRAME_HEADER_SIZE);
    const recordLength = this.binary.readUint32();
    const axisID = this.binary.readUint32();
    const presentCount = this.binary.readUint32();
    const bitmapLength = this.binary.readUint32();
    const frameNameStringID = this.binary.readUint32();
    const frameRefIDStringID = this.binary.readUint32();
    const valueNameStringID = this.binary.readUint32();
    const displayNameStringID = this.binary.readUint32();
    const labelCount = this.binary.readUint32();
    const flags = this.binary.readUint32();
    const frameEnd = frameStart + recordLength;
    if (
      this.binary.readUint64() !== 0 ||
      recordLength < COMPACT_FRAME_HEADER_SIZE ||
      frameEnd > resultEnd ||
      axisID >= axes.length ||
      labelCount > Math.floor((frameEnd - this.binary.offset) / COMPACT_LABEL_RECORD_SIZE) ||
      flags !== 0 ||
      frameNameStringID >= strings.count ||
      frameRefIDStringID >= strings.count ||
      valueNameStringID >= strings.count ||
      displayNameStringID >= strings.count
    ) {
      throw new Error('Invalid compact query response');
    }

    const axis = axes[axisID];
    const labelRecordsOffset = this.binary.offset;
    let previousLabelNameStringID: number | undefined;
    this.binary.ensureRemaining(labelCount * COMPACT_LABEL_RECORD_SIZE);
    for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
      const nameStringID = this.binary.readUint32();
      const valueStringID = this.binary.readUint32();
      if (nameStringID === 0 || nameStringID >= strings.count || valueStringID >= strings.count) {
        throw new Error('Invalid compact query response');
      }
      if (previousLabelNameStringID != null && strings.compare(previousLabelNameStringID, nameStringID) >= 0) {
        throw new Error('Invalid compact query response');
      }
      previousLabelNameStringID = nameStringID;
    }
    const presenceByteOffset = this.binary.offset;
    this.readPresenceBitmap(bitmapLength, presentCount, axis.count);
    this.binary.alignTo8WithZeros();
    const valuesByteOffset = this.binary.offset;
    if (valuesByteOffset % 8 !== 0 || valuesByteOffset + presentCount * 8 !== frameEnd) {
      throw new Error('Invalid compact query response');
    }
    this.binary.skip(presentCount * 8);
    this.assertOffset(frameEnd);

    seriesWriter.write(
      frameRefIDStringID || resultRefIDStringID,
      frameNameStringID,
      valueNameStringID,
      displayNameStringID,
      metaId,
      axisID,
      labelRecordsOffset,
      labelCount,
      presenceByteOffset,
      bitmapLength,
      presentCount,
      valuesByteOffset
    );
  }

  private createFrameMeta(result: {
    resultType: number;
    frameType: number;
    versionMajor: number;
    versionMinor: number;
    calculatedMinStep: number;
    flags: number;
    executedQueryString: string;
    notices: CompactTimeSeriesNotice[];
    frameIndex: number;
  }): QueryResultMeta {
    const custom: Record<string, unknown> = { resultType: 'matrix' };
    if (result.frameIndex === 0 && (result.flags & COMPACT_RESULT_FLAG_CALCULATED_MIN_STEP) !== 0) {
      custom.calculatedMinStep = result.calculatedMinStep;
    }
    return {
      type: DataFrameType.TimeSeriesMulti,
      typeVersion: [result.versionMajor, result.versionMinor],
      custom,
      executedQueryString: result.frameIndex === 0 ? result.executedQueryString || undefined : undefined,
      notices: result.notices,
    };
  }

  private readPresenceBitmap(bitmapLength: number, presentCount: number, axisLength: number): void {
    const expectedBitmapLength = presentCount === axisLength ? 0 : Math.ceil(axisLength / 8);
    if (presentCount > axisLength || bitmapLength !== expectedBitmapLength) {
      throw new Error('Invalid compact query response');
    }

    if (bitmapLength === 0) {
      return;
    }

    let bitmapPresentCount = 0;
    let lastByte = 0;
    for (let index = 0; index < bitmapLength; index++) {
      const byte = this.binary.readUint8();
      lastByte = byte;
      bitmapPresentCount += POPCOUNT[byte];
    }
    const unusedBitCount = bitmapLength * 8 - axisLength;
    const unusedBitMask = unusedBitCount === 0 ? 0 : 0xff << (8 - unusedBitCount);
    if ((lastByte & unusedBitMask) !== 0) {
      throw new Error('Invalid compact query response');
    }
    if (bitmapPresentCount !== presentCount) {
      throw new Error('Invalid compact query response');
    }
  }

  private assertOffset(expected: number) {
    if (this.binary.offset !== expected) {
      throw new Error('Invalid compact query response');
    }
  }

  assertComplete() {
    this.assertOffset(this.binary.byteLength);
  }
}

class CompactBinaryReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private readonly sourceBuffer: ArrayBuffer;
  offset = 0;

  constructor(buffer: ArrayBuffer) {
    this.sourceBuffer = buffer;
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }

  get byteLength(): number {
    return this.view.byteLength;
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  get buffer(): ArrayBuffer {
    return this.sourceBuffer;
  }

  getUint32At(offset: number): number {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > this.view.byteLength) {
      throw new Error('Invalid compact query response');
    }
    return this.view.getUint32(offset, true);
  }

  ensureRemaining(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.view.byteLength) {
      throw new Error('Invalid compact query response');
    }
  }

  readBytes(length: number): Uint8Array {
    this.ensureRemaining(length);
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readString(length: number): string {
    return textDecoder.decode(this.readBytes(length));
  }

  readUint16(): number {
    this.ensureRemaining(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readUint8(): number {
    this.ensureRemaining(1);
    return this.bytes[this.offset++];
  }

  readUint32(): number {
    this.ensureRemaining(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readInt32(): number {
    this.ensureRemaining(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readUint64(): number {
    return this.readSafeBigInt(this.view.getBigUint64.bind(this.view));
  }

  readSafeUint64(): number {
    return this.readUint64();
  }

  readSafeInt64(): number {
    return this.readSafeBigInt(this.view.getBigInt64.bind(this.view));
  }

  readFloat64(): number {
    this.ensureRemaining(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  skip(length: number) {
    this.ensureRemaining(length);
    this.offset += length;
  }

  alignTo8WithZeros() {
    const padding = (8 - (this.offset % 8)) % 8;
    for (let index = 0; index < padding; index++) {
      if (this.readUint8() !== 0) {
        throw new Error('Invalid compact query response');
      }
    }
  }

  private readSafeBigInt(read: (byteOffset: number, littleEndian?: boolean) => bigint): number {
    this.ensureRemaining(8);
    const value = Number(read(this.offset, true));
    this.offset += 8;
    if (!Number.isSafeInteger(value)) {
      throw new Error('Invalid compact query response');
    }
    return value;
  }
}

class CompactV1SeriesWriter {
  private readonly columns: CompactSeriesColumns;
  private readonly metas: QueryResultMeta[] = [];
  private offset = 0;

  constructor(length: number) {
    this.columns = {
      refIdStringIds: new Uint32Array(length),
      frameNameStringIds: new Uint32Array(length),
      valueNameStringIds: new Uint32Array(length),
      displayNameStringIds: new Uint32Array(length),
      metaIds: new Uint32Array(length),
      axisIds: new Uint32Array(length),
      labelRecordsOffsets: new Uint32Array(length),
      labelCounts: new Uint32Array(length),
      presenceByteOffsets: new Uint32Array(length),
      presenceByteLengths: new Uint32Array(length),
      presentCounts: new Uint32Array(length),
      valuesByteOffsets: new Uint32Array(length),
    };
  }

  get length(): number {
    return this.offset;
  }

  addMeta(meta: QueryResultMeta): number {
    const id = this.metas.length;
    this.metas.push(meta);
    return id;
  }

  write(
    refIdStringId: number,
    frameNameStringId: number,
    valueNameStringId: number,
    displayNameStringId: number,
    metaId: number,
    axisId: number,
    labelRecordsOffset: number,
    labelCount: number,
    presenceByteOffset: number,
    presenceByteLength: number,
    presentCount: number,
    valuesByteOffset: number
  ): void {
    if (this.offset >= this.columns.axisIds.length) {
      throw new Error('Invalid compact query response');
    }
    const index = this.offset++;
    this.columns.refIdStringIds[index] = refIdStringId;
    this.columns.frameNameStringIds[index] = frameNameStringId;
    this.columns.valueNameStringIds[index] = valueNameStringId;
    this.columns.displayNameStringIds[index] = displayNameStringId;
    this.columns.metaIds[index] = metaId;
    this.columns.axisIds[index] = axisId;
    this.columns.labelRecordsOffsets[index] = labelRecordsOffset;
    this.columns.labelCounts[index] = labelCount;
    this.columns.presenceByteOffsets[index] = presenceByteOffset;
    this.columns.presenceByteLengths[index] = presenceByteLength;
    this.columns.presentCounts[index] = presentCount;
    this.columns.valuesByteOffsets[index] = valuesByteOffset;
  }

  finish(strings: CompactV1StringTable): CompactV1SeriesCollection {
    if (this.offset !== this.columns.axisIds.length) {
      throw new Error('Invalid compact query response');
    }
    return new CompactV1SeriesCollection(this.columns, strings, this.metas);
  }
}

class CompactV1SeriesCollection implements CompactSeriesCollection {
  private readonly view: DataView;

  constructor(
    readonly columns: CompactSeriesColumns,
    private readonly strings: CompactV1StringTable,
    private readonly metas: readonly QueryResultMeta[],
    private readonly selection?: Uint32Array,
    buffer: ArrayBuffer = strings.buffer
  ) {
    this.view = new DataView(buffer);
  }

  get length(): number {
    return this.selection?.length ?? this.columns.axisIds.length;
  }

  resolveColumnIndex(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`Compact series index ${index} is out of range`);
    }
    return this.selection?.[index] ?? index;
  }

  get(index: number): CompactTimeSeriesSeries {
    const columnIndex = this.resolveColumnIndex(index);
    return {
      refId: this.getRefId(index),
      frameName: this.getFrameName(index),
      valueName: this.getValueName(index),
      displayNameFromDS: this.getDisplayNameFromDS(index),
      meta: this.getMeta(index),
      axisId: this.columns.axisIds[columnIndex],
      labelRecordsOffset: this.columns.labelRecordsOffsets[columnIndex],
      labelCount: this.columns.labelCounts[columnIndex],
      presenceByteOffset: this.columns.presenceByteOffsets[columnIndex],
      presenceByteLength: this.columns.presenceByteLengths[columnIndex],
      presentCount: this.columns.presentCounts[columnIndex],
      valuesByteOffset: this.columns.valuesByteOffsets[columnIndex],
    };
  }

  getRefId(index: number): string {
    return this.strings.get(this.columns.refIdStringIds[this.resolveColumnIndex(index)]);
  }

  getFrameName(index: number): string | undefined {
    const value = this.strings.get(this.columns.frameNameStringIds[this.resolveColumnIndex(index)]);
    return value || undefined;
  }

  getValueName(index: number): string {
    return this.strings.get(this.columns.valueNameStringIds[this.resolveColumnIndex(index)]);
  }

  getDisplayNameFromDS(index: number): string | undefined {
    const value = this.strings.get(this.columns.displayNameStringIds[this.resolveColumnIndex(index)]);
    return value || undefined;
  }

  getMeta(index: number): QueryResultMeta {
    return this.metas[this.columns.metaIds[this.resolveColumnIndex(index)]];
  }

  getLabel(index: number, name: string): string | undefined {
    const columnIndex = this.resolveColumnIndex(index);
    const count = this.columns.labelCounts[columnIndex];
    const offset = this.columns.labelRecordsOffsets[columnIndex];
    for (let labelIndex = 0; labelIndex < count; labelIndex++) {
      const recordOffset = offset + labelIndex * COMPACT_LABEL_RECORD_SIZE;
      if (this.strings.get(this.view.getUint32(recordOffset, true)) === name) {
        return this.strings.get(this.view.getUint32(recordOffset + 4, true));
      }
    }
    return undefined;
  }

  forEachLabel(index: number, callback: (name: string, value: string) => void): void {
    const columnIndex = this.resolveColumnIndex(index);
    const count = this.columns.labelCounts[columnIndex];
    const offset = this.columns.labelRecordsOffsets[columnIndex];
    for (let labelIndex = 0; labelIndex < count; labelIndex++) {
      const recordOffset = offset + labelIndex * COMPACT_LABEL_RECORD_SIZE;
      callback(
        this.strings.get(this.view.getUint32(recordOffset, true)),
        this.strings.get(this.view.getUint32(recordOffset + 4, true))
      );
    }
  }

  getSharedLabelName(): string | null {
    let sharedNameId: number | undefined;
    for (let index = 0; index < this.length; index++) {
      const columnIndex = this.resolveColumnIndex(index);
      const count = this.columns.labelCounts[columnIndex];
      const offset = this.columns.labelRecordsOffsets[columnIndex];
      for (let labelIndex = 0; labelIndex < count; labelIndex++) {
        const nameId = this.view.getUint32(offset + labelIndex * COMPACT_LABEL_RECORD_SIZE, true);
        if (sharedNameId == null) {
          sharedNameId = nameId;
        } else if (sharedNameId !== nameId) {
          return null;
        }
      }
    }
    return sharedNameId == null ? null : this.strings.get(sharedNameId);
  }

  getIdentityHash(index: number): number {
    const columnIndex = this.resolveColumnIndex(index);
    let hash = 2166136261;
    hash = mixHash(hash, this.strings.hash(this.columns.refIdStringIds[columnIndex]));
    hash = mixHash(hash, this.strings.hash(this.columns.frameNameStringIds[columnIndex]));
    hash = mixHash(hash, this.strings.hash(this.columns.valueNameStringIds[columnIndex]));
    hash = mixHash(hash, this.strings.hash(this.columns.displayNameStringIds[columnIndex]));
    const count = this.columns.labelCounts[columnIndex];
    const offset = this.columns.labelRecordsOffsets[columnIndex];
    hash = mixHash(hash, count);
    for (let labelIndex = 0; labelIndex < count; labelIndex++) {
      const recordOffset = offset + labelIndex * COMPACT_LABEL_RECORD_SIZE;
      hash = mixHash(hash, this.strings.hash(this.view.getUint32(recordOffset, true)));
      hash = mixHash(hash, this.strings.hash(this.view.getUint32(recordOffset + 4, true)));
    }
    return hash >>> 0;
  }

  map<T>(callback: (series: CompactTimeSeriesSeries, index: number) => T): T[] {
    const values = new Array<T>(this.length);
    for (let index = 0; index < this.length; index++) {
      values[index] = callback(this.get(index), index);
    }
    return values;
  }

  some(callback: (series: CompactTimeSeriesSeries, index: number) => boolean): boolean {
    for (let index = 0; index < this.length; index++) {
      if (callback(this.get(index), index)) {
        return true;
      }
    }
    return false;
  }

  filter(callback: (series: CompactTimeSeriesSeries, index: number) => boolean): CompactV1SeriesCollection {
    const selected: number[] = [];
    for (let index = 0; index < this.length; index++) {
      if (callback(this.get(index), index)) {
        selected.push(this.resolveColumnIndex(index));
      }
    }
    if (selected.length === this.length) {
      return this;
    }
    return new CompactV1SeriesCollection(this.columns, this.strings, this.metas, Uint32Array.from(selected));
  }

  excludeRefId(refId: string): CompactV1SeriesCollection {
    return this.excludeRefIds(new Set([refId]));
  }

  excludeRefIds(refIds: ReadonlySet<string>): CompactV1SeriesCollection {
    if (refIds.size === 0) {
      return this;
    }
    let selectedLength = 0;
    for (let index = 0; index < this.length; index++) {
      if (!refIds.has(this.getRefId(index))) {
        selectedLength++;
      }
    }
    if (selectedLength === this.length) {
      return this;
    }
    const selected = new Uint32Array(selectedLength);
    let selectedIndex = 0;
    for (let index = 0; index < this.length; index++) {
      if (!refIds.has(this.getRefId(index))) {
        selected[selectedIndex++] = this.resolveColumnIndex(index);
      }
    }
    return new CompactV1SeriesCollection(this.columns, this.strings, this.metas, selected);
  }

  forEach(callback: (series: CompactTimeSeriesSeries, index: number) => void): void {
    for (let index = 0; index < this.length; index++) {
      callback(this.get(index), index);
    }
  }

  *[Symbol.iterator](): Iterator<CompactTimeSeriesSeries> {
    for (let index = 0; index < this.length; index++) {
      yield this.get(index);
    }
  }

  selectResults(results: readonly CompactV1Result[]): CompactV1SeriesCollection {
    const length = results.reduce((total, result) => total + result.seriesCount, 0);
    let expectedIndex = 0;
    const isIdentity =
      length === this.length &&
      results.every((result) => {
        const matches = result.seriesStart === expectedIndex;
        expectedIndex += result.seriesCount;
        return matches;
      });
    if (isIdentity) {
      return this;
    }

    const selection = new Uint32Array(length);
    let selectionIndex = 0;
    for (const result of results) {
      for (let offset = 0; offset < result.seriesCount; offset++) {
        selection[selectionIndex++] = result.seriesStart + offset;
      }
    }
    return new CompactV1SeriesCollection(this.columns, this.strings, this.metas, selection);
  }
}

class CompactV1StringTable {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private readonly cache = new Map<number, string>();

  constructor(
    readonly buffer: ArrayBuffer,
    readonly count: number,
    private readonly recordsOffset: number,
    private readonly bytesOffset: number
  ) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }

  get(index: number): string {
    const cached = this.cache.get(index);
    if (cached != null) {
      return cached;
    }
    this.assertIndex(index);
    const recordOffset = this.recordsOffset + index * COMPACT_STRING_RECORD_SIZE;
    const offset = this.view.getUint32(recordOffset, true);
    const length = this.view.getUint32(recordOffset + 4, true);
    const value = textDecoder.decode(
      this.bytes.subarray(this.bytesOffset + offset, this.bytesOffset + offset + length)
    );
    this.cache.set(index, value);
    return value;
  }

  hash(index: number): number {
    this.assertIndex(index);
    const recordOffset = this.recordsOffset + index * COMPACT_STRING_RECORD_SIZE;
    const offset = this.view.getUint32(recordOffset, true);
    const length = this.view.getUint32(recordOffset + 4, true);
    let hash = 2166136261;
    for (let byteIndex = 0; byteIndex < length; byteIndex++) {
      hash ^= this.bytes[this.bytesOffset + offset + byteIndex];
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  compare(leftIndex: number, rightIndex: number): number {
    this.assertIndex(leftIndex);
    this.assertIndex(rightIndex);
    const leftRecordOffset = this.recordsOffset + leftIndex * COMPACT_STRING_RECORD_SIZE;
    const rightRecordOffset = this.recordsOffset + rightIndex * COMPACT_STRING_RECORD_SIZE;
    const leftOffset = this.view.getUint32(leftRecordOffset, true);
    const leftLength = this.view.getUint32(leftRecordOffset + 4, true);
    const rightOffset = this.view.getUint32(rightRecordOffset, true);
    const rightLength = this.view.getUint32(rightRecordOffset + 4, true);
    const commonLength = Math.min(leftLength, rightLength);
    for (let index = 0; index < commonLength; index++) {
      const difference =
        this.bytes[this.bytesOffset + leftOffset + index] - this.bytes[this.bytesOffset + rightOffset + index];
      if (difference !== 0) {
        return difference;
      }
    }
    return leftLength - rightLength;
  }

  validateEncoding(): void {
    for (let index = 0; index < this.count; index++) {
      const recordOffset = this.recordsOffset + index * COMPACT_STRING_RECORD_SIZE;
      const offset = this.view.getUint32(recordOffset, true);
      const length = this.view.getUint32(recordOffset + 4, true);
      if (!isValidUtf8(this.bytes, this.bytesOffset + offset, this.bytesOffset + offset + length)) {
        throw new Error('Invalid compact query response');
      }
    }
  }

  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new Error('Invalid compact query response');
    }
  }
}

function mixHash(hash: number, value: number): number {
  hash ^= value;
  return Math.imul(hash, 16777619) >>> 0;
}

function isValidUtf8(bytes: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    const first = bytes[index];
    if (first <= 0x7f) {
      continue;
    }
    const second = bytes[++index];
    if (first >= 0xc2 && first <= 0xdf) {
      if (index >= end || !isUtf8Continuation(second)) {
        return false;
      }
      continue;
    }
    const third = bytes[++index];
    if (first >= 0xe0 && first <= 0xef) {
      if (
        index >= end ||
        !isUtf8Continuation(third) ||
        (first === 0xe0
          ? second < 0xa0 || second > 0xbf
          : first === 0xed
            ? second < 0x80 || second > 0x9f
            : !isUtf8Continuation(second))
      ) {
        return false;
      }
      continue;
    }
    const fourth = bytes[++index];
    if (first >= 0xf0 && first <= 0xf4) {
      if (
        index >= end ||
        !isUtf8Continuation(third) ||
        !isUtf8Continuation(fourth) ||
        (first === 0xf0
          ? second < 0x90 || second > 0xbf
          : first === 0xf4
            ? second < 0x80 || second > 0x8f
            : !isUtf8Continuation(second))
      ) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

function isUtf8Continuation(value: number | undefined): boolean {
  return value != null && value >= 0x80 && value <= 0xbf;
}

class CompactV1MetadataReader implements CompactTimeSeriesMetadata {
  private readonly view: DataView;

  constructor(
    buffer: ArrayBuffer,
    private readonly strings: CompactV1StringTable
  ) {
    this.view = new DataView(buffer);
  }

  getLabel(series: CompactTimeSeriesSeries, name: string): string | undefined {
    for (let index = 0; index < series.labelCount; index++) {
      const recordOffset = series.labelRecordsOffset + index * COMPACT_LABEL_RECORD_SIZE;
      if (this.strings.get(this.view.getUint32(recordOffset, true)) === name) {
        return this.strings.get(this.view.getUint32(recordOffset + 4, true));
      }
    }
    return undefined;
  }

  forEachLabel(series: CompactTimeSeriesSeries, callback: (name: string, value: string) => void): void {
    for (let index = 0; index < series.labelCount; index++) {
      const recordOffset = series.labelRecordsOffset + index * COMPACT_LABEL_RECORD_SIZE;
      callback(
        this.strings.get(this.view.getUint32(recordOffset, true)),
        this.strings.get(this.view.getUint32(recordOffset + 4, true))
      );
    }
  }

  materializeLabels(series: CompactTimeSeriesSeries, additional?: Labels): Labels | undefined {
    if (series.labelCount === 0 && !additional) {
      return undefined;
    }
    const labels: Labels = additional ? { ...additional } : {};
    this.forEachLabel(series, (name, value) => {
      labels[name] = value;
    });
    return labels;
  }
}

function hasErrorMessage(value: unknown): value is DataQueryError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string' &&
    value.message.length > 0
  );
}

function isCachedResponse(res: QueryFetchResponse): boolean {
  const headers = res?.headers;
  if (!headers || !headers.get) {
    return false;
  }
  return headers.get('X-Cache') === 'HIT';
}

function addCacheNotice(frame: DataFrameJSON): DataFrameJSON {
  return {
    ...frame,
    schema: {
      ...frame.schema,
      fields: [...(frame.schema?.fields ?? [])],
      meta: {
        ...frame.schema?.meta,
        notices: [...(frame.schema?.meta?.notices ?? []), cachedResponseNotice],
        isCachedResponse: true,
      },
    },
  };
}

function addCacheNoticeToDataFrame(frame: DataFrame): DataFrame {
  return {
    ...frame,
    meta: {
      ...frame.meta,
      notices: [...(frame.meta?.notices ?? []), cachedResponseNotice],
      isCachedResponse: true,
    },
  };
}

export interface TestingStatus {
  message?: string | null;
  status?: string | null;
  details?: HealthCheckResultDetails;
}

/**
 * Data sources using api/ds/query to test data sources can use this function to
 * handle errors and convert them to TestingStatus object.
 *
 * If possible, this should be avoided in favor of implementing /health endpoint
 * and testing data source with DataSourceWithBackend.testDataSource()
 *
 * Re-thrown errors are handled by testDataSource() in public/app/features/datasources/state/actions.ts
 *
 * @returns {TestingStatus}
 */
export function toTestingStatus(err: FetchError): TestingStatus {
  const queryResponse = toDataQueryResponse(err);
  // POST api/ds/query errors returned as { message: string, error: string } objects
  if (queryResponse.error?.data?.message) {
    return {
      status: 'error',
      message: queryResponse.error.data.message,
      details: queryResponse.error?.data?.error ? { message: queryResponse.error.data.error } : undefined,
    };
  }
  // POST api/ds/query errors returned in results object
  else if (queryResponse.error?.refId && queryResponse.error?.message) {
    return {
      status: 'error',
      message: queryResponse.error.message,
    };
  }

  throw err;
}

/**
 * Return the first string or non-time field as the value
 *
 * @beta
 */
export function frameToMetricFindValue(frame: DataFrame): MetricFindValue[] {
  if (!frame || !frame.length) {
    return [];
  }

  const values: MetricFindValue[] = [];
  let field = frame.fields.find((f) => f.type === FieldType.string);
  if (!field) {
    field = frame.fields.find((f) => f.type !== FieldType.time);
  }
  if (field) {
    for (let i = 0; i < field.values.length; i++) {
      values.push({ text: '' + field.values[i] });
    }
  }
  return values;
}
