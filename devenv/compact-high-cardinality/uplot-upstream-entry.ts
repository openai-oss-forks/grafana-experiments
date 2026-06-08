import uPlot from 'uplot';

import {
  CompactRenderController,
  CompactRenderSource,
  CompactSeriesFlag,
  CompactStyleRecord,
} from '../../packages/grafana-ui/src/components/uPlot/compactRenderer';

type BenchmarkMode = 'legacy' | 'compact';
type BenchmarkFixture = 'server-events' | '600-series' | '2m-single' | '50-series';

interface BenchmarkConfig {
  fixture: BenchmarkFixture;
  mode: BenchmarkMode;
  packed?: number[];
}

interface PreparedBenchmark {
  config: BenchmarkConfig;
  pointCount: number;
  seriesCount: number;
  data?: uPlot.AlignedData;
  source?: CompactRenderSource;
  prepMs: number;
}

interface CanvasCounters {
  strokes: number;
  lineSegments: number;
}

const colors = [
  '#7eb26d',
  '#eab839',
  '#6ed0e0',
  '#ef843c',
  '#e24d42',
  '#1f78c1',
  '#ba43a9',
  '#705da0',
  '#508642',
  '#cca300',
  '#447ebc',
  '#c15c17',
  '#890f02',
  '#0a437c',
  '#6d1f62',
  '#584477',
];

let prepared: PreparedBenchmark | undefined;
let plot: uPlot | undefined;
let target: HTMLDivElement | undefined;
let drawWaiter: ((drawnAt: number) => void) | undefined;
let counters: CanvasCounters = { strokes: 0, lineSegments: 0 };
let countCanvasCalls = false;

const originalStroke = CanvasRenderingContext2D.prototype.stroke;
const originalLineTo = CanvasRenderingContext2D.prototype.lineTo;
CanvasRenderingContext2D.prototype.stroke = function (...args) {
  if (countCanvasCalls) {
    counters.strokes++;
  }
  return originalStroke.apply(this, args);
};
CanvasRenderingContext2D.prototype.lineTo = function (...args) {
  if (countCanvasCalls) {
    counters.lineSegments++;
  }
  return originalLineTo.apply(this, args);
};

window.__uplotUpstreamBenchmark = {
  prepare(config: BenchmarkConfig) {
    destroy();
    const startedAt = performance.now();
    const fixture = createFixture(config);
    prepared = { config, ...fixture, prepMs: performance.now() - startedAt };
    return describePrepared(prepared);
  },

  async render() {
    if (!prepared) {
      throw new Error('Prepare a uPlot benchmark before rendering');
    }
    target = document.createElement('div');
    document.body.append(target);
    counters = { strokes: 0, lineSegments: 0 };
    countCanvasCalls = true;
    const drawComplete = nextDraw();
    const startedAt = performance.now();
    const options = createOptions(prepared, () => {
      drawWaiter?.(performance.now());
      drawWaiter = undefined;
    });
    plot =
      prepared.config.mode === 'compact'
        ? uPlot.compact(options, prepared.source!, new CompactRenderController(prepared.source!), target)
        : new uPlot(options, prepared.data!, target);
    const constructorReturnedAt = performance.now();
    const firstPaint = nextAnimationFrame();
    const [completedAt, firstPaintAt] = await Promise.all([drawComplete, firstPaint]);
    countCanvasCalls = false;
    return {
      constructorMs: constructorReturnedAt - startedAt,
      firstPaintMs: firstPaintAt - startedAt,
      completeMs: completedAt - startedAt,
      canvas: { ...counters },
    };
  },

  async redraw() {
    if (!plot) {
      throw new Error('Render a uPlot benchmark before redrawing');
    }
    counters = { strokes: 0, lineSegments: 0 };
    countCanvasCalls = true;
    const drawComplete = nextDraw();
    const startedAt = performance.now();
    plot.redraw(false);
    const completedAt = await drawComplete;
    countCanvasCalls = false;
    return { completeMs: completedAt - startedAt, canvas: { ...counters } };
  },

  async zoom() {
    if (!plot || !prepared) {
      throw new Error('Render a uPlot benchmark before zooming');
    }
    const from = Math.floor(prepared.pointCount * 0.25);
    const to = Math.max(from + 1, Math.floor(prepared.pointCount * 0.75));
    const xAt =
      prepared.config.mode === 'compact'
        ? (index: number) => prepared!.source!.xAt(index)
        : (index: number) => prepared!.data![0][index] as number;
    counters = { strokes: 0, lineSegments: 0 };
    countCanvasCalls = true;
    const drawComplete = nextDraw();
    const startedAt = performance.now();
    plot.setScale('x', { min: xAt(from), max: xAt(to) });
    const completedAt = await drawComplete;
    countCanvasCalls = false;
    return { completeMs: completedAt - startedAt, canvas: { ...counters } };
  },

  destroy,
};

