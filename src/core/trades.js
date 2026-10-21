/**
 * Paper-trading CSV export parsing and trade-to-drawing planning.
 * Pure: no CDP, no network. Reads files only in findExport().
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── CSV ──────────────────────────────────────────────────────────────────

/** Parse RFC 4180 CSV text into objects keyed by the header row. */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); records.push(row); row = []; field = '';
      i += (c === '\r' && src[i + 1] === '\n') ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); records.push(row); }

  const [header, ...body] = records;
  if (!header) return [];
  return body
    .filter(r => !(r.length === 1 && r[0] === ''))
    .map(r => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ''])));
}

// ── Time ─────────────────────────────────────────────────────────────────

const LOCAL_TS_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** 'YYYY-MM-DD HH:MM:SS' in the process's local timezone → unix seconds. */
export function localToUnix(str) {
  const m = typeof str === 'string' ? LOCAL_TS_RE.exec(str) : null;
  if (!m) throw new Error(`Malformed local time: ${JSON.stringify(str)}`);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  // Date rolls 2026-02-30 over to March; reject instead.
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59
    || date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
    throw new Error(`Malformed local time: ${JSON.stringify(str)}`);
  }
  return Math.floor(date.getTime() / 1000);
}

/** Unix seconds → 'YYYY-MM-DD HH:MM:SS' in the process's local timezone. */
export function unixToLocal(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── Export discovery ─────────────────────────────────────────────────────

export const EXPORT_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}$/;
const ORDER_FILE_RE = /^paper-trading-order-history-all-(\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2})\.\d{3}Z_[0-9a-z]+\.csv$/;
const BALANCE_FILE_RE = /^paper-trading-balance-history-(\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2})\.\d{3}Z_[0-9a-z]+\.csv$/;
const POSITIONS_FILE_RE = /^paper-trading-positions-(\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2})\.\d{3}Z_[0-9a-z]+\.csv$/;

/**
 * Locate the order-history and balance-history files of one export in `dir`.
 * The export id is the shared YYYY-MM-DDTHH_MM_SS prefix; milliseconds and
 * the random suffix differ per file. Only file names are matched, so the
 * caller can never steer this outside `dir`.
 */
export function findExport({ dir = join(homedir(), 'Downloads'), exportTimestamp } = {}) {
  if (exportTimestamp !== undefined && !(typeof exportTimestamp === 'string' && EXPORT_TS_RE.test(exportTimestamp))) {
    throw new Error(`Invalid export timestamp ${JSON.stringify(exportTimestamp)}; expected YYYY-MM-DDTHH_MM_SS`);
  }
  const names = readdirSync(dir).sort();
  const orderById = new Map();
  const balanceById = new Map();
  const positionsById = new Map();
  for (const name of names) {
    let m = ORDER_FILE_RE.exec(name);
    if (m) { orderById.set(m[1], name); continue; }
    m = BALANCE_FILE_RE.exec(name);
    if (m) { balanceById.set(m[1], name); continue; }
    m = POSITIONS_FILE_RE.exec(name);
    if (m) positionsById.set(m[1], name);
  }
  if (!orderById.size) throw new Error(`No paper-trading order history export found in ${dir}`);

  const id = exportTimestamp ?? [...orderById.keys()].sort().at(-1);
  if (!orderById.has(id)) throw new Error(`Order history for export ${id} not found in ${dir}`);
  if (!balanceById.has(id)) throw new Error(`Balance history for export ${id} not found in ${dir}`);
  return {
    export_timestamp: id,
    order_history_path: join(dir, orderById.get(id)),
    balance_history_path: join(dir, balanceById.get(id)),
    positions_path: positionsById.has(id) ? join(dir, positionsById.get(id)) : null,
  };
}

/**
 * Net signed quantity per symbol from a positions export, or null when a row
 * lacks a readable Symbol, Side and Qty (the column names of a non-empty
 * positions export are unverified). An empty export means flat everywhere.
 */
export function netFromPositions(rows) {
  const net = {};
  for (const r of rows) {
    const qty = num(r['Qty'] ?? r['Quantity']);
    const side = String(r['Side'] ?? '').toLowerCase();
    if (!r['Symbol'] || qty === null || !/^(buy|long|sell|short)$/.test(side)) return null;
    net[r['Symbol']] = (net[r['Symbol']] ?? 0) + (/^(buy|long)$/.test(side) ? qty : -qty);
  }
  return net;
}

