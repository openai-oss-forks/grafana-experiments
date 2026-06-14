#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const FRAME_HEADER_SIZE = 12;
const FINAL_BATCH_FLAG = 1;
const RESPONSE_HEADER_MAGIC = 'MBRH';
const BATCH_FRAME_MAGIC = 'MBBF';

function usage() {
  console.error(`Usage: node scripts/measure-multibatch-timing.mjs --url URL [--method POST] [--body BODY_OR_@FILE] [--header 'Name: value']...

The script reads the response incrementally and prints timestamps for:
  response first byte, multibatch header, each batch header, each batch last byte.
It exits non-zero if the first batch last byte is not observed before the final batch header.`);
}

function parseArgs(argv) {
  const args = { headers: {}, method: 'GET' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--url') {
      args.url = value;
      i++;
    } else if (arg === '--method') {
      args.method = value.toUpperCase();
      i++;
    } else if (arg === '--body') {
      args.body = value?.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value;
      i++;
    } else if (arg === '--header') {
      const separator = value.indexOf(':');
      if (separator < 0) {
        throw new Error(`Invalid header: ${value}`);
      }
      args.headers[value.slice(0, separator).trim()] = value.slice(separator + 1).trim();
      i++;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.url) {
    throw new Error('Missing --url');
  }
  return args;
}

class FrameParser {
  constructor(startTime) {
    this.buffer = new Uint8Array(0);
    this.startTime = startTime;
    this.sawResponseHeader = false;
    this.firstBatchLastByteMs = undefined;
    this.finalBatchHeaderMs = undefined;
    this.batchIndex = 0;
    this.currentBatch = undefined;
  }

  push(chunk) {
    this.buffer = concatBytes(this.buffer, chunk);
    while (this.buffer.byteLength > 0) {
      if (this.currentBatch !== undefined) {
        const consumed = Math.min(this.buffer.byteLength, this.currentBatch.remaining);
        this.currentBatch.remaining -= consumed;
        this.buffer = this.buffer.subarray(consumed);
        if (this.currentBatch.remaining === 0) {
          this.log(`batch ${this.currentBatch.index} last byte received`);
          if (this.currentBatch.index === 1) {
            this.firstBatchLastByteMs = this.elapsedMs();
          }
          this.currentBatch = undefined;
        }
        continue;
      }

      if (this.buffer.byteLength < FRAME_HEADER_SIZE) {
        return;
      }

      const header = this.buffer.subarray(0, FRAME_HEADER_SIZE);
      const magic = ascii(header.subarray(0, 4));
      if (magic === RESPONSE_HEADER_MAGIC) {
        this.requireVersion(header, 'response');
        this.sawResponseHeader = true;
        this.log('multibatch response header complete');
        this.buffer = this.buffer.subarray(FRAME_HEADER_SIZE);
        continue;
      }
      if (magic !== BATCH_FRAME_MAGIC) {
        throw new Error(`Invalid frame magic ${magic}`);
      }
      this.requireVersion(header, 'batch');
      if (!this.sawResponseHeader) {
        throw new Error('Batch arrived before multibatch response header');
      }
      const payloadLength = new DataView(header.buffer, header.byteOffset + 8, 4).getUint32(0, false);
      const isFinal = (header[6] & FINAL_BATCH_FLAG) !== 0;
      this.batchIndex += 1;
      if (isFinal && this.finalBatchHeaderMs === undefined) {
        this.finalBatchHeaderMs = this.elapsedMs();
      }
      this.log(
        `batch ${this.batchIndex} header complete type=${header[5]} flags=${header[6]} encoding=${header[7]} payload=${payloadLength}`
      );
      this.buffer = this.buffer.subarray(FRAME_HEADER_SIZE);
      this.currentBatch = { index: this.batchIndex, remaining: payloadLength };
    }
  }

  finish() {
    if (this.buffer.byteLength > 0) {
      throw new Error(`Response ended with ${this.buffer.byteLength} buffered bytes`);
    }
    if (this.currentBatch !== undefined) {
      throw new Error(`Response ended with ${this.currentBatch.remaining} bytes missing from batch ${this.currentBatch.index}`);
    }
    if (this.firstBatchLastByteMs === undefined) {
      throw new Error('No first batch was received');
    }
    if (this.finalBatchHeaderMs === undefined) {
      throw new Error('No final batch was received');
    }
    if (this.firstBatchLastByteMs >= this.finalBatchHeaderMs) {
      throw new Error(
        `First batch last byte (${this.firstBatchLastByteMs.toFixed(1)}ms) was not before final header (${this.finalBatchHeaderMs.toFixed(1)}ms)`
      );
    }
    console.log(
      `PASS first batch completed ${(this.finalBatchHeaderMs - this.firstBatchLastByteMs).toFixed(1)}ms before final header`
    );
  }

  requireVersion(header, kind) {
    if (header[4] !== 1) {
      throw new Error(`Unsupported ${kind} frame version ${header[4]}`);
    }
  }

  elapsedMs() {
    return performance.now() - this.startTime;
  }

  log(message) {
    console.log(`${this.elapsedMs().toFixed(1)}ms ${message}`);
  }
}

function ascii(bytes) {
  return String.fromCharCode(...bytes);
}

function concatBytes(a, b) {
  if (a.byteLength === 0) {
    const copy = new Uint8Array(b.byteLength);
    copy.set(b);
    return copy;
  }
  const copy = new Uint8Array(a.byteLength + b.byteLength);
  copy.set(a);
  copy.set(b, a.byteLength);
  return copy;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const start = performance.now();
  const response = await fetch(args.url, {
    body: args.body,
    headers: args.headers,
    method: args.method,
  });
  console.log(`status=${response.status} content-type=${response.headers.get('content-type') ?? ''}`);
  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }
  if (!response.body) {
    throw new Error('Response has no readable body');
  }
  const parser = new FrameParser(start);
  const reader = response.body.getReader();
  let sawFirstChunk = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!sawFirstChunk) {
      sawFirstChunk = true;
      console.log(`${(performance.now() - start).toFixed(1)}ms first response body bytes received`);
    }
    parser.push(value);
  }
  parser.finish();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
});
