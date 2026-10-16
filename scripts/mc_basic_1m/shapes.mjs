// Pure checks over read_shapes results (design_v14 lines 155, 162, 169-172).
// No file, clock or CDP access: the caller passes the reads, the parsed log and
// the parsed guard in, and gets verdicts back.
//
// A shape is { id, name, pts: [{ time, price }], linecolor, text, stopLevel, profitLevel }.
// Times are unix seconds, prices are numbers on the 0.25 grid.
// Points: pts[0] is the entry point, pts[1] is the second point of a position.

// templates.mjs did not exist when this file was written, so these two mirror its contract
// (api_v1 templates section, design line 155 and line 149). Switch to importing them from
// templates.mjs once it exists, and keep the values equal.
const RUN_COLOURS = Object.freeze({ "HTF-a": "#9c27b0", "HTF-b": "#ff9800", "HTF-c": "#00bcd4" });

// lowercase #rrggbb; rgb() and rgba() with alpha 1 are converted; anything else is null (unknown).
function normalizeColour(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([0-9.]+)\s*)?\)$/.exec(s);
  if (!m) return null;
  const ch = [m[1], m[2], m[3]].map(Number);
  if (ch.some((c) => c > 255)) return null;
  if (m[4] !== undefined && Number(m[4]) !== 1) return null;
  return "#" + ch.map((c) => c.toString(16).padStart(2, "0")).join("");
}

const RUN_NAMES = Object.keys(RUN_COLOURS);
const RUN_HEX = new Set(Object.values(RUN_COLOURS).map((c) => normalizeColour(c)));
const POSITION_NAMES = ["long_position", "short_position"];
const TEXT_NAME = "text";

function isObj(x) {
  return x !== null && typeof x === "object";
}

// colour_ok union of the log and guard (design line 155): a log.bak restore cannot drop an ID.
function exemptIds(log, guard) {
  const out = new Set();
  for (const src of [log, guard]) {
    if (isObj(src) && Array.isArray(src.colour_ok)) {
      for (const id of src.colour_ok) out.add(id);
    }
  }
  return out;
}

function recordsOf(log) {
  if (!isObj(log) || !isObj(log.records)) return [];
  return Object.values(log.records).filter(isObj);
}

function isLive(rec) {
  return rec.state === "pending" || rec.state === "drawn";
}

function positionName(side) {
  if (side === "long") return "long_position";
  if (side === "short") return "short_position";
  return null;
}

function firstPoint(s) {
  return Array.isArray(s.pts) && s.pts.length > 0 && isObj(s.pts[0]) ? s.pts[0] : null;
}

function pointIs(pt, time, price) {
  return pt !== null && pt.time === time && pt.price === price;
}

// want: array of { time, price }; pts must have the same length and match in order.
function pointsEqual(pts, want) {
  if (!Array.isArray(pts) || pts.length !== want.length) return false;
  for (let i = 0; i < want.length; i++) {
    if (!isObj(want[i]) || !isObj(pts[i])) return false;
    if (pts[i].time !== want[i].time || pts[i].price !== want[i].price) return false;
  }
  return true;
}

function isBacktestLabel(s) {
  return (
    s.name === TEXT_NAME &&
    typeof s.text === "string" &&
    RUN_NAMES.some((run) => s.text.startsWith(`${run} BACKTEST`))
  );
}

// A position with the record's shape name and entry point, in any colour (design lines 171-172).
function atEntry(s, rec) {
  return s.name === positionName(rec.side) && pointIs(firstPoint(s), rec.entry_time, rec.entry_price);
}

// A text label anchored where the record's text was placed.
function atTextPoint(s, rec) {
  return s.name === TEXT_NAME && pointIs(firstPoint(s), rec.text_time, rec.text_price);
}

function describe(s, extra) {
  return { id: s.id, name: s.name, pts: s.pts, linecolor: s.linecolor, text: s.text, ...extra };
}

