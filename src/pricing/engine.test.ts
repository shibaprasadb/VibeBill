import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CliUserError } from '../core/errors.js';
import {
  LITELLM_PRICES_URL,
  loadBundledPrices,
  loadEffectivePrices,
  loadPriceHistory,
  matchModel,
  priceTokens,
  refreshPricing,
  repriceTokens,
  resolveBundledPricesPath,
  resolveCard,
  type PriceCard,
  type PriceTable,
} from './engine.js';
import { parsePriceToNanoPerMTok } from './money.js';

const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'vibebill-engine-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function table(models: Record<string, PriceCard>): PriceTable {
  return { schemaVersion: 1, asOf: '2026-07-14', source: 'test', models };
}

const OPUS_4: PriceCard = {
  displayName: 'claude-opus-4',
  inputPerMTok: '15',
  outputPerMTok: '75',
  cacheWritePerMTok: '18.75',
  cacheReadPerMTok: '1.5',
};
const OPUS_4_8: PriceCard = {
  displayName: 'claude-opus-4-8',
  inputPerMTok: '5',
  outputPerMTok: '25',
  cacheWritePerMTok: '6.25',
  cacheReadPerMTok: '0.5',
};

describe('matchModel', () => {
  const t = table({ 'claude-opus-4': OPUS_4, 'claude-opus-4-8': OPUS_4_8 });

  it('picks the longest key that is a prefix (dated suffixes)', () => {
    expect(matchModel(t, 'claude-opus-4-8-20260115')?.id).toBe('claude-opus-4-8');
    expect(matchModel(t, 'claude-opus-4-20250514')?.id).toBe('claude-opus-4');
  });

  it('exact match wins naturally', () => {
    expect(matchModel(t, 'claude-opus-4-8')?.id).toBe('claude-opus-4-8');
    expect(matchModel(t, 'claude-opus-4')?.id).toBe('claude-opus-4');
  });

  it('a prefix must match at the START of the raw model string', () => {
    expect(matchModel(t, 'foo-claude-opus-4')).toBeNull();
    expect(matchModel(t, 'xclaude-opus-4-8')).toBeNull();
  });

  it('returns null for unknown models', () => {
    expect(matchModel(t, 'gpt-99')).toBeNull();
    expect(matchModel(t, '')).toBeNull();
    expect(matchModel(t, 'claude-opus-')).toBeNull();
  });

  it('matches dated suffixes against the real bundled table', () => {
    const bundled = loadBundledPrices();
    expect(matchModel(bundled, 'claude-opus-4-8-20260115')?.id).toBe('claude-opus-4-8');
  });
});

describe('resolveCard', () => {
  it('resolves a full card exactly with no fallback', () => {
    const { nano, cacheFallback } = resolveCard(OPUS_4_8);
    expect(cacheFallback).toBe(false);
    expect(nano.inputPerMTok).toBe(5_000_000_000n);
    expect(nano.outputPerMTok).toBe(25_000_000_000n);
    expect(nano.cacheWritePerMTok).toBe(6_250_000_000n);
    expect(nano.cacheReadPerMTok).toBe(500_000_000n);
  });

  it('falls back to inputPerMTok for missing cache prices and flags it', () => {
    const { nano, cacheFallback } = resolveCard({
      displayName: 'no-cache',
      inputPerMTok: '2',
      outputPerMTok: '8',
    });
    expect(cacheFallback).toBe(true);
    expect(nano.cacheWritePerMTok).toBe(2_000_000_000n);
    expect(nano.cacheReadPerMTok).toBe(2_000_000_000n);
  });

  it('flags fallback when only one cache price is missing', () => {
    const { nano, cacheFallback } = resolveCard({
      displayName: 'half-cache',
      inputPerMTok: '2',
      outputPerMTok: '8',
      cacheReadPerMTok: '0.5',
    });
    expect(cacheFallback).toBe(true);
    expect(nano.cacheWritePerMTok).toBe(2_000_000_000n); // missing -> input
    expect(nano.cacheReadPerMTok).toBe(500_000_000n); // present -> as given
  });
});

