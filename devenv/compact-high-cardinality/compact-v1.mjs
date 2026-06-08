const encoder = new TextEncoder();

class BinaryWriter {
  constructor(buffer) {
    this.buffer = buffer;
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.offset = 0;
  }

  writeAscii(value) {
    this.writeBytes(encoder.encode(value));
  }

  writeBytes(value) {
    this.bytes.set(value, this.offset);
    this.offset += value.byteLength;
  }

  writeUint8(value) {
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  writeUint16(value) {
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  writeUint32(value) {
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }

  writeInt32(value) {
    this.view.setInt32(this.offset, value, true);
    this.offset += 4;
  }

  writeUint64(value) {
    this.view.setBigUint64(this.offset, BigInt(value), true);
    this.offset += 8;
  }

  writeInt64(value) {
    this.view.setBigInt64(this.offset, BigInt(value), true);
    this.offset += 8;
  }

  writeFloat64(value) {
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  align8() {
    this.offset = align8(this.offset);
  }
}

export function buildCompactResponse({
  refIds,
  seriesPerQuery,
  pointCount,
  from,
  to,
  gappedSeriesEvery,
  gapEvery,
  seed,
}) {
  if (refIds.length === 0 || new Set(refIds).size !== refIds.length) {
    throw new Error('Compact fixture requires unique query refIds');
  }

  const totalSeries = refIds.length * seriesPerQuery;
  const groupCount = Math.min(64, Math.max(1, seriesPerQuery));
  const stringValues = ['', ...refIds, 'Value', 'group', 'series'];
  const refIdStringIds = new Map(refIds.map((refId, index) => [refId, index + 1]));
  const valueNameStringId = refIds.length + 1;
  const groupLabelStringId = refIds.length + 2;
  const seriesLabelStringId = refIds.length + 3;
  const firstGroupStringId = stringValues.length;

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    stringValues.push(`group-${String(groupIndex).padStart(2, '0')}`);
  }
  const firstSeriesStringId = stringValues.length;
  for (let seriesIndex = 0; seriesIndex < totalSeries; seriesIndex++) {
    stringValues.push(`series-${String(seriesIndex).padStart(7, '0')}`);
  }

  const encodedStrings = stringValues.map((value) => encoder.encode(value));
  const stringBytesLength = encodedStrings.reduce((total, value) => total + value.byteLength, 0);
  const stringSectionLength = align8(encodedStrings.length * 8 + stringBytesLength);
  const resultRecordLengths = calculateResultRecordLengths(
    refIds.length,
    seriesPerQuery,
    pointCount,
    gappedSeriesEvery,
    gapEvery
  );
  const totalLength =
    32 + 24 + stringSectionLength + resultRecordLengths.reduce((total, recordLength) => total + recordLength, 0);

  if (totalLength > 0xffffffff) {
    throw new Error(`Compact fixture exceeds the v1 record limit: ${totalLength} bytes`);
  }

  const buffer = new ArrayBuffer(totalLength);
  const writer = new BinaryWriter(buffer);
  writer.writeAscii('GQD1');
  writer.writeUint16(1);
  writer.writeUint16(0);
  writer.writeUint32(1);
  writer.writeUint32(refIds.length);
  writer.writeUint32(encodedStrings.length);
  writer.writeUint32(stringBytesLength);
  writer.writeUint64(0);

  const safeFrom = Number.isSafeInteger(from) ? from : Date.now() - pointCount * 60_000;
  const safeTo = Number.isSafeInteger(to) && to > safeFrom ? to : safeFrom + Math.max(1, pointCount - 1) * 60_000;
  const step = pointCount === 1 ? 60_000 : Math.max(1, Math.floor((safeTo - safeFrom) / (pointCount - 1)));
  writer.writeInt64(safeFrom);
  writer.writeUint64(step);
  writer.writeUint32(pointCount);
  writer.writeUint32(0);

  let stringOffset = 0;
  for (const value of encodedStrings) {
    writer.writeUint32(stringOffset);
    writer.writeUint32(value.byteLength);
    stringOffset += value.byteLength;
  }
  for (const value of encodedStrings) {
    writer.writeBytes(value);
  }
  writer.align8();

  let globalSeriesIndex = 0;
  for (let resultIndex = 0; resultIndex < refIds.length; resultIndex++) {
    const refId = refIds[resultIndex];
    const resultRecordLength = resultRecordLengths[resultIndex];
    const resultStart = writer.offset;
    writer.writeUint32(resultRecordLength);
    writer.writeUint32(refIdStringIds.get(refId));
    writer.writeUint32(0);
    writer.writeUint32(0);
    writer.writeInt32(200);
    writer.writeUint32(seriesPerQuery);
    writer.writeInt64(0);
    writer.writeUint16(1);
    writer.writeUint16(1);
    writer.writeUint16(0);
    writer.writeUint16(1);
    writer.writeUint32(0);
    writer.writeUint32(0);

    for (let localSeriesIndex = 0; localSeriesIndex < seriesPerQuery; localSeriesIndex++, globalSeriesIndex++) {
      const gapped = isGappedSeries(globalSeriesIndex, gappedSeriesEvery);
      const gapCount = gapped ? countGaps(pointCount, globalSeriesIndex, gapEvery) : 0;
      const presentCount = pointCount - gapCount;
      const bitmapLength = gapped ? Math.ceil(pointCount / 8) : 0;
      const frameLength = align8(48 + 16 + bitmapLength) + presentCount * 8;

      writer.writeUint32(frameLength);
      writer.writeUint32(0);
      writer.writeUint32(presentCount);
      writer.writeUint32(bitmapLength);
      writer.writeUint32(0);
      writer.writeUint32(refIdStringIds.get(refId));
      writer.writeUint32(valueNameStringId);
      writer.writeUint32(0);
      writer.writeUint32(2);
      writer.writeUint32(0);
      writer.writeUint64(0);
      writer.writeUint32(groupLabelStringId);
      writer.writeUint32(firstGroupStringId + (globalSeriesIndex % groupCount));
      writer.writeUint32(seriesLabelStringId);
      writer.writeUint32(firstSeriesStringId + globalSeriesIndex);

      if (gapped) {
        writePresenceBitmap(writer, pointCount, globalSeriesIndex, gapEvery);
      }
      writer.align8();
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        if (gapped && isGap(pointIndex, globalSeriesIndex, gapEvery)) {
          continue;
        }
        writer.writeFloat64(valueAt(resultIndex, globalSeriesIndex, pointIndex, seed));
      }
    }

    if (writer.offset - resultStart !== resultRecordLength) {
      throw new Error('Compact fixture result length mismatch');
    }
  }

  if (writer.offset !== buffer.byteLength) {
    throw new Error(`Compact fixture length mismatch: wrote ${writer.offset} of ${buffer.byteLength}`);
  }
  return buffer;
}

export function buildCompactResponseFromGrafanaJson(response, requestedRefIds) {
  const model = normalizeGrafanaResponse(response, requestedRefIds);
  const strings = [''];
  const stringIds = new Map([['', 0]]);
  const intern = (value) => {
    const normalized = value == null ? '' : String(value);
    let id = stringIds.get(normalized);
    if (id == null) {
      id = strings.length;
      strings.push(normalized);
      stringIds.set(normalized, id);
    }
    return id;
  };

  for (const result of model.results) {
    intern(result.refId);
    intern(result.error);
    intern(result.executedQueryString);
    for (const frame of result.frames) {
      intern(frame.frameName);
      intern(frame.refId);
      intern(frame.valueName);
      intern(frame.displayNameFromDS);
      for (const [name, value] of frame.labels) {
        intern(name);
        intern(value);
      }
    }
  }

  const encodedStrings = strings.map((value) => encoder.encode(value));
  const stringBytesLength = encodedStrings.reduce((total, value) => total + value.byteLength, 0);
  const stringSectionLength = align8(encodedStrings.length * 8 + stringBytesLength);
  const resultRecordLengths = model.results.map(
    (result) => 48 + result.frames.reduce((total, frame) => total + frame.recordLength, 0)
  );
  const totalLength =
    32 +
    model.axes.length * 24 +
    stringSectionLength +
    resultRecordLengths.reduce((total, length) => total + length, 0);
  if (totalLength > 0xffffffff) {
    throw new Error(`Captured compact fixture exceeds the v1 record limit: ${totalLength} bytes`);
  }

  const buffer = new ArrayBuffer(totalLength);
  const writer = new BinaryWriter(buffer);
  writer.writeAscii('GQD1');
  writer.writeUint16(1);
  writer.writeUint16(0);
  writer.writeUint32(model.axes.length);
  writer.writeUint32(model.results.length);
  writer.writeUint32(encodedStrings.length);
  writer.writeUint32(stringBytesLength);
  writer.writeUint64(0);

  for (const axis of model.axes) {
    writer.writeInt64(axis.start);
    writer.writeUint64(axis.step);
    writer.writeUint32(axis.count);
    writer.writeUint32(0);
  }

  let stringOffset = 0;
  for (const value of encodedStrings) {
    writer.writeUint32(stringOffset);
    writer.writeUint32(value.byteLength);
    stringOffset += value.byteLength;
  }
  for (const value of encodedStrings) {
    writer.writeBytes(value);
  }
  writer.align8();

  for (let resultIndex = 0; resultIndex < model.results.length; resultIndex++) {
    const result = model.results[resultIndex];
    const resultStart = writer.offset;
    writer.writeUint32(resultRecordLengths[resultIndex]);
    writer.writeUint32(intern(result.refId));
    writer.writeUint32(intern(result.error));
    writer.writeUint32(intern(result.executedQueryString));
    writer.writeInt32(result.status);
    writer.writeUint32(result.frames.length);
    writer.writeInt64(result.calculatedMinStep);
    writer.writeUint16(result.frames.length > 0 ? 1 : 0);
    writer.writeUint16(result.frames.length > 0 ? 1 : 0);
    writer.writeUint16(0);
    writer.writeUint16(result.frames.length > 0 ? 1 : 0);
    writer.writeUint32(result.calculatedMinStep === 0 ? 0 : 1);
    writer.writeUint32(0);

    for (const frame of result.frames) {
      writer.writeUint32(frame.recordLength);
      writer.writeUint32(frame.axisId);
      writer.writeUint32(frame.presentValues.length);
      writer.writeUint32(frame.presence?.byteLength ?? 0);
      writer.writeUint32(intern(frame.frameName));
      writer.writeUint32(intern(frame.refId));
      writer.writeUint32(intern(frame.valueName));
      writer.writeUint32(intern(frame.displayNameFromDS));
      writer.writeUint32(frame.labels.length);
      writer.writeUint32(0);
      writer.writeUint64(0);
      for (const [name, value] of frame.labels) {
        writer.writeUint32(intern(name));
        writer.writeUint32(intern(value));
      }
      if (frame.presence) {
        writer.writeBytes(frame.presence);
      }
      writer.align8();
      for (const value of frame.presentValues) {
        writer.writeFloat64(value);
      }
    }

    if (writer.offset - resultStart !== resultRecordLengths[resultIndex]) {
      throw new Error('Captured compact fixture result length mismatch');
    }
  }

  if (writer.offset !== buffer.byteLength) {
    throw new Error(`Captured compact fixture length mismatch: wrote ${writer.offset} of ${buffer.byteLength}`);
  }
  return buffer;
}

export function summarizeGrafanaJsonResponse(response, requestedRefIds) {
  const model = normalizeGrafanaResponse(response, requestedRefIds);
  const axes = model.axes.filter((axis) => axis.count > 0);
  return {
    refIds: model.results.map((result) => result.refId),
    seriesCount: model.results.reduce((total, result) => total + result.frames.length, 0),
    pointCount: axes.reduce((maximum, axis) => Math.max(maximum, axis.count), 0),
    from: axes.length === 0 ? null : axes.reduce((minimum, axis) => Math.min(minimum, axis.start), axes[0].start),
    to:
      axes.length === 0
        ? null
        : axes.reduce(
            (maximum, axis) => Math.max(maximum, axis.start + axis.step * Math.max(0, axis.count - 1)),
            axes[0].start
          ),
  };
}

function normalizeGrafanaResponse(response, requestedRefIds) {
  if (!response || typeof response !== 'object' || !response.results || typeof response.results !== 'object') {
    throw new Error('Captured response must contain a Grafana results object');
  }
  const refIds = requestedRefIds ?? Object.keys(response.results);
  if (refIds.length === 0 || new Set(refIds).size !== refIds.length) {
    throw new Error('Captured response requires unique query refIds');
  }

  const axes = [];
  const axisIds = new Map();
  const results = refIds.map((refId) => {
    const result = response.results[refId];
    if (!result) {
      throw new Error(`Captured response does not contain query result ${refId}`);
    }
    const frames = (result.frames ?? []).map((frame) => normalizeGrafanaFrame(frame, refId, axes, axisIds));
    const firstMeta = frames.length > 0 ? result.frames[0]?.schema?.meta : undefined;
    const calculatedMinStep = firstMeta?.custom?.calculatedMinStep ?? 0;
    if (!Number.isSafeInteger(calculatedMinStep) || calculatedMinStep < 0) {
      throw new Error(`Captured response ${refId} has an invalid calculatedMinStep`);
    }
    return {
      refId,
      status: Number.isInteger(result.status) ? result.status : 200,
      error: typeof result.error === 'string' ? result.error : '',
      executedQueryString: typeof firstMeta?.executedQueryString === 'string' ? firstMeta.executedQueryString : '',
      calculatedMinStep,
      frames,
    };
  });
  return { axes, results };
}

function normalizeGrafanaFrame(frame, resultRefId, axes, axisIds) {
  const fields = frame?.schema?.fields;
  const values = frame?.data?.values;
  if (!Array.isArray(fields) || !Array.isArray(values)) {
    throw new Error(`Captured response ${resultRefId} contains a frame without schema fields or data values`);
  }
  const timeIndex = fields.findIndex((field) => field.type === 'time');
  const valueIndex = fields.findIndex((field) => field.type === 'number');
  if (timeIndex < 0 || valueIndex < 0 || !Array.isArray(values[timeIndex]) || !Array.isArray(values[valueIndex])) {
    throw new Error(`Captured response ${resultRefId} requires one time field and one numeric field`);
  }
  const timestamps = values[timeIndex];
  const rawValues = values[valueIndex];
  if (timestamps.length !== rawValues.length || timestamps.length === 0) {
    throw new Error(`Captured response ${resultRefId} has mismatched or empty time-series columns`);
  }

  const fallbackStep = fields[timeIndex].config?.interval ?? frame.schema.meta?.custom?.calculatedMinStep;
  const axis = regularAxis(timestamps, fallbackStep, resultRefId);
  const axisKey = `${axis.start}/${axis.step}/${axis.count}`;
  let axisId = axisIds.get(axisKey);
  if (axisId == null) {
    axisId = axes.length;
    axes.push(axis);
    axisIds.set(axisKey, axisId);
  }

  const presence = rawValues.some((value) => value == null)
    ? new Uint8Array(Math.ceil(rawValues.length / 8))
    : undefined;
  const presentValues = [];
  for (let index = 0; index < rawValues.length; index++) {
    const value = rawValues[index];
    if (value == null) {
      continue;
    }
    if (typeof value !== 'number') {
      throw new Error(`Captured response ${resultRefId} contains a non-numeric sample`);
    }
    if (presence) {
      presence[index >> 3] |= 1 << (index & 7);
    }
    presentValues.push(value);
  }

  const valueField = fields[valueIndex];
  const labels = Object.entries(valueField.labels ?? {})
    .map(([name, value]) => [name, String(value)])
    .sort(([left], [right]) => compareUtf8(left, right));
  const bitmapLength = presence?.byteLength ?? 0;
  return {
    axisId,
    frameName: frame.schema.name ?? '',
    refId: frame.schema.refId ?? resultRefId,
    valueName: valueField.name ?? 'Value',
    displayNameFromDS: valueField.config?.displayNameFromDS ?? '',
    labels,
    presence,
    presentValues,
    recordLength: align8(48 + labels.length * 8 + bitmapLength) + presentValues.length * 8,
  };
}

function regularAxis(timestamps, fallbackStep, refId) {
  for (const timestamp of timestamps) {
    if (!Number.isSafeInteger(timestamp)) {
      throw new Error(`Captured response ${refId} contains an invalid timestamp`);
    }
  }
  const step = timestamps.length === 1 ? (fallbackStep ?? 1) : timestamps[1] - timestamps[0];
  if (!Number.isSafeInteger(step) || step <= 0) {
    throw new Error(`Captured response ${refId} has a non-positive timestamp step`);
  }
  for (let index = 1; index < timestamps.length; index++) {
    if (timestamps[index] !== timestamps[0] + step * index) {
      throw new Error(`Captured response ${refId} does not use a regular timestamp axis`);
    }
  }
  return { start: timestamps[0], step, count: timestamps.length };
}

function compareUtf8(left, right) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return leftBytes.length - rightBytes.length;
}

