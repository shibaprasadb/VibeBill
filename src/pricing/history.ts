/**
 * Parser/converter for vibebill's static historical pricing CSV.
 * Pure and offline: callers provide CSV text, and this module validates and
 * groups dated price cards without touching the network or filesystem.
 */

import type { PriceCard } from './engine.js';
import { parsePriceToNanoPerMTok } from './money.js';

export interface PriceHistoryRow extends PriceCard {
  modelId: string;
  /** Inclusive UTC date (YYYY-MM-DD) from which this card applies. */
  effectiveFrom: string;
}

export type PriceHistory = Record<string, PriceHistoryRow[]>;

export interface PriceHistoryDocument {
  schemaVersion: 1;
  source: string;
  models: PriceHistory;
}

const REQUIRED_COLUMNS = [
  'modelId',
  'displayName',
  'effectiveFrom',
  'inputPerMTok',
  'outputPerMTok',
  'cacheWritePerMTok',
  'cacheReadPerMTok',
] as const;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else if (ch === '"') {
      quoted = true;
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error('unterminated quoted CSV field');
  out.push(field);
  return out;
}

function assertIsoDate(date: string, label: string): void {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  }
}

function assertPrice(price: string, label: string): void {
  try {
    parsePriceToNanoPerMTok(price);
  } catch (err) {
    throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Parse static historical pricing CSV into per-model rows sorted by effectiveFrom. */
export function parsePriceHistoryCsv(csv: string, sourceLabel = 'price history CSV'): PriceHistory {
  const trimmed = csv.trim();
  if (trimmed === '') return {};

  const [headerLine, ...lines] = trimmed.split(/\r?\n/);
  const headers = parseCsvLine(headerLine ?? '').map((h) => h.trim());
  for (const column of REQUIRED_COLUMNS) {
    if (!headers.includes(column)) {
      throw new Error(`invalid ${sourceLabel}: missing column ${column}`);
    }
  }

  const history: PriceHistory = {};
  const seen = new Set<string>();
  for (const [lineIndex, line] of lines.entries()) {
    const lineNo = lineIndex + 2;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const values = parseCsvLine(line);
    const get = (name: (typeof REQUIRED_COLUMNS)[number]): string =>
      values[headers.indexOf(name)]?.trim() ?? '';
    const row: PriceHistoryRow = {
      modelId: get('modelId'),
      displayName: get('displayName'),
      effectiveFrom: get('effectiveFrom'),
      inputPerMTok: get('inputPerMTok'),
      outputPerMTok: get('outputPerMTok'),
    };
    const where = `invalid ${sourceLabel}:${lineNo}`;
    if (row.modelId === '') throw new Error(`${where}: modelId is required`);
    if (row.displayName === '') throw new Error(`${where}: displayName is required`);
    assertIsoDate(row.effectiveFrom, `${where}: effectiveFrom`);
    assertPrice(row.inputPerMTok, `${where}: inputPerMTok`);
    assertPrice(row.outputPerMTok, `${where}: outputPerMTok`);
    const cacheWrite = get('cacheWritePerMTok');
    const cacheRead = get('cacheReadPerMTok');
    if (cacheWrite !== '') {
      assertPrice(cacheWrite, `${where}: cacheWritePerMTok`);
      row.cacheWritePerMTok = cacheWrite;
    }
    if (cacheRead !== '') {
      assertPrice(cacheRead, `${where}: cacheReadPerMTok`);
      row.cacheReadPerMTok = cacheRead;
    }

    const key = `${row.modelId}\0${row.effectiveFrom}`;
    if (seen.has(key)) {
      throw new Error(
        `${where}: duplicate modelId/effectiveFrom row for ${row.modelId} ${row.effectiveFrom}`,
      );
    }
    seen.add(key);
    (history[row.modelId] ??= []).push(row);
  }

  for (const rows of Object.values(history)) {
    rows.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  }
  return history;
}

export function convertPriceHistoryCsv(csv: string, source: string): PriceHistoryDocument {
  return { schemaVersion: 1, source, models: parsePriceHistoryCsv(csv, source) };
}
