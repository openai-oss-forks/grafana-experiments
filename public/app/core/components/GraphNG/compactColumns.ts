export type CompactIndexColumn = Uint8Array | Uint16Array | Uint32Array;

/** Builds the narrowest index column that can represent every assigned ID. */
export class CompactIndexColumnBuilder {
  private values: CompactIndexColumn;

  constructor(length: number) {
    this.values = new Uint8Array(length);
  }

  set(index: number, value: number): void {
    if (value > 0xffff && !(this.values instanceof Uint32Array)) {
      this.values = Uint32Array.from(this.values);
    } else if (value > 0xff && this.values instanceof Uint8Array) {
      this.values = Uint16Array.from(this.values);
    }
    this.values[index] = value;
  }

  finish(): CompactIndexColumn {
    return this.values;
  }
}
