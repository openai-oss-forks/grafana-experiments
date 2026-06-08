import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCompactResponse, buildCompactResponseFromGrafanaJson } from './compact-v1.mjs';
import { buildJsonResponse } from './json-response.mjs';

const decoder = new TextDecoder();

test('dashboard fixture JSON and compact responses contain identical series data and metadata', () => {
  const options = {
    refIds: ['A', 'B'],
    queries: [
      {
        refId: 'A',
        expr: 'sum(rate(requests_total[5m])) by (region, service)',
        legendFormat: 'success - {{region}} {{service}}',
      },
      {
        refId: 'B',
        expr: 'sum(rate(requests_total[5m])) by (cluster)',
        legendFormat: '',
      },
    ],
    seriesPerQuery: 3,
    pointCount: 2500,
    from: 1_700_000_000_000,
    to: 1_700_149_940_000,
    gappedSeriesEvery: 2,
    gapEvery: 17,
    seed: 1,
  };
  const json = JSON.parse(buildJsonResponse(options));
  const compact = decodeCompact(buildCompactResponseFromGrafanaJson(json, options.refIds));

  assert.deepEqual(compact, normalizeJson(json, options.refIds));
  const frames = options.refIds.flatMap((refId) => compact.results[refId].frames);
  assert.ok(frames.some((frame) => frame.values.includes(null)));
  assert.ok(frames.some((frame) => frame.values.includes(0)));
  assert.ok(frames.some((frame) => frame.values.includes(1_000_000)));
  assert.equal(compact.results.A.frames[1].displayNameFromDS, 'success - region-0001 service-0001');
  assert.equal(compact.results.B.frames[0].displayNameFromDS, '{cluster="cluster-0003"}');
});

test('standalone compact stress fixtures expose concise series names', () => {
  const compact = decodeCompact(
    buildCompactResponse({
      refIds: ['A'],
      seriesPerQuery: 2,
      pointCount: 3,
      from: 1_700_000_000_000,
      to: 1_700_000_120_000,
      gappedSeriesEvery: 0,
      gapEvery: 17,
      seed: 1,
    })
  );

  assert.equal(compact.results.A.frames[0].displayNameFromDS, 'series-0000000');
  assert.equal(compact.results.A.frames[1].displayNameFromDS, 'series-0000001');
});

function normalizeJson(response, refIds) {
  const axes = [];
  const axisIds = new Map();
  const results = {};
  for (const refId of refIds) {
    results[refId] = {
      status: response.results[refId].status,
      frames: response.results[refId].frames.map((frame) => {
        const timeFieldIndex = frame.schema.fields.findIndex((field) => field.type === 'time');
        const valueFieldIndex = frame.schema.fields.findIndex((field) => field.type === 'number');
        const timestamps = frame.data.values[timeFieldIndex];
        const step = timestamps.length === 1 ? 1 : timestamps[1] - timestamps[0];
        const axisKey = `${timestamps[0]}/${step}/${timestamps.length}`;
        let axisId = axisIds.get(axisKey);
        if (axisId == null) {
          axisId = axes.length;
          axes.push({ start: timestamps[0], step, count: timestamps.length });
          axisIds.set(axisKey, axisId);
        }
        const valueField = frame.schema.fields[valueFieldIndex];
        return {
          axisId,
          refId: frame.schema.refId,
          valueName: valueField.name,
          displayNameFromDS: valueField.config?.displayNameFromDS,
          labels: valueField.labels,
          values: frame.data.values[valueFieldIndex],
        };
      }),
    };
  }
  return { axes, results };
}

function decodeCompact(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  assert.equal(decoder.decode(bytes.subarray(0, 4)), 'GQD1');
  assert.equal(view.getUint16(4, true), 1);
  const axisCount = view.getUint32(8, true);
  const resultCount = view.getUint32(12, true);
  const stringCount = view.getUint32(16, true);
  const stringBytesLength = view.getUint32(20, true);
  let offset = 32;
  const axes = [];
  for (let index = 0; index < axisCount; index++) {
    axes.push({
      start: Number(view.getBigInt64(offset, true)),
      step: Number(view.getBigUint64(offset + 8, true)),
      count: view.getUint32(offset + 16, true),
    });
    offset += 24;
  }

  const stringRecordsOffset = offset;
  const stringBytesOffset = stringRecordsOffset + stringCount * 8;
  const strings = Array.from({ length: stringCount }, (_, index) => {
    const recordOffset = stringRecordsOffset + index * 8;
    const start = view.getUint32(recordOffset, true);
    const length = view.getUint32(recordOffset + 4, true);
    return decoder.decode(bytes.subarray(stringBytesOffset + start, stringBytesOffset + start + length));
  });
  offset = align8(stringBytesOffset + stringBytesLength);

  const results = {};
  for (let resultIndex = 0; resultIndex < resultCount; resultIndex++) {
    const resultStart = offset;
    const recordLength = view.getUint32(offset, true);
    const refId = strings[view.getUint32(offset + 4, true)];
    const status = view.getInt32(offset + 16, true);
    const frameCount = view.getUint32(offset + 20, true);
    offset += 48;
    const frames = [];
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const frameStart = offset;
      const frameLength = view.getUint32(offset, true);
      const axisId = view.getUint32(offset + 4, true);
      const presentCount = view.getUint32(offset + 8, true);
      const bitmapLength = view.getUint32(offset + 12, true);
      const frameRefId = strings[view.getUint32(offset + 20, true)];
      const valueName = strings[view.getUint32(offset + 24, true)];
      const displayNameFromDS = strings[view.getUint32(offset + 28, true)] || undefined;
      const labelCount = view.getUint32(offset + 32, true);
      offset += 48;
      const labels = {};
      for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
        labels[strings[view.getUint32(offset, true)]] = strings[view.getUint32(offset + 4, true)];
        offset += 8;
      }
      const presence = bitmapLength > 0 ? bytes.subarray(offset, offset + bitmapLength) : undefined;
      offset = align8(offset + bitmapLength);
      const presentValues = new Float64Array(buffer, offset, presentCount);
      const values = new Array(axes[axisId].count);
      let presentIndex = 0;
      for (let index = 0; index < values.length; index++) {
        const present = !presence || (presence[index >> 3] & (1 << (index & 7))) !== 0;
        values[index] = present ? presentValues[presentIndex++] : null;
      }
      frames.push({ axisId, refId: frameRefId, valueName, displayNameFromDS, labels, values });
      offset = frameStart + frameLength;
    }
    assert.equal(offset, resultStart + recordLength);
    results[refId] = { status, frames };
  }
  assert.equal(offset, buffer.byteLength);
  return { axes, results };
}

function align8(value) {
  return Math.ceil(value / 8) * 8;
}
