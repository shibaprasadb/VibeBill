/** Convert the checked-in historical pricing CSV into the JSON bundled at runtime. */

import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const csvPath = path.join(root, 'prices', 'prices-history.csv');
const jsonPath = path.join(root, 'prices', 'prices-history.json');
const columns = [
  'modelId',
  'displayName',
  'effectiveFrom',
  'inputPerMTok',
  'outputPerMTok',
  'cacheWritePerMTok',
  'cacheReadPerMTok',
];

function parseCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else if (ch === '"') quoted = true;
    else field += ch;
  }
  if (quoted) throw new Error('unterminated quoted CSV field');
  out.push(field);
  return out;
}

function parsePrice(s) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(s))
    throw new Error(`invalid price ${JSON.stringify(s)}`);
}

const [headerLine, ...lines] = readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
const headers = parseCsvLine(headerLine ?? '').map((h) => h.trim());
for (const c of columns) if (!headers.includes(c)) throw new Error(`missing column ${c}`);
const get = (values, name) => values[headers.indexOf(name)]?.trim() ?? '';
const models = {};
const seen = new Set();
for (const [idx, line] of lines.entries()) {
  if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
  const values = parseCsvLine(line);
  const row = {
    modelId: get(values, 'modelId'),
    displayName: get(values, 'displayName'),
    effectiveFrom: get(values, 'effectiveFrom'),
    inputPerMTok: get(values, 'inputPerMTok'),
    outputPerMTok: get(values, 'outputPerMTok'),
  };
  const lineNo = idx + 2;
  if (row.modelId === '' || row.displayName === '')
    throw new Error(`invalid row ${lineNo}: ids are required`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(row.effectiveFrom) ||
    Number.isNaN(Date.parse(`${row.effectiveFrom}T00:00:00.000Z`))
  ) {
    throw new Error(`invalid row ${lineNo}: effectiveFrom must be YYYY-MM-DD`);
  }
  parsePrice(row.inputPerMTok);
  parsePrice(row.outputPerMTok);
  const cacheWrite = get(values, 'cacheWritePerMTok');
  const cacheRead = get(values, 'cacheReadPerMTok');
  if (cacheWrite !== '') {
    parsePrice(cacheWrite);
    row.cacheWritePerMTok = cacheWrite;
  }
  if (cacheRead !== '') {
    parsePrice(cacheRead);
    row.cacheReadPerMTok = cacheRead;
  }
  const key = `${row.modelId}\0${row.effectiveFrom}`;
  if (seen.has(key)) throw new Error(`duplicate modelId/effectiveFrom at row ${lineNo}`);
  seen.add(key);
  (models[row.modelId] ??= []).push(row);
}
for (const rows of Object.values(models))
  rows.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
writeFileSync(
  jsonPath,
  `${JSON.stringify({ schemaVersion: 1, source: 'prices/prices-history.csv', models }, null, 2)}\n`,
);