function calculateResultRecordLengths(refCount, seriesPerQuery, pointCount, gappedSeriesEvery, gapEvery) {
  const resultRecordLengths = [];
  for (let resultIndex = 0; resultIndex < refCount; resultIndex++) {
    let recordLength = 48;
    const firstSeriesIndex = resultIndex * seriesPerQuery;
    for (let localSeriesIndex = 0; localSeriesIndex < seriesPerQuery; localSeriesIndex++) {
      const seriesIndex = firstSeriesIndex + localSeriesIndex;
      const gapped = isGappedSeries(seriesIndex, gappedSeriesEvery);
      const presentCount = pointCount - (gapped ? countGaps(pointCount, seriesIndex, gapEvery) : 0);
      const bitmapLength = gapped ? Math.ceil(pointCount / 8) : 0;
      recordLength += align8(48 + 16 + bitmapLength) + presentCount * 8;
    }
    resultRecordLengths.push(recordLength);
  }
  return resultRecordLengths;
}

function writePresenceBitmap(writer, pointCount, seriesIndex, gapEvery) {
  const bitmapLength = Math.ceil(pointCount / 8);
  for (let byteIndex = 0; byteIndex < bitmapLength; byteIndex++) {
    let value = 0;
    for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
      const pointIndex = byteIndex * 8 + bitIndex;
      if (pointIndex < pointCount && !isGap(pointIndex, seriesIndex, gapEvery)) {
        value |= 1 << bitIndex;
      }
    }
    writer.writeUint8(value);
  }
}

function isGappedSeries(seriesIndex, gappedSeriesEvery) {
  return gappedSeriesEvery > 0 && seriesIndex % gappedSeriesEvery === 0;
}

function isGap(pointIndex, seriesIndex, gapEvery) {
  return (pointIndex + seriesIndex) % gapEvery === 0;
}

function countGaps(pointCount, seriesIndex, gapEvery) {
  const firstGap = (gapEvery - (seriesIndex % gapEvery)) % gapEvery;
  return firstGap >= pointCount ? 0 : Math.floor((pointCount - 1 - firstGap) / gapEvery) + 1;
}

function valueAt(resultIndex, seriesIndex, pointIndex, seed) {
  const seededSeries = seriesIndex + seed * 97;
  if ((seededSeries + pointIndex) % 251 === 0) {
    return 0;
  }
  if ((seededSeries * 17 + pointIndex) % 4093 === 0) {
    return 1_000_000;
  }
  return 50 + resultIndex * 10 + Math.sin((seededSeries * 3 + pointIndex) / 19) * 25;
}

function align8(value) {
  return Math.ceil(value / 8) * 8;
}
