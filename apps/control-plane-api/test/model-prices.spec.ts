/** Cost arithmetic for per-model prices (ADR 0022): exact, and never in the organization's favour. */
import { describe, expect, it } from 'vitest';
import { costMicros, maxOutputWithin, type Price } from '../src/spending/model-prices.js';

const price = (input: number, output: number): Price => ({
  id: 'price',
  currency: 'USD',
  inputMicrosPerMillion: input,
  outputMicrosPerMillion: output,
});

describe('model cost arithmetic', () => {
  it('charges per million tokens, rounding up to the next micro', () => {
    expect(costMicros(price(3_000_000, 15_000_000), 1000, 200)).toBe(6000);
    expect(costMicros(price(1, 1), 1, 0)).toBe(1);
    expect(costMicros(price(1, 1), 0, 0)).toBe(0);
    expect(costMicros(price(0, 0), 10_000_000, 10_000_000)).toBe(0);
    // Beyond Number's exact range before dividing: 1e7 tokens at the highest price.
    expect(costMicros(price(10_000_000_000, 10_000_000_000), 10_000_000, 10_000_000)).toBe(
      200_000_000_000,
    );
    expect(costMicros(price(3, 7), 333_333, 0)).toBe(1);
    expect(costMicros(price(3, 7), 333_333, 1)).toBe(2);
  });

  it('grants the most output that still fits, never more', () => {
    const sonnet = price(3_000_000, 15_000_000);
    expect(maxOutputWithin(sonnet, 30_000, 1000)).toBe(1800);
    expect(costMicros(sonnet, 1000, 1800)).toBe(30_000);
    expect(costMicros(sonnet, 1000, 1801)).toBeGreaterThan(30_000);
    expect(maxOutputWithin(sonnet, 2999, 1000)).toBe(-1);
    expect(maxOutputWithin(sonnet, -5, 0)).toBe(-1);
    expect(maxOutputWithin(price(1_000_000, 0), 10, 5)).toBe(Number.POSITIVE_INFINITY);
    for (const [remaining, input] of [
      [7, 3],
      [1_000_003, 999],
      [123_456_789, 4_000_000],
    ] as const) {
      const odd = price(7, 13);
      const output = maxOutputWithin(odd, remaining, input);
      expect(costMicros(odd, input, output)).toBeLessThanOrEqual(remaining);
      expect(costMicros(odd, input, output + 1)).toBeGreaterThan(remaining);
    }
  });
});