// Design line 155. Returns { unknown, blocking, labels }.
//  unknown:  non-exempt shapes whose linecolor does not normalize (any colour format other than #rrggbb, rgb(), rgba() alpha 1).
//  blocking: every non-exempt shape that stops the draw: a run colour that is not a pending or drawn position of runId, an unknown colour, or an unstored BACKTEST label.
//  labels:   BACKTEST labels whose ID is not the text ID of a pending or drawn record (any run).
export function colourScan({ shapes, log, guard, runId }) {
  const exempt = exemptIds(log, guard);
  const ownPositions = new Set();
  const storedText = new Set();
  for (const rec of recordsOf(log)) {
    if (!isLive(rec)) continue;
    if (rec.text_id != null) storedText.add(rec.text_id);
    if (runId != null && rec.run === runId && rec.position_id != null) ownPositions.add(rec.position_id);
  }

  const unknown = [];
  const blocking = [];
  const labels = [];
  for (const s of Array.isArray(shapes) ? shapes : []) {
    if (!isObj(s) || exempt.has(s.id)) continue;
    const reasons = [];
    const norm = normalizeColour(s.linecolor);
    if (norm === null) {
      reasons.push("unknown colour");
      unknown.push(describe(s));
    } else if (RUN_HEX.has(norm) && !ownPositions.has(s.id)) {
      reasons.push("run colour");
    }
    if (isBacktestLabel(s) && !storedText.has(s.id)) {
      reasons.push("unstored BACKTEST label");
      labels.push(describe(s));
    }
    if (reasons.length > 0) blocking.push(describe(s, { reasons }));
  }
  return { unknown, blocking, labels };
}

// Design line 172: a cleared record's position still on tab 1 with its name and entry point
// blocks the draw in any colour; the same ID with other attributes is reported only.
export function clearedRecordCheck({ shapes, log, guard }) {
  const exempt = exemptIds(log, guard);
  const byId = new Map();
  for (const s of Array.isArray(shapes) ? shapes : []) {
    if (isObj(s) && !byId.has(s.id)) byId.set(s.id, s);
  }
  const blocking = [];
  const reported = [];
  for (const rec of recordsOf(log)) {
    if (rec.state !== "cleared" || rec.position_id == null || exempt.has(rec.position_id)) continue;
    const s = byId.get(rec.position_id);
    if (!s) continue;
    if (atEntry(s, rec)) blocking.push(describe(s, { key: rec.key }));
    else reported.push(describe(s, { key: rec.key }));
  }
  return { blocking, reported };
}

// Design line 171: refuses while any stored position or text ID of runId is still on tab 1 with
// the record's shape name and point (any colour). Reports, without refusing, every run-colour
// shape and every unstored BACKTEST label, and stored IDs with other attributes.
export function clearCheck({ shapes, runId, log, guard }) {
  const exempt = exemptIds(log, guard);
  const byId = new Map();
  for (const s of Array.isArray(shapes) ? shapes : []) {
    if (isObj(s) && !byId.has(s.id)) byId.set(s.id, s);
  }
  const storedText = new Set();
  for (const rec of recordsOf(log)) {
    if (isLive(rec) && rec.text_id != null) storedText.add(rec.text_id);
  }

  const blocking = [];
  const blockingIds = new Set();
  const reportedMap = new Map();
  const report = (s, extra) => {
    if (!blockingIds.has(s.id) && !reportedMap.has(s.id)) reportedMap.set(s.id, describe(s, extra));
  };
  const block = (s, extra) => {
    blocking.push(describe(s, extra));
    blockingIds.add(s.id);
  };

  for (const rec of recordsOf(log)) {
    if (rec.run !== runId) continue;
    for (const [id, matches] of [
      [rec.position_id, atEntry],
      [rec.text_id, atTextPoint],
    ]) {
      if (id == null || exempt.has(id)) continue;
      const s = byId.get(id);
      if (!s) continue;
      if (matches(s, rec)) block(s, { key: rec.key });
      else report(s, { key: rec.key });
    }
  }

  const inRunColour = [];
  for (const s of Array.isArray(shapes) ? shapes : []) {
    if (!isObj(s) || exempt.has(s.id)) continue;
    const norm = normalizeColour(s.linecolor);
    if (norm !== null && RUN_HEX.has(norm)) inRunColour.push(s);
    if (isBacktestLabel(s) && !storedText.has(s.id)) report(s, {});
  }
  for (const s of inRunColour) report(s, {});

  const reported = [...reportedMap.values()].filter((d) => !blockingIds.has(d.id));
  return { blocking, reported };
}

