/**
 * Dynamic (date-aware) pricing (spec §5.5). A small CSV overlay records the
 * dates on which a model's $/MTok price CHANGED; before pricing an event
 * vibebill looks up the card that was in force on the event's own day and
 * computes cost from that. Models absent from the overlay keep their flat
 * prices.json card, so this is purely additive — nothing changes for a model
 * until a dated row is added for it, and a missing CSV disables the feature
 * without error.
 *
 * Same discipline as prices.json: prices are $/MTok decimal strings parsed by
 * the exact money routine (§8), never floats; a row that cannot be parsed
 * exactly is dropped with a warning, never guessed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InternalError } from '../core/errors.js';
import type { PriceCard } from './engine.js';
import { parsePriceToNanoPerMTok } from './money.js';

/** One model's price card together with the UTC day it took effect. */
export interface DatedPriceCard {
  /** ISO YYYY-MM-DD (UTC) on which this price took effect. */
  effectiveDate: string;
  /** effectiveDate as UTC epoch ms at 00:00 — precomputed for cheap comparison. */
  effectiveMs: number;
  card: PriceCard;
}

/**
 * model-id -> its dated cards, sorted ascending by effectiveMs (spec §5.5).
 * Keyed by the same id prefixes as prices.json so a matched model lines up.
 */
export type PriceHistory = Map<string, DatedPriceCard[]>;

/** A validated history plus non-fatal warnings (bad rows dropped, surfaced). */
export interface ParsedPriceHistory {
  history: PriceHistory;
  warnings: string[];
}

/** The card in force at a moment, with enough context for an honest warning. */
export interface EffectiveCard {
  card: PriceCard;
  /** The dated row that applied, or null when the model has no history (static card used). */
  effectiveDate: string | null;
  /** True when the event predates all history and the earliest row was clamped in. */
  clamped: boolean;
}

/** Parse "YYYY-MM-DD" to a UTC-midnight epoch ms, or null if not a real date. */
function parseUtcDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Reject overflow like 2024-13-40 that Date.UTC would silently roll over.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

/**
 * Parse the price-history CSV into a PriceHistory. Never throws on bad content:
 * malformed rows are dropped and reported in `warnings`. Columns (header
 * optional, order fixed):
 *   model, effectiveDate, inputPerMTok, outputPerMTok, cacheWritePerMTok?, cacheReadPerMTok?
 * Blank lines and lines starting with `#` are ignored. Blank cache columns are
 * omitted (they fall back to input price at pricing time, like prices.json).
 */