function createFixture(config: BenchmarkConfig) {
  if (config.fixture === 'server-events') {
    if (!config.packed) {
      throw new Error('The server-events benchmark requires upstream packed data');
    }
    return createServerEvents(config.mode, config.packed);
  }
  const dimensions =
    config.fixture === '600-series'
      ? { seriesCount: 600, pointCount: 8_000, seriesShift: 1 }
      : config.fixture === '2m-single'
        ? { seriesCount: 1, pointCount: 2_000_000, seriesShift: 0 }
        : { seriesCount: 50, pointCount: 40_000, seriesShift: 2 };
  return createSynthetic(config.mode, dimensions.seriesCount, dimensions.pointCount, dimensions.seriesShift);
}

function createServerEvents(mode: BenchmarkMode, packedInput: number[]) {
  const fieldCount = packedInput[0];
  const packed = packedInput.slice(fieldCount + 1);
  const pointCount = packed.length / fieldCount;
  if (!Number.isInteger(pointCount)) {
    throw new Error('Invalid upstream server-events fixture');
  }
  const start = packed[0] * 60;
  const valueAt = (series: number, index: number) => {
    const offset = index * fieldCount;
    return series === 0
      ? round(packed[offset + 1] == null ? NaN : 100 - packed[offset + 1], 3)
      : series === 1
        ? round((100 * packed[offset + 5]) / (packed[offset + 5] + packed[offset + 6]), 2)
        : packed[offset + 3];
  };
  return createPreparedData(mode, 3, pointCount, start, 60, valueAt);
}

function createSynthetic(mode: BenchmarkMode, seriesCount: number, pointCount: number, seriesShift: number) {
  const valueAt = (series: number, index: number) => {
    const a = 2 * pseudoRandom(series, Math.floor(index / 100), 1);
    const b = 2 * pseudoRandom(series, Math.floor(index / 1_000), 2);
    const c = 2 * pseudoRandom(series, Math.floor(index / 10_000), 3);
    const spike = index % 50_000 === 0 ? 10 : 0;
    return series * seriesShift + 2 * Math.sin(index / 100) + a + b + c + spike + pseudoRandom(series, index, 4);
  };
  return createPreparedData(mode, seriesCount, pointCount, 0, 1, valueAt);
}

