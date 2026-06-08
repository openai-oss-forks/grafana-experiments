import { CompactIndexColumnBuilder } from './compactColumns';

describe('CompactIndexColumnBuilder', () => {
  test.each([
    { value: 0xff, type: Uint8Array },
    { value: 0x100, type: Uint16Array },
    { value: 0x10000, type: Uint32Array },
  ])('uses the narrowest column for ID $value', ({ value, type }) => {
    const column = new CompactIndexColumnBuilder(1);
    column.set(0, value);
    const result = column.finish();

    expect(result).toBeInstanceOf(type);
    expect(result[0]).toBe(value);
  });
});
