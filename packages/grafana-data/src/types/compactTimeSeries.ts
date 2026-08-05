import { Labels, QueryResultMeta, QueryResultMetaNotice } from './data';

/** @internal */
export const COMPACT_TIME_SERIES_FORMAT = 'grafana-querydata-compact-v1' as const;

/** @internal */
export interface CompactTimeSeriesAxis {
  start: number;
  step: number;
  count: number;
}

/** @internal */
export interface CompactTimeSeriesSeries {
  refId: string;
  frameName?: string;
  valueName: string;
  displayNameFromDS?: string;
  meta?: QueryResultMeta;
  axisId: number;
  labelRecordsOffset: number;
  labelCount: number;
  presenceByteOffset: number;
  presenceByteLength: number;
  presentCount: number;
  valuesByteOffset: number;
}

/** Buffer-offset and string-ID columns shared by all compact series. @internal */
export interface CompactTimeSeriesSeriesColumns {
  readonly refIdStringIds: Uint32Array;
  readonly frameNameStringIds: Uint32Array;
  readonly valueNameStringIds: Uint32Array;
  readonly displayNameStringIds: Uint32Array;
  readonly metaIds: Uint32Array;
  readonly axisIds: Uint32Array;
  readonly labelRecordsOffsets: Uint32Array;
  readonly labelCounts: Uint32Array;
  readonly presenceByteOffsets: Uint32Array;
  readonly presenceByteLengths: Uint32Array;
  readonly presentCounts: Uint32Array;
  readonly valuesByteOffsets: Uint32Array;
}

/**
 * Lazy series collection backed by typed columns. Iteration materializes only
 * the records consumed by the caller.
 *
 * @internal
 */
export interface CompactTimeSeriesSeriesCollection extends Iterable<CompactTimeSeriesSeries> {
  readonly length: number;
  readonly columns: CompactTimeSeriesSeriesColumns;
  get(index: number): CompactTimeSeriesSeries;
  getRefId(index: number): string;
  getFrameName(index: number): string | undefined;
  getValueName(index: number): string;
  getDisplayNameFromDS(index: number): string | undefined;
  getMeta(index: number): QueryResultMeta;
  getLabel(index: number, name: string): string | undefined;
  forEachLabel(index: number, callback: (name: string, value: string) => void): void;
  getSharedLabelName(): string | null;
  getIdentityHash(index: number): number;
  resolveColumnIndex(index: number): number;
  map<T>(callback: (series: CompactTimeSeriesSeries, index: number) => T): T[];
  some(callback: (series: CompactTimeSeriesSeries, index: number) => boolean): boolean;
  take(count: number): CompactTimeSeriesSeriesCollection;
  filter(callback: (series: CompactTimeSeriesSeries, index: number) => boolean): CompactTimeSeriesSeriesCollection;
  excludeRefId(refId: string): CompactTimeSeriesSeriesCollection;
  excludeRefIds(refIds: ReadonlySet<string>): CompactTimeSeriesSeriesCollection;
  forEach(callback: (series: CompactTimeSeriesSeries, index: number) => void): void;
}

/** @internal */
export type CompactTimeSeriesSeriesList = CompactTimeSeriesSeriesCollection | readonly CompactTimeSeriesSeries[];

/** @internal */
export function isCompactTimeSeriesSeriesCollection(
  value: CompactTimeSeriesSeriesList
): value is CompactTimeSeriesSeriesCollection {
  return !Array.isArray(value);
}

/** Shared buffer reader for metadata that would otherwise require one object per series. @internal */
export interface CompactTimeSeriesMetadata {
  getLabel(series: CompactTimeSeriesSeries, name: string): string | undefined;
  forEachLabel(series: CompactTimeSeriesSeries, callback: (name: string, value: string) => void): void;
  materializeLabels(series: CompactTimeSeriesSeries, additional?: Labels): Labels | undefined;
}

/** Result-scoped notice retained without creating a DataFrame. @internal */
export interface CompactTimeSeriesNotice extends QueryResultMetaNotice {
  refId: string;
}

/**
 * Buffer-backed Prometheus range-query response. Sample values remain encoded
 * until a visualization explicitly materializes its renderer input.
 *
 * @internal
 */
export interface CompactTimeSeriesData {
  readonly kind: 'compact-response-view';
  format: typeof COMPACT_TIME_SERIES_FORMAT;
  buffer: ArrayBuffer;
  axes: readonly CompactTimeSeriesAxis[];
  series: CompactTimeSeriesSeriesList;
  metadata: CompactTimeSeriesMetadata;
  notices?: readonly CompactTimeSeriesNotice[];
  decodeStats: {
    responseBytes: number;
    axisCount: number;
    resultCount: number;
    stringCount: number;
    stringBytes: number;
    seriesCount: number;
  };
}