function createPreparedData(
  mode: BenchmarkMode,
  seriesCount: number,
  pointCount: number,
  start: number,
  step: number,
  valueAt: (series: number, index: number) => number
) {
  if (mode === 'legacy') {
    const data: uPlot.AlignedData = [new Array<number>(pointCount)];
    for (let index = 0; index < pointCount; index++) {
      data[0][index] = start + step * index;
    }
    for (let series = 0; series < seriesCount; series++) {
      const values = new Array<number>(pointCount);
      for (let index = 0; index < pointCount; index++) {
        values[index] = valueAt(series, index);
      }
      data.push(values);
    }
    return { pointCount, seriesCount, data };
  }

  const values = new Float64Array(seriesCount * pointCount);
  for (let series = 0; series < seriesCount; series++) {
    const offset = series * pointCount;
    for (let index = 0; index < pointCount; index++) {
      values[offset + index] = valueAt(series, index);
    }
  }
  const styleIds = createIndexColumn(seriesCount, colors.length);
  const styles: CompactStyleRecord[] = colors.map((stroke) => ({ stroke, lineWidth: 1 / devicePixelRatio }));
  const source: CompactRenderSource = {
    kind: 'compact-v1',
    buffer: values.buffer,
    pointCount,
    seriesCount,
    columns: {
      styleIds,
      scaleIds: new Uint8Array(seriesCount),
      flags: new Uint8Array(seriesCount).fill(CompactSeriesFlag.DrawLine),
      visibility: new Uint8Array(seriesCount).fill(1),
    },
    styles,
    scales: [{ key: 'y' }],
    stackGroupCount: 0,
    cursorMode: 'none',
    focusAlpha: 1,
    visibilityState: { overrides: new Map() },
    xAt: (index) => start + step * index,
    closestXIndex: (value, from, to) => Math.max(from, Math.min(to, Math.round((value - start) / Math.max(1, step)))),
    yAt: (series, index) => values[series * pointCount + index],
    scan: (series, from, to, visitor) => {
      const offset = series * pointCount;
      for (let index = from; index <= to; index++) {
        visitor(index, values[offset + index]);
      }
    },
    prepareBufferScan: (series, from, target) => {
      target.axisStart = start;
      target.axisStep = step;
      target.valuesByteOffset = series * pointCount * Float64Array.BYTES_PER_ELEMENT;
      target.presenceByteOffset = 0;
      target.presenceByteLength = 0;
      target.packedIndex = from;
      target.valueMultiplier = 1;
      target.missingValue = null;
      return true;
    },
    extent: (series, from, to, mode = 'all') => {
      const offset = series * pointCount;
      let min: number | null = null;
      let max: number | null = null;
      for (let index = from; index <= to; index++) {
        const value = values[offset + index];
        if (!Number.isFinite(value) || (mode === 'positive' && value <= 0)) {
          continue;
        }
        min = min == null ? value : Math.min(min, value);
        max = max == null ? value : Math.max(max, value);
      }
      return [min, max];
    },
    nearestPresent: (_series, index) => index,
  };
  return { pointCount, seriesCount, source };
}

function createOptions(benchmark: PreparedBenchmark, onDraw: () => void): uPlot.Options {
  const width = 1_920;
  const height =
    benchmark.config.fixture === '600-series' ? 800 : benchmark.config.fixture === 'server-events' ? 600 : 400;
  const series =
    benchmark.config.mode === 'compact'
      ? [{}]
      : [
          {},
          ...Array.from({ length: benchmark.seriesCount }, (_, index) => ({
            label: String(index + 1),
            scale: 'y',
            stroke: colors[index % colors.length],
            width: 1 / devicePixelRatio,
            points: { show: false },
          })),
        ];
  return {
    width,
    height,
    series,
    scales: { x: { time: false }, y: { auto: true } },
    axes: [{ scale: 'x' }, { scale: 'y' }],
    legend: { show: false },
    cursor: { show: false },
    focus: { alpha: 1 },
    hooks: { draw: [onDraw] },
  };
}

function nextDraw(): Promise<number> {
  if (drawWaiter) {
    throw new Error('A benchmark draw is already pending');
  }
  return new Promise((resolve) => {
    drawWaiter = resolve;
  });
}

function nextAnimationFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now())));
}

function destroy() {
  countCanvasCalls = false;
  drawWaiter = undefined;
  plot?.destroy();
  plot = undefined;
  target?.remove();
  target = undefined;
  prepared = undefined;
}

function describePrepared(value: PreparedBenchmark) {
  return {
    fixture: value.config.fixture,
    mode: value.config.mode,
    pointCount: value.pointCount,
    seriesCount: value.seriesCount,
    sampleCount: value.pointCount * value.seriesCount,
    prepMs: value.prepMs,
    responseBytes: value.source?.buffer.byteLength,
  };
}

function createIndexColumn(length: number, modulo: number): Uint8Array | Uint16Array | Uint32Array {
  const column =
    modulo <= 0x100 ? new Uint8Array(length) : modulo <= 0x10000 ? new Uint16Array(length) : new Uint32Array(length);
  for (let index = 0; index < length; index++) {
    column[index] = index % modulo;
  }
  return column;
}

function pseudoRandom(series: number, index: number, salt: number): number {
  const value = Math.sin(series * 12.9898 + index * 78.233 + salt * 37.719) * 43_758.5453;
  return value - Math.floor(value);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

declare global {
  interface Window {
    __uplotUpstreamBenchmark: {
      prepare(config: BenchmarkConfig): ReturnType<typeof describePrepared>;
      render(): Promise<Record<string, unknown>>;
      redraw(): Promise<Record<string, unknown>>;
      zoom(): Promise<Record<string, unknown>>;
      destroy(): void;
    };
  }
}
