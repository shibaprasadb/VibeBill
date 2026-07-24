import { describe, expect, it } from 'vitest';
import { parsePriceHistoryCsv } from './history.js';

const header =
  'modelId,displayName,effectiveFrom,inputPerMTok,outputPerMTok,cacheWritePerMTok,cacheReadPerMTok';

describe('parsePriceHistoryCsv', () => {
  it('validates prices, groups by model, and sorts by effectiveFrom', () => {
    const history = parsePriceHistoryCsv(
      [
        header,
        'model-b,Model B,2026-03-01,3,4,,',
        'model-a,Model A new,2026-02-01,1.5,2.5,0.5,0.25',
        'model-a,Model A old,2026-01-01,1,2,,',
      ].join('\n'),
    );

    expect(Object.keys(history).sort()).toEqual(['model-a', 'model-b']);
    expect(history['model-a']?.map((row) => row.effectiveFrom)).toEqual([
      '2026-01-01',
      '2026-02-01',
    ]);
    expect(history['model-a']?.[1]?.cacheReadPerMTok).toBe('0.25');
  });

  it('rejects duplicate modelId/effectiveFrom rows', () => {
    expect(() =>
      parsePriceHistoryCsv(
        [header, 'model-a,Model A,2026-01-01,1,2,,', 'model-a,Model A,2026-01-01,3,4,,'].join('\n'),
      ),
    ).toThrow(/duplicate/);
  });

  it('rejects invalid effectiveFrom dates and prices', () => {
    expect(() => parsePriceHistoryCsv(`${header}\nmodel-a,Model A,2026-02-30,1,2,,`)).toThrow(
      /YYYY-MM-DD/,
    );
    expect(() =>
      parsePriceHistoryCsv(`${header}\nmodel-a,Model A,2026-01-01,1.1234567891,2,,`),
    ).toThrow(/inputPerMTok/);
  });
});