export function parsePriceHistory(csv: string, sourceLabel: string): ParsedPriceHistory {
  const warnings: string[] = [];
  const byModel: PriceHistory = new Map();
  // model -> set of dates already accepted, to catch duplicates.
  const seenDates = new Map<string, Set<string>>();

  const lines = csv.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;

    const cols = line.split(',').map((c) => c.trim());
    // Skip a header row if present (first data-ish line naming the columns).
    if (cols[0]?.toLowerCase() === 'model' && cols[1]?.toLowerCase() === 'effectivedate') {
      continue;
    }

    const lineNo = i + 1;
    const [model, dateStr, input, output, cacheWrite, cacheRead] = cols;

    if (model === undefined || model === '' || dateStr === undefined || dateStr === '') {
      warnings.push(
        `price history (${sourceLabel}) line ${lineNo}: missing model or date — row skipped`,
      );
      continue;
    }
    const effectiveMs = parseUtcDate(dateStr);
    if (effectiveMs === null) {
      warnings.push(
        `price history (${sourceLabel}) line ${lineNo}: invalid date ${JSON.stringify(dateStr)} (want YYYY-MM-DD) — row skipped`,
      );
      continue;
    }
    if (input === undefined || input === '' || output === undefined || output === '') {
      warnings.push(
        `price history (${sourceLabel}) line ${lineNo}: model "${model}" missing input/output price — row skipped`,
      );
      continue;
    }

    const card: PriceCard = { displayName: model, inputPerMTok: input, outputPerMTok: output };
    if (cacheWrite !== undefined && cacheWrite !== '') card.cacheWritePerMTok = cacheWrite;
    if (cacheRead !== undefined && cacheRead !== '') card.cacheReadPerMTok = cacheRead;

    // Validate every price by actually parsing it; any failure drops the row.
    try {
      parsePriceToNanoPerMTok(card.inputPerMTok);
      parsePriceToNanoPerMTok(card.outputPerMTok);
      if (card.cacheWritePerMTok !== undefined) parsePriceToNanoPerMTok(card.cacheWritePerMTok);
      if (card.cacheReadPerMTok !== undefined) parsePriceToNanoPerMTok(card.cacheReadPerMTok);
    } catch (err) {
      warnings.push(
        `price history (${sourceLabel}) line ${lineNo}: model "${model}" ${err instanceof Error ? err.message : 'invalid price'} — row skipped`,
      );
      continue;
    }

    let dates = seenDates.get(model);
    if (dates === undefined) {
      dates = new Set();
      seenDates.set(model, dates);
    }
    if (dates.has(dateStr)) {
      warnings.push(
        `price history (${sourceLabel}) line ${lineNo}: model "${model}" has a duplicate row for ${dateStr} — keeping the first, ignoring this one`,
      );
      continue;
    }
    dates.add(dateStr);

    const rows = byModel.get(model) ?? [];
    rows.push({ effectiveDate: dateStr, effectiveMs, card });
    byModel.set(model, rows);
  }

  for (const rows of byModel.values()) {
    rows.sort((a, b) => a.effectiveMs - b.effectiveMs);
  }
  return { history: byModel, warnings };
}

/**
 * The price card for `modelId` in force at `atMs`: the latest dated row whose
 * effectiveDate is on or before that day. Falls back to `staticCard` when the
 * model has no history; clamps to the earliest known row when the event
 * predates all history (flagged so the caller can warn). The static card's
 * displayName is always preserved — history rows never own display names.
 */
export function cardEffectiveOn(
  history: PriceHistory,
  modelId: string,
  staticCard: PriceCard,
  atMs: number,
): EffectiveCard {
  const dated = history.get(modelId);
  if (dated === undefined || dated.length === 0) {
    return { card: staticCard, effectiveDate: null, clamped: false };
  }
  let chosen: DatedPriceCard | null = null;
  for (const row of dated) {
    if (row.effectiveMs <= atMs) chosen = row;
    else break; // sorted ascending — nothing later can apply
  }
  const clamped = chosen === null;
  const row = chosen ?? dated[0]!;
  return {
    card: { ...row.card, displayName: staticCard.displayName },
    effectiveDate: row.effectiveDate,
    clamped,
  };
}

/**
 * The single-executable build injects the bundled CSV as a global string
 * because a SEA binary carries no price-history.csv on disk; absent elsewhere.
 */
function embeddedPriceHistory(): string | undefined {
  return (globalThis as { __vibebillBundledPriceHistory?: string }).__vibebillBundledPriceHistory;
}

/**
 * Resolve the bundled prices/price-history.csv relative to THIS module file,
 * matching resolveBundledPricesPath. Returns null when absent — a missing
 * overlay simply disables dynamic pricing, it is never an error.
 */