// ── Fills ────────────────────────────────────────────────────────────────

/** Number from a CSV cell ('5,823.94 USD' → 5823.94); null when blank or unparseable. */
function num(v) {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Turn order-history and balance-history rows into one drawable fill per
 * filled entry order.
 *
 * An entry is a Filled order with a Leverage value. Its bracket is the
 * opposite-side Stop and Limit orders sharing its (symbol, Placing time).
 * When several entries share that second, a bracket is linked only by a
 * non-empty Level ID that the entry and its bracket share with no other entry;
 * otherwise the entry is skipped as 'ambiguous bracket'.
 * Exit times come from replaying every Filled order per symbol: when the net
 * position returns to zero or flips, all open entries exit at that fill.
 *
 * TradingView caps the order history, so it can start partway through a
 * position. When netAtExport (symbol → signed qty held at export) is given,
 * the replay starts each symbol at netAtExport minus the sum of its fills;
 * otherwise it starts flat. A bracketed order that only shrinks the position
 * is a close, not an entry.
 */
export function buildFills({ orders, balances, exportTime, netAtExport }) {
  // CSV is newest first; a higher row index is earlier in the export.
  const rows = orders.map((o, idx) => ({ o, idx }));

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.o['Symbol']}\u0000${r.o['Placing time']}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const lvl = (o) => String(o['Level ID'] ?? '').trim();
  const entries = new Map(); // row idx → { r, stop, target, ambiguous }
  for (const group of groups.values()) {
    const groupEntries = group.filter(r => r.o['Status'] === 'Filled' && r.o['Leverage']);
    for (const r of groupEntries) {
      const opposite = r.o['Side'] === 'Buy' ? 'Sell' : 'Buy';
      let stops = group.filter(g => g.o['Side'] === opposite && g.o['Type'] === 'Stop');
      let targets = group.filter(g => g.o['Side'] === opposite && g.o['Type'] === 'Limit');
      let ambiguous = false;
      if (groupEntries.length > 1) {
        const key = lvl(r.o);
        const linked = key !== '' && groupEntries.filter(e => lvl(e.o) === key).length === 1;
        ambiguous = !linked && stops.length + targets.length > 0;
        stops = linked ? stops.filter(g => lvl(g.o) === key) : [];
        targets = linked ? targets.filter(g => lvl(g.o) === key) : [];
      }
      ambiguous = ambiguous || stops.length > 1 || targets.length > 1;
      entries.set(r.idx, {
        r,
        stop: stops.length === 1 ? num(stops[0].o['Stop price']) : null,
        target: targets.length === 1 ? num(targets[0].o['Limit price']) : null,
        ambiguous,
      });
    }
  }

  // Replay filled orders per symbol to find exit times.
  const exitByIdx = new Map();
  const filled = rows
    .filter(r => r.o['Status'] === 'Filled')
    .map(r => ({ ...r, t: localToUnix(r.o['Closing time']) }))
    .sort((a, b) => a.t - b.t || b.idx - a.idx);
  const signedQty = (r) => (r.o['Side'] === 'Buy' ? 1 : -1) * (num(r.o['Quantity']) ?? 0);
  // Round sums so fractional fills (0.1 + 0.2 - 0.3) net to exactly 0.
  const roundQty = (x) => Math.round(x * 1e9) / 1e9;
  const startNet = new Map();
  if (netAtExport) {
    for (const r of filled) {
      const sym = r.o['Symbol'];
      startNet.set(sym, roundQty((startNet.get(sym) ?? (netAtExport[sym] ?? 0)) - signedQty(r)));
    }
  }
  const closes = [];
  const bySymbol = new Map();
  for (const r of filled) {
    const sym = r.o['Symbol'];
    if (!bySymbol.has(sym)) bySymbol.set(sym, { net: startNet.get(sym) ?? 0, open: [] });
    const pos = bySymbol.get(sym);
    const prev = pos.net;
    pos.net = roundQty(prev + signedQty(r));
    if (prev !== 0 && (pos.net === 0 || Math.sign(pos.net) !== Math.sign(prev))) {
      for (const idx of pos.open) exitByIdx.set(idx, r.t);
      pos.open = [];
    }
    if (!entries.has(r.idx)) continue;
    if (prev !== 0 && Math.abs(pos.net) < Math.abs(prev) && Math.sign(pos.net) !== -Math.sign(prev)) {
      entries.delete(r.idx);
      closes.push(r.o['Order ID']);
    } else {
      pos.open.push(r.idx);
    }
  }

  // Balance rows, oldest first (export order breaks same-second ties).
  const bal = balances
    .map((b, idx) => ({ b, idx, t: localToUnix(b['Time']) }))
    .sort((a, b) => a.t - b.t || b.idx - a.idx);
  const pointValue = (symbol) => {
    for (let i = bal.length - 1; i >= 0; i--) {
      const action = bal[i].b['Action'] || '';
      if (/symbol (\S+)/.exec(action)?.[1] !== symbol) continue;
      const m = /point value: ([\d.]+)/.exec(action);
      if (m) return Number(m[1]);
    }
    return null;
  };
  const accountSize = (t) => {
    if (!bal.length) return null;
    for (let i = bal.length - 1; i >= 0; i--) {
      if (bal[i].t <= t) return num(bal[i].b['Balance after']);
    }
    return num(bal[0].b['Balance before']);
  };

  const fills = [];
  const skipped = closes.map(order_id => ({ order_id, reason: 'closes position' }));
  const ordered = [...entries.values()]
    .map(e => ({ ...e, t: localToUnix(e.r.o['Closing time']) }))
    .sort((a, b) => a.t - b.t || b.r.idx - a.r.idx);
  const positive = (x) => x !== null && x > 0;
  for (const { r, stop, target, ambiguous, t } of ordered) {
    const o = r.o;
    if (ambiguous) {
      skipped.push({ order_id: o['Order ID'], reason: 'ambiguous bracket' });
      continue;
    }
    if (stop === null || target === null) {
      skipped.push({ order_id: o['Order ID'], reason: 'no bracket' });
      continue;
    }
    // Blank, whitespace, unparseable and zero values never reach a drawing.
    const qty = num(o['Quantity']);
    const entryPrice = num(o['Fill price']);
    if (!positive(entryPrice)) {
      skipped.push({ order_id: o['Order ID'], reason: 'missing or invalid fill price' });
      continue;
    }
    if (!positive(qty)) {
      skipped.push({ order_id: o['Order ID'], reason: 'missing or invalid quantity' });
      continue;
    }
    const exit = exitByIdx.get(r.idx);
    fills.push({
      order_id: o['Order ID'],
      symbol: o['Symbol'],
      side: o['Side'] === 'Buy' ? 'long' : 'short',
      qty,
      entry_price: entryPrice,
      entry_time: t,
      stop,
      target,
      exit_time: exit ?? exportTime,
      open_at_export: exit === undefined,
      point_value: pointValue(o['Symbol']),
      account_size: accountSize(t),
    });
  }
  return { fills, skipped };
}