// Design line 169-170: both reads must be arrays with the same set of IDs. An empty read
// fails unless chartEmptyOk. A throwing read must reach here as null (the caller catches it).
export function loadingTest(read1, read2, chartEmptyOk) {
  if (!Array.isArray(read1) || !Array.isArray(read2)) {
    return { ok: false, reason: "a read failed or returned no shape list" };
  }
  const a = new Set(read1.map((s) => (isObj(s) ? s.id : undefined)));
  const b = new Set(read2.map((s) => (isObj(s) ? s.id : undefined)));
  if (a.size !== b.size || [...a].some((id) => !b.has(id))) {
    return { ok: false, reason: "the two reads differ in their set of shape IDs" };
  }
  if (a.size === 0) {
    if (chartEmptyOk) return { ok: true, reason: "empty chart, allowed by --chart-empty-ok" };
    return { ok: false, reason: "the chart read is empty (pass --chart-empty-ok only if the user says tab 1 shows no drawings)" };
  }
  return { ok: true, reason: "two equal reads" };
}

// Design line 162. Reads are checked twice; decides only when both reads agree on one exact
// position and one exact text. IDs stored in other records or in colour_ok are ignored.
export function matchResolve({ record, read1, read2, log, guard }) {
  const ignored = exemptIds(log, guard);
  for (const other of recordsOf(log)) {
    if (other.key === record.key) continue;
    if (other.position_id != null) ignored.add(other.position_id);
    if (other.text_id != null) ignored.add(other.text_id);
  }

  const readsOk = Array.isArray(read1) && Array.isArray(read2);
  const perRead = [[], []];
  const candidates = [];
  [read1, read2].forEach((read, i) => {
    if (!Array.isArray(read)) return;
    for (const s of read) {
      if (!isObj(s) || s.id == null || ignored.has(s.id)) continue;
      const found = candidateOf(s, record);
      if (found === null) continue;
      const cand = { read: i + 1, kind: found.kind, exact: found.exact, id: s.id, name: s.name, pts: s.pts, linecolor: s.linecolor, text: s.text };
      perRead[i].push(cand);
      candidates.push(cand);
    }
  });

  const anyPosition = candidates.some((c) => c.kind === "position");
  const sawPosition = record.seen_position === true || anyPosition;

  if (readsOk && candidates.length === 0) {
    return { verdict: "not drawn", position_id: null, text_id: null, candidates, saw_position: record.seen_position === true };
  }

  const exactOne = (list, kind) => {
    const all = list.filter((c) => c.kind === kind);
    const exact = all.filter((c) => c.exact);
    return all.length === 1 && exact.length === 1 ? exact[0] : null;
  };
  if (readsOk) {
    const pos1 = exactOne(perRead[0], "position");
    const txt1 = exactOne(perRead[0], "text");
    const pos2 = exactOne(perRead[1], "position");
    const txt2 = exactOne(perRead[1], "text");
    if (pos1 && txt1 && pos2 && txt2 && pos1.id === pos2.id && txt1.id === txt2.id) {
      return { verdict: "drawn", position_id: pos1.id, text_id: txt1.id, candidates, saw_position: sawPosition };
    }
  }
  return { verdict: "undecided", position_id: null, text_id: null, candidates, saw_position: sawPosition };
}

// Returns null when the shape is not a candidate for this record, else { kind, exact }.
function candidateOf(s, rec) {
  if (POSITION_NAMES.includes(s.name) && pointIs(firstPoint(s), rec.entry_time, rec.entry_price)) {
    const want = normalizeColour(RUN_COLOURS[rec.run]);
    const exact =
      s.name === positionName(rec.side) &&
      pointsEqual(s.pts, [rec.p1, rec.p2]) &&
      s.stopLevel === rec.stop_level &&
      s.profitLevel === rec.profit_level &&
      want !== null &&
      normalizeColour(s.linecolor) === want;
    return { kind: "position", exact };
  }
  const pt = firstPoint(s);
  if (s.name === TEXT_NAME && pt !== null && pt.time === rec.text_time && typeof s.text === "string" && s.text.startsWith(`${rec.run} BACKTEST`)) {
    const exact = pointIs(pt, rec.text_time, rec.text_price) && s.text === rec.text;
    return { kind: "text", exact };
  }
  return null;
}