describe('priceTokens', () => {
  const t = table({ 'claude-opus-4-8': OPUS_4_8 });
  const tokens = {
    input: 1_000_000,
    output: 2_000_000,
    cacheWrite: 400_000,
    cacheRead: 10_000_000,
  };

  it('prices a known model exactly', () => {
    const cost = priceTokens(t, 'claude-opus-4-8-20260115', tokens);
    expect(cost).not.toBeNull();
    expect(cost!.input).toBe(5_000_000_000n); // 1 MTok * $5
    expect(cost!.output).toBe(50_000_000_000n); // 2 MTok * $25
    expect(cost!.cacheWrite).toBe(2_500_000_000n); // 0.4 MTok * $6.25
    expect(cost!.cacheRead).toBe(5_000_000_000n); // 10 MTok * $0.5
    expect(cost!.total).toBe(62_500_000_000n);
  });

  it('returns null for unknown models (never guesses)', () => {
    expect(priceTokens(t, 'totally-unknown-model', tokens)).toBeNull();
  });

  it('prices with the latest in-memory history row effective on the event day', () => {
    const history = {
      'claude-opus-4-8': [
        {
          modelId: 'claude-opus-4-8',
          displayName: 'old-opus',
          effectiveFrom: '2026-01-01',
          inputPerMTok: '10',
          outputPerMTok: '20',
          cacheWritePerMTok: '30',
          cacheReadPerMTok: '40',
        },
        {
          modelId: 'claude-opus-4-8',
          displayName: 'new-opus',
          effectiveFrom: '2026-03-01',
          inputPerMTok: '1',
          outputPerMTok: '2',
          cacheWritePerMTok: '3',
          cacheReadPerMTok: '4',
        },
      ],
    };

    const beforeFirstEffectiveDate = priceTokens(t, 'claude-opus-4-8-20260115', tokens, {
      history,
      ts: Date.parse('2025-12-31T23:59:59.999Z'),
    });
    const beforeChange = priceTokens(t, 'claude-opus-4-8-20260115', tokens, {
      history,
      ts: Date.parse('2026-02-15T12:00:00.000Z'),
    });
    const onChange = priceTokens(t, 'claude-opus-4-8-20260115', tokens, {
      history,
      ts: Date.parse('2026-03-01T00:00:00.000Z'),
    });
    const afterChange = priceTokens(t, 'claude-opus-4-8-20260115', tokens, {
      history,
      ts: Date.parse('2026-04-15T12:00:00.000Z'),
    });

    // Before any effective history row, the current table card is the fallback.
    expect(beforeFirstEffectiveDate!.input).toBe(5_000_000_000n);
    expect(beforeFirstEffectiveDate!.output).toBe(50_000_000_000n);
    expect(beforeChange!.input).toBe(10_000_000_000n);
    expect(beforeChange!.output).toBe(40_000_000_000n);
    expect(beforeChange!.cacheWrite).toBe(12_000_000_000n);
    expect(beforeChange!.cacheRead).toBe(400_000_000_000n);
    expect(onChange!.input).toBe(1_000_000_000n);
    expect(onChange!.output).toBe(4_000_000_000n);
    expect(onChange!.cacheWrite).toBe(1_200_000_000n);
    expect(onChange!.cacheRead).toBe(40_000_000_000n);
    expect(afterChange).toEqual(onChange);
  });

  it('keeps longest-prefix matching when dated raw models use historical prices', () => {
    const history = {
      'claude-opus-4': [
        {
          modelId: 'claude-opus-4',
          displayName: 'base',
          effectiveFrom: '2026-01-01',
          inputPerMTok: '100',
          outputPerMTok: '100',
        },
      ],
      'claude-opus-4-8': [
        {
          modelId: 'claude-opus-4-8',
          displayName: 'suffix',
          effectiveFrom: '2026-01-01',
          inputPerMTok: '1',
          outputPerMTok: '1',
        },
      ],
    };

    const cost = priceTokens(
      t,
      'claude-opus-4-8-20260115',
      { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 },
      {
        history,
        ts: Date.parse('2026-02-01T00:00:00.000Z'),
      },
    );

    expect(cost!.input).toBe(1_000_000_000n);
  });

  it('lets a history row dated after currentEffectiveFrom take effect (not shadowed by the table)', async () => {
    const dir = await makeTempDir();
    const csv = path.join(dir, 'prices-history.csv');
    writeFileSync(
      csv,
      [
        'modelId,displayName,effectiveFrom,inputPerMTok,outputPerMTok,cacheWritePerMTok,cacheReadPerMTok',
        'claude-opus-4-8,old-opus,2026-01-01,10,20,30,40',
        'claude-opus-4-8,new-opus,2026-08-01,1,2,3,4',
      ].join('\n'),
      'utf8',
    );
    const history = loadPriceHistory(csv);

    // Event on 2026-08-15: the 2026-08-01 row is newer than the table's asOf
    // (2026-07-14), so it — not the stale table card — is in force.
    const cost = priceTokens(t, 'claude-opus-4-8-20260115', tokens, {
      history,
      ts: Date.parse('2026-08-15T12:00:00.000Z'),
      currentEffectiveFrom: '2026-07-14',
    });

    expect(cost!.input).toBe(1_000_000_000n); // 1 MTok * $1
    expect(cost!.output).toBe(4_000_000_000n); // 2 MTok * $2
    expect(cost!.cacheWrite).toBe(1_200_000_000n); // 0.4 MTok * $3
    expect(cost!.cacheRead).toBe(40_000_000_000n); // 10 MTok * $4
  });

  it('keeps the current table card for events on/after asOf when no history row is newer', () => {
    const history = {
      'claude-opus-4-8': [
        {
          modelId: 'claude-opus-4-8',
          displayName: 'old-opus',
          effectiveFrom: '2026-01-01',
          inputPerMTok: '10',
          outputPerMTok: '20',
        },
      ],
    };
    const cost = priceTokens(t, 'claude-opus-4-8-20260115', tokens, {
      history,
      ts: Date.parse('2026-08-15T12:00:00.000Z'),
      currentEffectiveFrom: '2026-07-14',
    });
    // asOf (2026-07-14) is newer than the only history row (2026-01-01), so the
    // table card ($5/$25) governs recent usage.
    expect(cost!.input).toBe(5_000_000_000n);
    expect(cost!.output).toBe(50_000_000_000n);
  });

  it('selects the latest effective row even when JSON history rows are out of order', async () => {
    const dir = await makeTempDir();
    const json = path.join(dir, 'prices-history.json');
    // Rows deliberately NOT sorted by effectiveFrom (as a hand-edited file might be).
    writeFileSync(
      json,
      JSON.stringify({
        schemaVersion: 1,
        source: 'test',
        models: {
          'claude-opus-4-8': [
            {
              modelId: 'claude-opus-4-8',
              displayName: 'new',
              effectiveFrom: '2026-03-01',
              inputPerMTok: '2',
              outputPerMTok: '0',
            },
            {
              modelId: 'claude-opus-4-8',
              displayName: 'old',
              effectiveFrom: '2026-01-01',
              inputPerMTok: '1',
              outputPerMTok: '0',
            },
          ],
        },
      }),
      'utf8',
    );
    const history = loadPriceHistory(json);

    const cost = priceTokens(
      t,
      'claude-opus-4-8',
      { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 },
      { history, ts: Date.parse('2026-04-15T00:00:00.000Z') },
    );
    // 2026-04-15 falls under the 2026-03-01 row ($2), not the earlier $1 row.
    expect(cost!.input).toBe(2_000_000_000n);
  });
});

