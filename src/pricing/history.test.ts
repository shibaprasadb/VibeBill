import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { priceTokensOn, type PriceCard, type PriceTable } from './engine.js';
import {
  cardEffectiveOn,
  loadBundledPriceHistory,
  loadEffectivePriceHistory,
  parsePriceHistory,
} from './history.js';

const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'vibebill-history-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
  delete process.env['VIBEBILL_PRICE_HISTORY'];
});

/** UTC-midnight epoch ms for a YYYY-MM-DD, for readable test dates. */
function day(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

const STATIC_GPT4O: PriceCard = {
  displayName: 'gpt-4o',
  inputPerMTok: '2.5',
  outputPerMTok: '10',
  cacheReadPerMTok: '1.25',
};

describe('parsePriceHistory', () => {
  it('parses rows, skips comments/blanks/header, and sorts by date', () => {
    const csv = [
      '# a comment',
      'model,effectiveDate,inputPerMTok,outputPerMTok,cacheWritePerMTok,cacheReadPerMTok',
      '',
      'gpt-4o,2024-08-06,2.5,10,,1.25',
      'gpt-4o,2024-05-13,5,15,,', // out of order on purpose
    ].join('\n');
    const { history, warnings } = parsePriceHistory(csv, 'test');
    expect(warnings).toEqual([]);
    const rows = history.get('gpt-4o');
    expect(rows).toHaveLength(2);
    expect(rows!.map((r) => r.effectiveDate)).toEqual(['2024-05-13', '2024-08-06']); // sorted asc
    expect(rows![0]!.card.inputPerMTok).toBe('5');
    expect(rows![1]!.card.cacheReadPerMTok).toBe('1.25');
    expect(rows![0]!.card.cacheReadPerMTok).toBeUndefined(); // blank column omitted
  });

  it('drops rows with invalid dates, prices, or missing fields — with a warning each', () => {
    const csv = [
      'gpt-4o,2024-13-40,5,15,,', // impossible date
      'gpt-4o,2024-05-13,-5,15,,', // negative price rejected by the money parser
      'gpt-4o,2024-05-13,5,,,', // missing output
      ',2024-05-13,5,15,,', // missing model
      'gpt-4o,2024-06-01,3,12,,', // the one good row
    ].join('\n');
    const { history, warnings } = parsePriceHistory(csv, 'test');
    expect(history.get('gpt-4o')).toHaveLength(1);
    expect(history.get('gpt-4o')![0]!.effectiveDate).toBe('2024-06-01');
    expect(warnings).toHaveLength(4);
  });

  it('keeps the first of duplicate (model,date) rows and warns', () => {
    const csv = ['gpt-4o,2024-05-13,5,15,,', 'gpt-4o,2024-05-13,9,9,,'].join('\n');
    const { history, warnings } = parsePriceHistory(csv, 'test');
    expect(history.get('gpt-4o')).toHaveLength(1);
    expect(history.get('gpt-4o')![0]!.card.inputPerMTok).toBe('5');
    expect(warnings.some((w) => w.includes('duplicate'))).toBe(true);
  });
});

describe('cardEffectiveOn', () => {
  const { history } = parsePriceHistory(
    ['gpt-4o,2024-05-13,5,15,,', 'gpt-4o,2024-08-06,2.5,10,,1.25'].join('\n'),
    'test',
  );

  it('picks the latest row on or before the event day', () => {
    const on = cardEffectiveOn(history, 'gpt-4o', STATIC_GPT4O, day('2024-08-06'));
    expect(on.effectiveDate).toBe('2024-08-06');
    expect(on.card.inputPerMTok).toBe('2.5');
    expect(on.clamped).toBe(false);

    const between = cardEffectiveOn(history, 'gpt-4o', STATIC_GPT4O, day('2024-07-01'));
    expect(between.effectiveDate).toBe('2024-05-13');
    expect(between.card.inputPerMTok).toBe('5');
  });

  it('clamps to the earliest row for events predating all history, flagging it', () => {
    const before = cardEffectiveOn(history, 'gpt-4o', STATIC_GPT4O, day('2024-01-01'));
    expect(before.effectiveDate).toBe('2024-05-13');
    expect(before.card.inputPerMTok).toBe('5');
    expect(before.clamped).toBe(true);
  });

  it('falls back to the static card when the model has no history', () => {
    const eff = cardEffectiveOn(history, 'claude-opus-4-8', STATIC_GPT4O, day('2024-08-06'));
    expect(eff.effectiveDate).toBeNull();
    expect(eff.clamped).toBe(false);
    expect(eff.card).toBe(STATIC_GPT4O);
  });

  it('preserves the static displayName, never the history row label', () => {
    const named: PriceCard = { ...STATIC_GPT4O, displayName: 'GPT-4o (catalog)' };
    const eff = cardEffectiveOn(history, 'gpt-4o', named, day('2024-08-06'));
    expect(eff.card.displayName).toBe('GPT-4o (catalog)');
  });
});

describe('priceTokensOn', () => {
  const table: PriceTable = {
    schemaVersion: 1,
    asOf: '2026-07-14',
    source: 'test',
    models: { 'gpt-4o': STATIC_GPT4O },
  };
  const { history } = parsePriceHistory(
    ['gpt-4o,2024-05-13,5,15,,', 'gpt-4o,2024-08-06,2.5,10,,1.25'].join('\n'),
    'test',
  );
  const tokens = { input: 1_000_000, output: 1_000_000, cacheWrite: 0, cacheRead: 0 };

  it('prices the same traffic differently either side of a price change', () => {
    const early = priceTokensOn(table, history, 'gpt-4o-2024-05-13', tokens, day('2024-06-01'));
    // $5 input + $15 output per MTok, 1 MTok each.
    expect(early!.cost.total).toBe(20_000_000_000n);
    expect(early!.effectiveDate).toBe('2024-05-13');

    const late = priceTokensOn(table, history, 'gpt-4o', tokens, day('2024-09-01'));
    // $2.5 input + $10 output per MTok.
    expect(late!.cost.total).toBe(12_500_000_000n);
    expect(late!.effectiveDate).toBe('2024-08-06');
  });

  it('falls back to the flat card for a model without history', () => {
    const t2: PriceTable = {
      ...table,
      models: {
        ...table.models,
        'claude-opus-4-8': { displayName: 'x', inputPerMTok: '5', outputPerMTok: '25' },
      },
    };
    const priced = priceTokensOn(t2, history, 'claude-opus-4-8', tokens, day('2024-01-01'));
    expect(priced!.effectiveDate).toBeNull();
    expect(priced!.cost.total).toBe(30_000_000_000n); // $5 + $25
  });

  it('returns null for an unknown model (never guesses)', () => {
    expect(priceTokensOn(table, history, 'totally-unknown', tokens, day('2024-09-01'))).toBeNull();
  });
});

describe('loadEffectivePriceHistory', () => {
  function writeUserHistory(configDir: string, content: string): string {
    const dir = path.join(configDir, 'vibebill');
    mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'price-history.csv');
    writeFileSync(p, content, 'utf8');
    return p;
  }

  it('loads the bundled overlay and prices gpt-4o across its 2024-08-06 change', () => {
    const bundled = loadBundledPriceHistory();
    const rows = bundled.history.get('gpt-4o');
    expect(rows && rows.length).toBeGreaterThanOrEqual(2);
    const early = cardEffectiveOn(bundled.history, 'gpt-4o', STATIC_GPT4O, day('2024-06-01'));
    expect(early.card.inputPerMTok).toBe('5');
    const late = cardEffectiveOn(bundled.history, 'gpt-4o', STATIC_GPT4O, day('2024-09-01'));
    expect(late.card.inputPerMTok).toBe('2.5');
  });

  it('prefers a user overlay over the bundled one', async () => {
    const configDir = await makeTempDir();
    writeUserHistory(configDir, 'claude-sonnet-5,2026-01-01,2,10,2.5,0.2\n');
    const eff = loadEffectivePriceHistory({ configDir });
    expect(eff.origin).toBe('user');
    expect(eff.history.has('claude-sonnet-5')).toBe(true);
    expect(eff.history.has('gpt-4o')).toBe(false); // user overlay fully replaces bundled
  });

  it('honors $VIBEBILL_PRICE_HISTORY as a direct file override', async () => {
    const dir = await makeTempDir();
    const p = path.join(dir, 'custom.csv');
    writeFileSync(p, 'gpt-4o,2024-05-13,5,15,,\n', 'utf8');
    process.env['VIBEBILL_PRICE_HISTORY'] = p;
    const eff = loadEffectivePriceHistory();
    expect(eff.origin).toBe('env');
    expect(eff.path).toBe(p);
    expect(eff.history.has('gpt-4o')).toBe(true);
  });

  it('degrades to an empty overlay (with a warning) when the env file is missing', async () => {
    const dir = await makeTempDir();
    process.env['VIBEBILL_PRICE_HISTORY'] = path.join(dir, 'nope.csv');
    const eff = loadEffectivePriceHistory();
    expect(eff.history.size).toBe(0);
    expect(eff.warnings.length).toBeGreaterThan(0);
  });
});