// ── Drawing plan ─────────────────────────────────────────────────────────

/** Map a fill to the parameters of a TradingView long/short position drawing. */
export function planPosition(fill, { tick, minWidthSec = 300 } = {}) {
  if (typeof tick !== 'number' || !Number.isFinite(tick) || tick <= 0) {
    throw new Error(`tick must be a positive finite number, got ${String(tick)}`);
  }
  const risk = Math.abs(fill.entry_price - fill.stop);
  return {
    shape: fill.side === 'long' ? 'long_position' : 'short_position',
    entry_time: fill.entry_time,
    end_time: Math.max(fill.exit_time, fill.entry_time + minWidthSec),
    entry_price: fill.entry_price,
    stop_ticks: Math.round(risk / tick),
    profit_ticks: Math.round(Math.abs(fill.target - fill.entry_price) / tick),
    risk_amount: fill.point_value == null ? null : fill.qty * risk * fill.point_value,
    account_size: fill.account_size,
  };
}

/** True if a position drawing with the same shape, bar and entry price already exists. */
export function isDuplicate(plan, existing, barSec = 60) {
  const bar = Math.floor(plan.entry_time / barSec);
  return existing.some(e =>
    e.shape === plan.shape
    && Math.floor(e.time / barSec) === bar
    && Math.abs(e.price - plan.entry_price) < 1e-6);
}