describe('repriceTokens', () => {
  const tokens = { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 1_000_000 };

  it('reprices measured traffic on a counterfactual card', () => {
    const { cost, cacheFallback } = repriceTokens(tokens, OPUS_4_8);
    expect(cacheFallback).toBe(false);
    expect(cost.input).toBe(5_000_000_000n);
    expect(cost.cacheRead).toBe(500_000_000n);
    expect(cost.total).toBe(5_500_000_000n);
  });

  it('flags cacheFallback and prices cache classes at inputPerMTok when card lacks cache prices', () => {
    const { cost, cacheFallback } = repriceTokens(tokens, {
      displayName: 'no-cache',
      inputPerMTok: '2',
      outputPerMTok: '8',
    });
    expect(cacheFallback).toBe(true);
    expect(cost.cacheRead).toBe(2_000_000_000n); // priced at input rate
    expect(cost.total).toBe(4_000_000_000n);
  });
});

describe('loadBundledPrices', () => {
  it('resolves and validates the real bundled table from the source tree', () => {
    const bundled = loadBundledPrices();
    expect(bundled.schemaVersion).toBe(1);
    expect(bundled.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(bundled.models).length).toBeGreaterThan(10);
    expect(Object.keys(bundled.models).some((id) => id.startsWith('claude-'))).toBe(true);
  });

  it('every bundled price parses with the exact money parser', () => {
    const bundled = loadBundledPrices();
    for (const [id, card] of Object.entries(bundled.models)) {
      expect(() => parsePriceToNanoPerMTok(card.inputPerMTok), id).not.toThrow();
      expect(() => parsePriceToNanoPerMTok(card.outputPerMTok), id).not.toThrow();
      if (card.cacheWritePerMTok !== undefined) {
        expect(() => parsePriceToNanoPerMTok(card.cacheWritePerMTok!), id).not.toThrow();
      }
      if (card.cacheReadPerMTok !== undefined) {
        expect(() => parsePriceToNanoPerMTok(card.cacheReadPerMTok!), id).not.toThrow();
      }
    }
  });

  it('resolves from the dist layout (dist/src/pricing -> ../../../prices/prices.json)', () => {
    const sourceResolved = resolveBundledPricesPath();
    const repoRoot = path.dirname(path.dirname(sourceResolved));
    const distModuleUrl = pathToFileURL(
      path.join(repoRoot, 'dist', 'src', 'pricing', 'engine.js'),
    ).href;
    expect(resolveBundledPricesPath(distModuleUrl)).toBe(
      path.join(repoRoot, 'prices', 'prices.json'),
    );
  });
});