export function resolveBundledPriceHistoryPath(
  fromModuleUrl: string = import.meta.url,
): string | null {
  const moduleDir = path.dirname(fileURLToPath(fromModuleUrl));
  const candidates = [
    path.resolve(moduleDir, '../../../prices/price-history.csv'), // dist/src/pricing -> <root>/prices
    path.resolve(moduleDir, '../../prices/price-history.csv'), // src/pricing -> <root>/prices
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** zod-free load of the bundled overlay; empty (not an error) when absent. */
export function loadBundledPriceHistory(): {
  history: PriceHistory;
  warnings: string[];
  path: string;
} {
  const embedded = embeddedPriceHistory();
  if (embedded !== undefined) {
    const { history, warnings } = parsePriceHistory(embedded, 'bundled (embedded)');
    return { history, warnings, path: '(embedded in binary)' };
  }
  const bundledPath = resolveBundledPriceHistoryPath();
  if (bundledPath === null) return { history: new Map(), warnings: [], path: '(none)' };
  let csv: string;
  try {
    csv = readFileSync(bundledPath, 'utf8');
  } catch (err) {
    throw new InternalError(`could not read bundled price history at ${bundledPath}`, err);
  }
  const { history, warnings } = parsePriceHistory(csv, 'bundled');
  return { history, warnings, path: bundledPath };
}

/**
 * Path of the user overlay:
 * (configDir ?? $VIBEBILL_CONFIG_DIR ?? ~/.config)/vibebill/price-history.csv.
 * Mirrors userPricesPath in engine.ts.
 */
function userPriceHistoryPath(configDir?: string): string {
  const base =
    configDir ??
    (process.env['VIBEBILL_CONFIG_DIR'] !== undefined && process.env['VIBEBILL_CONFIG_DIR'] !== ''
      ? process.env['VIBEBILL_CONFIG_DIR']
      : path.join(homedir(), '.config'));
  return path.join(base, 'vibebill', 'price-history.csv');
}

export type PriceHistoryOrigin = 'bundled' | 'user' | 'env' | 'none';

/**
 * Effective price history, with precedence:
 *   $VIBEBILL_PRICE_HISTORY (a direct file, for relocation/tests)
 *   > <configDir>/vibebill/price-history.csv (user overlay)
 *   > bundled prices/price-history.csv.
 * A missing or unreadable file never crashes: it yields an empty overlay with a
 * warning, so pricing always falls back to the flat prices.json cards.
 */
export function loadEffectivePriceHistory(opts?: { configDir?: string }): {
  history: PriceHistory;
  origin: PriceHistoryOrigin;
  path: string;
  warnings: string[];
} {
  const envPath = process.env['VIBEBILL_PRICE_HISTORY'];
  if (envPath !== undefined && envPath !== '') {
    if (!existsSync(envPath)) {
      return {
        history: new Map(),
        origin: 'env',
        path: envPath,
        warnings: [
          `price history $VIBEBILL_PRICE_HISTORY=${envPath} not found; dynamic pricing off`,
        ],
      };
    }
    try {
      const parsed = parsePriceHistory(readFileSync(envPath, 'utf8'), `env ${envPath}`);
      return { history: parsed.history, origin: 'env', path: envPath, warnings: parsed.warnings };
    } catch (err) {
      return {
        history: new Map(),
        origin: 'env',
        path: envPath,
        warnings: [
          `price history $VIBEBILL_PRICE_HISTORY=${envPath} unreadable (${err instanceof Error ? err.message : String(err)}); dynamic pricing off`,
        ],
      };
    }
  }

  const userPath = userPriceHistoryPath(opts?.configDir);
  if (existsSync(userPath)) {
    try {
      const parsed = parsePriceHistory(readFileSync(userPath, 'utf8'), `user ${userPath}`);
      return { history: parsed.history, origin: 'user', path: userPath, warnings: parsed.warnings };
    } catch (err) {
      const bundled = loadBundledPriceHistory();
      return {
        history: bundled.history,
        origin: bundled.history.size === 0 ? 'none' : 'bundled',
        path: bundled.path,
        warnings: [
          `user price history at ${userPath} unreadable (${err instanceof Error ? err.message : String(err)}); using bundled overlay`,
          ...bundled.warnings,
        ],
      };
    }
  }

  const bundled = loadBundledPriceHistory();
  return {
    history: bundled.history,
    origin: bundled.history.size === 0 ? 'none' : 'bundled',
    path: bundled.path,
    warnings: bundled.warnings,
  };
}
