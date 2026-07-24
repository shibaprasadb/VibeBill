/**
 * Dynamic (date-aware) pricing through the real pipeline (spec §5.5). Two edit
 * events by the SAME model straddle a price change recorded in the CSV overlay;
 * buildContext must price each event on the card in force on its own day
 * (event.ts), not one flat rate for both. This exercises the full
 * ingest → attribution → pricing wiring, not just the pricing unit.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildContext, type GlobalFlags } from '../../src/cli/context.js';
import { makeRepo, toGitIsoDate } from '../helpers/repo.js';
import { session, writeTranscripts } from '../helpers/transcripts.js';

const MODEL = 'claude-opus-4-8';

// Price change on 2026-01-15: $1/$1 before, $10/$10 after (no cache classes,
// and the events carry no cache tokens, so the total is just input+output).
const CHANGE_DATE = '2026-01-15';
const EDIT1_TS = Date.parse('2026-01-10T10:00:00Z'); // before the change → $1/$1
const EDIT2_TS = Date.parse('2026-01-20T10:00:00Z'); // after the change → $10/$10
const COMMIT_TS = EDIT2_TS + 10 * 60_000; // both edits land here, within the 14-day horizon
const NOW_MS = Date.parse('2026-01-21T00:00:00Z');

// 1 MTok input + 1 MTok output per event: cost = (input$ + output$) exactly.
const USAGE = { input: 1_000_000, output: 1_000_000, cacheWrite: 0, cacheRead: 0 };

const tmpDirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function flags(): GlobalFlags {
  return {
    json: false,
    since: null,
    until: null,
    color: false,
    quiet: false,
    strict: false,
    debug: false,
    plan: null,
    allRefs: false,
    refreshPricing: false,
    nowMs: NOW_MS,
  };
}

describe('dynamic pricing (spec §5.5) end to end', () => {
  it('prices each event on the card in force on its own day', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'vibebill-dynprice-'));
    tmpDirs.push(tmp);
    const claudeDir = path.join(tmp, 'claude');

    const historyPath = path.join(tmp, 'price-history.csv');
    await writeFile(
      historyPath,
      [
        'model,effectiveDate,inputPerMTok,outputPerMTok,cacheWritePerMTok,cacheReadPerMTok',
        `${MODEL},2025-01-01,1,1,,`,
        `${MODEL},${CHANGE_DATE},10,10,,`,
      ].join('\n') + '\n',
      'utf8',
    );

    const repo = await makeRepo(tmp);
    const appPath = path.join(repo.root, 'src', 'app.ts');
    const s = session({
      sessionId: 'dyn-price',
      defaultCwd: repo.root,
      defaultBranch: 'main',
      defaultModel: MODEL,
    });
    s.at(EDIT1_TS).call({ usage: USAGE, edits: [appPath] });
    s.at(EDIT2_TS).call({ usage: USAGE, edits: [appPath] });
    await writeTranscripts(claudeDir, [s]);

    await repo.commitFile('src/app.ts', 'export const app = 1;\n', {
      message: 'feat: add app',
      authorDate: toGitIsoDate(COMMIT_TS),
    });

    vi.stubEnv('VIBEBILL_CLAUDE_DIR', claudeDir);
    vi.stubEnv('VIBEBILL_CODEX_DIR', '/nonexistent');
    vi.stubEnv('VIBEBILL_GEMINI_DIR', '/nonexistent');
    vi.stubEnv('VIBEBILL_AIDER_HISTORY', '');
    vi.stubEnv('VIBEBILL_PRICE_HISTORY', historyPath);
    vi.stubEnv('VIBEBILL_NOW', String(NOW_MS));

    const ctx = await buildContext(flags(), { cwd: repo.root });

    const early = ctx.rows.find((r) => r.entry.event.ts === EDIT1_TS);
    const late = ctx.rows.find((r) => r.entry.event.ts === EDIT2_TS);
    expect(early, 'early event present').toBeDefined();
    expect(late, 'late event present').toBeDefined();

    // Before the change: $1/MTok in, $1/MTok out → $2.00 = 2e9 nano-USD.
    expect(early!.entry.cost?.total).toBe(2_000_000_000n);
    // After the change: $10/MTok in, $10/MTok out → $20.00 = 2e10 nano-USD.
    expect(late!.entry.cost?.total).toBe(20_000_000_000n);

    // No clamp warning: both events postdate the earliest (2025-01-01) row.
    expect(ctx.warnings.some((w) => w.includes('price history for'))).toBe(false);
  });
});