describe('loadEffectivePrices', () => {
  function writeUserTable(configDir: string, content: string): string {
    const dir = path.join(configDir, 'vibebill');
    mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'prices.json');
    writeFileSync(p, content, 'utf8');
    return p;
  }

  it('uses the bundled table when no user table exists', async () => {
    const configDir = await makeTempDir();
    const { table: t, origin, path: p, warnings } = loadEffectivePrices({ configDir });
    expect(origin).toBe('bundled');
    expect(p.endsWith(path.join('prices', 'prices.json'))).toBe(true);
    expect(warnings).toEqual([]);
    expect(Object.keys(t.models).length).toBeGreaterThan(0);
  });

  it('a valid user table wins over bundled', async () => {
    const configDir = await makeTempDir();
    const userPath = writeUserTable(
      configDir,
      JSON.stringify(table({ 'claude-opus-4-8': OPUS_4_8 })),
    );
    const { table: t, origin, path: p, warnings } = loadEffectivePrices({ configDir });
    expect(origin).toBe('refreshed');
    expect(p).toBe(userPath);
    expect(warnings).toEqual([]);
    expect(Object.keys(t.models)).toEqual(['claude-opus-4-8']);
  });

  it('an invalid user table falls back to bundled with a warning', async () => {
    const configDir = await makeTempDir();
    const bad = table({ 'claude-opus-4-8': { ...OPUS_4_8, inputPerMTok: 'not-a-price' } });
    writeUserTable(configDir, JSON.stringify(bad));
    const { origin, warnings } = loadEffectivePrices({ configDir });
    expect(origin).toBe('bundled');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('falling back');
  });

  it('a corrupt (non-JSON) user table falls back to bundled with a warning', async () => {
    const configDir = await makeTempDir();
    writeUserTable(configDir, '{ this is not json');
    const { origin, warnings } = loadEffectivePrices({ configDir });
    expect(origin).toBe('bundled');
    expect(warnings).toHaveLength(1);
  });

  it('surfaces unknown-key warnings from a valid user table', async () => {
    const configDir = await makeTempDir();
    const raw = { ...table({ 'claude-opus-4-8': OPUS_4_8 }), futureField: 42 };
    writeUserTable(configDir, JSON.stringify(raw));
    const { origin, warnings } = loadEffectivePrices({ configDir });
    expect(origin).toBe('refreshed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('futureField');
  });

  it('encodes mixed bundled-history/refreshed-current sources', async () => {
    const configDir = await makeTempDir();
    const userPath = writeUserTable(
      configDir,
      JSON.stringify(table({ 'claude-opus-4-8': OPUS_4_8 })),
    );
    const { sources } = loadEffectivePrices({ configDir });
    expect(sources).toEqual([
      expect.objectContaining({ origin: 'bundled' }),
      { origin: 'refreshed', path: userPath, effectiveFrom: '2026-07-14' },
    ]);
  });

  it('warns and ignores user historical pricing files', async () => {
    const configDir = await makeTempDir();
    const dir = path.join(configDir, 'vibebill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'prices-history.json'), '{ bad json', 'utf8');
    const { origin, warnings } = loadEffectivePrices({ configDir });
    expect(origin).toBe('bundled');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('user historical pricing file');
    expect(warnings[0]).toContain('using bundled history');
  });
});

describe('refreshPricing', () => {
  const litellmPayload = {
    sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0 },
    'claude-omega-9': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      input_cost_per_token: 1.5e-5,
      output_cost_per_token: 7.5e-5,
      cache_creation_input_token_cost: 1.875e-5,
      cache_read_input_token_cost: 1.5e-6,
      max_tokens: 8192, // unknown fields tolerated
    },
    'claude-nano-9': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      input_cost_per_token: 2.5e-7,
      output_cost_per_token: 1.25e-6,
    },
    'gpt-9': {
      litellm_provider: 'openai',
      mode: 'responses',
      input_cost_per_token: 1.25e-6,
      output_cost_per_token: 1e-5,
      cache_read_input_token_cost: 1.25e-7,
    },
    'gemini/gemini-9-pro': {
      litellm_provider: 'gemini',
      mode: 'chat',
      input_cost_per_token: 2e-6,
      output_cost_per_token: 1.2e-5,
    },
    'deepseek/deepseek-chat': {
      litellm_provider: 'deepseek',
      mode: 'chat',
      input_cost_per_token: 2.8e-7,
      output_cost_per_token: 4.2e-7,
    },
    'dashscope/qwen3-coder-plus': {
      litellm_provider: 'dashscope',
      mode: 'chat',
      input_cost_per_token: 3e-7,
      output_cost_per_token: 1.5e-6,
    },
    'claude-no-output-price': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      input_cost_per_token: 1e-6,
    },
    'gpt-image-9': {
      litellm_provider: 'openai',
      mode: 'image_generation',
      input_cost_per_token: 1e-6,
      output_cost_per_token: 1e-6,
    },
    'mistral/mistral-huge': {
      litellm_provider: 'mistral',
      mode: 'chat',
      input_cost_per_token: 1e-6,
      output_cost_per_token: 1e-6,
    },
  };

  function stubFetch(handler: (url: string) => Promise<Response>): {
    impl: typeof fetch;
    calls: string[];
  } {
    const calls: string[] = [];
    const impl = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      return handler(url);
    }) as typeof fetch;
    return { impl, calls };
  }

  it('fetches, converts exactly, and writes the user table', async () => {
    const configDir = await makeTempDir();
    const { impl, calls } = stubFetch(
      async () => new Response(JSON.stringify(litellmPayload), { status: 200 }),
    );
    const result = await refreshPricing({ configDir, fetchImpl: impl });

    expect(calls).toEqual([LITELLM_PRICES_URL]);
    expect(result.path).toBe(path.join(configDir, 'vibebill', 'prices.json'));
    expect(result.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.modelCount).toBe(6);

    const written = JSON.parse(readFileSync(result.path, 'utf8')) as PriceTable;
    expect(written.schemaVersion).toBe(1);
    expect(written.asOf).toBe(result.asOf);
    expect(written.source).toContain(LITELLM_PRICES_URL);
    expect(written.source).toContain(result.asOf);
    expect(Object.keys(written.models).sort()).toEqual([
      'claude-nano-9',
      'claude-omega-9',
      'deepseek-chat',
      'gemini-9-pro',
      'gpt-9',
      'qwen3-coder-plus',
    ]);

    // Conversion exactness: 1.5e-05 -> "15", 2.5e-07 -> "0.25".
    expect(written.models['claude-omega-9']).toEqual({
      displayName: 'claude-omega-9',
      inputPerMTok: '15',
      outputPerMTok: '75',
      cacheWritePerMTok: '18.75',
      cacheReadPerMTok: '1.5',
    });
    expect(written.models['claude-nano-9']).toEqual({
      displayName: 'claude-nano-9',
      inputPerMTok: '0.25',
      outputPerMTok: '1.25',
    });
    expect(written.models['gpt-9']?.cacheReadPerMTok).toBe('0.125');
    expect(written.models['deepseek-chat']?.inputPerMTok).toBe('0.28');

    // The written table now wins over bundled.
    const effective = loadEffectivePrices({ configDir });
    expect(effective.origin).toBe('refreshed');
    expect(effective.table.asOf).toBe(result.asOf);
  });

  it('omits models missing prices, wrong mode, or wrong provider', async () => {
    const configDir = await makeTempDir();
    const { impl } = stubFetch(
      async () => new Response(JSON.stringify(litellmPayload), { status: 200 }),
    );
    const result = await refreshPricing({ configDir, fetchImpl: impl });
    const written = JSON.parse(readFileSync(result.path, 'utf8')) as PriceTable;
    expect(written.models['claude-no-output-price']).toBeUndefined();
    expect(written.models['gpt-image-9']).toBeUndefined();
    expect(written.models['mistral-huge']).toBeUndefined();
    expect(written.models['mistral/mistral-huge']).toBeUndefined();
    expect(written.models['sample_spec']).toBeUndefined();
  });

  function assertNoPartialFile(configDir: string): void {
    const dir = path.join(configDir, 'vibebill');
    expect(existsSync(path.join(dir, 'prices.json'))).toBe(false);
    if (existsSync(dir)) {
      expect(readdirSync(dir)).toEqual([]); // no tmp leftovers either
    }
  }

  it('network failure throws CliUserError and keeps no partial file', async () => {
    const configDir = await makeTempDir();
    const { impl } = stubFetch(async () => {
      throw new Error('ENOTFOUND raw.githubusercontent.com');
    });
    await expect(refreshPricing({ configDir, fetchImpl: impl })).rejects.toBeInstanceOf(
      CliUserError,
    );
    assertNoPartialFile(configDir);
  });

  it('HTTP error status throws CliUserError and keeps no partial file', async () => {
    const configDir = await makeTempDir();
    const { impl } = stubFetch(async () => new Response('nope', { status: 500 }));
    await expect(refreshPricing({ configDir, fetchImpl: impl })).rejects.toBeInstanceOf(
      CliUserError,
    );
    assertNoPartialFile(configDir);
  });

  it('non-object payload throws CliUserError and keeps no partial file', async () => {
    const configDir = await makeTempDir();
    const { impl } = stubFetch(
      async () => new Response(JSON.stringify('not a table'), { status: 200 }),
    );
    await expect(refreshPricing({ configDir, fetchImpl: impl })).rejects.toBeInstanceOf(
      CliUserError,
    );
    assertNoPartialFile(configDir);
  });

  it('payload with zero usable models throws CliUserError and keeps no partial file', async () => {
    const configDir = await makeTempDir();
    const { impl } = stubFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(refreshPricing({ configDir, fetchImpl: impl })).rejects.toBeInstanceOf(
      CliUserError,
    );
    assertNoPartialFile(configDir);
  });

  it('unwritable config path throws CliUserError (no crash, no partial file)', async () => {
    const configDir = await makeTempDir();
    // Occupy the vibebill directory path with a FILE so mkdir/write must fail.
    writeFileSync(path.join(configDir, 'vibebill'), 'in the way', 'utf8');
    const { impl } = stubFetch(
      async () => new Response(JSON.stringify(litellmPayload), { status: 200 }),
    );
    await expect(refreshPricing({ configDir, fetchImpl: impl })).rejects.toBeInstanceOf(
      CliUserError,
    );
  });
});
