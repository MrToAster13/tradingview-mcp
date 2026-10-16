import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadingTest,
  colourScan,
  clearedRecordCheck,
  matchResolve,
  clearCheck,
} from "./shapes.mjs";

const RUN = "HTF-a";
const KEY = "HTF-a:1:0:1000:1";

function rec(over = {}) {
  return {
    key: KEY,
    run: RUN,
    cycle: 1,
    index: 0,
    attempt: 1,
    snapshot_sha256: "abc",
    side: "long",
    entry_time: 1000,
    entry_price: 5000,
    p1: { time: 1000, price: 5000 },
    p2: { time: 2000, price: 4990 },
    stop: 4990,
    target: 5020,
    text: "HTF-a BACKTEST UNVERIFIED",
    text_time: 1000,
    text_price: 5010,
    stop_level: 40,
    profit_level: 80,
    deadline: 0,
    pre_draw_ids: [],
    position_id: null,
    text_id: null,
    state: "pending",
    mismatch: false,
    seen_position: false,
    written_at: 0,
    ...over,
  };
}

function logWith(records, colourOk = []) {
  const map = {};
  for (const r of records) map[r.key] = r;
  return { version: 1, reset_count: 0, probes: [], records: map, last_shown: null, colour_ok: colourOk, consumed_flags: [] };
}

function guardWith(colourOk = []) {
  return { broker_check: "none", baseline_count: null, probe_key: null, count_refused: false, reset_count: 0, colour_ok: colourOk, consumed_flags: [], draw_mismatches: [], lost_at: null, reset_stamps: [] };
}

function posShape(id, over = {}) {
  return {
    id,
    name: "long_position",
    pts: [
      { time: 1000, price: 5000 },
      { time: 2000, price: 4990 },
    ],
    linecolor: "#9c27b0",
    text: null,
    stopLevel: 40,
    profitLevel: 80,
    ...over,
  };
}

function textShape(id, over = {}) {
  return {
    id,
    name: "text",
    pts: [{ time: 1000, price: 5010 }],
    linecolor: "#ffffff",
    text: "HTF-a BACKTEST UNVERIFIED",
    stopLevel: null,
    profitLevel: null,
    ...over,
  };
}

// ---------- loadingTest (design lines 155, 170) ----------

test("loadingTest: two equal reads pass", () => {
  const r = loadingTest([posShape(1), textShape(2)], [textShape(2), posShape(1)], false);
  assert.equal(r.ok, true);
});

test("loadingTest: different ID sets fail", () => {
  const r = loadingTest([posShape(1)], [posShape(1), posShape(3)], false);
  assert.equal(r.ok, false);
  const r2 = loadingTest([posShape(1)], [posShape(2)], false);
  assert.equal(r2.ok, false);
});

test("loadingTest: a null or error-string read fails", () => {
  assert.equal(loadingTest(null, [posShape(1)], false).ok, false);
  assert.equal(loadingTest([posShape(1)], undefined, false).ok, false);
  assert.equal(loadingTest("E_SHAPE", "E_SHAPE", false).ok, false);
  assert.equal(loadingTest("E_SHAPE", "E_SHAPE", true).ok, false);
});

test("loadingTest: empty reads fail without chartEmptyOk and pass with it", () => {
  assert.equal(loadingTest([], [], false).ok, false);
  assert.equal(loadingTest([], [], true).ok, true);
});

test("loadingTest: one empty read and one non-empty read fail even with chartEmptyOk", () => {
  assert.equal(loadingTest([], [posShape(1)], true).ok, false);
  assert.equal(loadingTest([posShape(1)], [], true).ok, false);
});

// ---------- colourScan (design line 155) ----------

test("colourScan: a run-coloured shape that no pending or drawn record owns blocks", () => {
  const shapes = [posShape(77)];
  const r = colourScan({ shapes, log: logWith([]), guard: guardWith(), runId: RUN });
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].id, 77);
  assert.ok(r.blocking[0].reasons.includes("run colour"));
  assert.equal(r.unknown.length, 0);
});

test("colourScan: colour_ok in the guard exempts a run-coloured shape", () => {
  const r = colourScan({ shapes: [posShape(77)], log: logWith([]), guard: guardWith([77]), runId: RUN });
  assert.equal(r.blocking.length, 0);
});

test("colourScan: colour_ok in the log exempts a run-coloured shape", () => {
  const r = colourScan({ shapes: [posShape(77)], log: logWith([], [77]), guard: guardWith(), runId: RUN });
  assert.equal(r.blocking.length, 0);
});

test("colourScan: the pending position of the run being drawn is not blocking", () => {
  const r0 = rec({ state: "pending", position_id: 77 });
  const r = colourScan({ shapes: [posShape(77)], log: logWith([r0]), guard: guardWith(), runId: RUN });
  assert.equal(r.blocking.length, 0);
});

test("colourScan: a position of another run's record does not exempt for the run being drawn", () => {
  const other = rec({ key: "HTF-b:1:0:1000:1", run: "HTF-b", state: "drawn", position_id: 77 });
  const r = colourScan({ shapes: [posShape(77)], log: logWith([other]), guard: guardWith(), runId: RUN });
  assert.equal(r.blocking.length, 1);
});

test("colourScan: an unknown colour format is unknown and blocks; colour_ok exempts it", () => {
  const odd = posShape(5, { linecolor: "hsl(0, 0%, 0%)" });
  const r = colourScan({ shapes: [odd], log: logWith([]), guard: guardWith(), runId: RUN });
  assert.equal(r.unknown.length, 1);
  assert.equal(r.blocking.length, 1);
  assert.ok(r.blocking[0].reasons.includes("unknown colour"));
  const ok = colourScan({ shapes: [odd], log: logWith([], [5]), guard: guardWith(), runId: RUN });
  assert.equal(ok.unknown.length, 0);
  assert.equal(ok.blocking.length, 0);
});

test("colourScan: rgb() and uppercase hex of a run colour normalize to the run colour and block", () => {
  const a = posShape(1, { linecolor: "rgb(156, 39, 176)" });
  const b = posShape(2, { linecolor: "#FF9800" });
  const r = colourScan({ shapes: [a, b], log: logWith([]), guard: guardWith(), runId: RUN });
  assert.deepEqual(r.blocking.map((s) => s.id).sort(), [1, 2]);
});

test("colourScan: a user shape in a non-run colour with a valid format is ignored", () => {
  const r = colourScan({ shapes: [posShape(9, { linecolor: "#123456" })], log: logWith([]), guard: guardWith(), runId: RUN });
  assert.equal(r.blocking.length, 0);
  assert.equal(r.unknown.length, 0);
});

test("colourScan: an unstored BACKTEST label blocks and is listed in labels", () => {
  const label = textShape(40);
  const r = colourScan({ shapes: [label], log: logWith([]), guard: guardWith(), runId: RUN });
  assert.equal(r.labels.length, 1);
  assert.equal(r.labels[0].id, 40);
  assert.equal(r.blocking.length, 1);
});

test("colourScan: a BACKTEST label stored as the text ID of a drawn record of any run is not a ghost", () => {
  const other = rec({ key: "HTF-c:1:0:1000:1", run: "HTF-c", state: "drawn", text_id: 40, text: "HTF-c BACKTEST" });
  const r = colourScan({ shapes: [textShape(40)], log: logWith([other]), guard: guardWith(), runId: RUN });
  assert.equal(r.labels.length, 0);
  assert.equal(r.blocking.length, 0);
});

test("colourScan: a label stored only by a cleared record is still a ghost", () => {
  const cleared = rec({ state: "cleared", text_id: 40 });
  const r = colourScan({ shapes: [textShape(40)], log: logWith([cleared]), guard: guardWith(), runId: RUN });
  assert.equal(r.labels.length, 1);
});

test("colourScan: colour_ok exempts a ghost label", () => {
  const r = colourScan({ shapes: [textShape(40)], log: logWith([], [40]), guard: guardWith(), runId: RUN });
  assert.equal(r.labels.length, 0);
  assert.equal(r.blocking.length, 0);
});

// ---------- clearedRecordCheck (design line 172) ----------

test("clearedRecordCheck: a cleared record's position still on the chart with its name and entry blocks, in any colour", () => {
  const cleared = rec({ state: "cleared", position_id: 77 });
  const shape = posShape(77, { linecolor: "#00ff00" });
  const r = clearedRecordCheck({ shapes: [shape], log: logWith([cleared]), guard: guardWith() });
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].id, 77);
  assert.equal(r.reported.length, 0);
});

test("clearedRecordCheck: the same ID with other attributes is reported, not blocking", () => {
  const cleared = rec({ state: "cleared", position_id: 77 });
  const shape = posShape(77, { pts: [{ time: 1000, price: 5001 }, { time: 2000, price: 4990 }] });
  const r = clearedRecordCheck({ shapes: [shape], log: logWith([cleared]), guard: guardWith() });
  assert.equal(r.blocking.length, 0);
  assert.equal(r.reported.length, 1);
});

test("clearedRecordCheck: colour_ok exempts the cleared position", () => {
  const cleared = rec({ state: "cleared", position_id: 77 });
  const r = clearedRecordCheck({ shapes: [posShape(77)], log: logWith([cleared], [77]), guard: guardWith() });
  assert.equal(r.blocking.length, 0);
  assert.equal(r.reported.length, 0);
  const r2 = clearedRecordCheck({ shapes: [posShape(77)], log: logWith([cleared]), guard: guardWith([77]) });
  assert.equal(r2.blocking.length, 0);
});

test("clearedRecordCheck: a shape that is gone or a non-cleared record is not checked", () => {
  const cleared = rec({ state: "cleared", position_id: 77 });
  assert.deepEqual(clearedRecordCheck({ shapes: [], log: logWith([cleared]), guard: guardWith() }), { blocking: [], reported: [] });
  const drawn = rec({ state: "drawn", position_id: 77 });
  assert.equal(clearedRecordCheck({ shapes: [posShape(77)], log: logWith([drawn]), guard: guardWith() }).blocking.length, 0);
});

// ---------- clearCheck (design line 171) ----------

test("clearCheck: a stored position of the run still on tab 1 with its name and entry refuses", () => {
  const drawn = rec({ state: "drawn", position_id: 77, text_id: 78 });
  const r = clearCheck({ shapes: [posShape(77), textShape(78)], runId: RUN, log: logWith([drawn]), guard: guardWith() });
  assert.deepEqual(r.blocking.map((s) => s.id).sort(), [77, 78]);
});

test("clearCheck: a stored ID that is gone does not refuse", () => {
  const drawn = rec({ state: "drawn", position_id: 77, text_id: 78 });
  const r = clearCheck({ shapes: [], runId: RUN, log: logWith([drawn]), guard: guardWith() });
  assert.equal(r.blocking.length, 0);
  assert.equal(r.reported.length, 0);
});

test("clearCheck: a stored ID with other attributes is reported, not refused", () => {
  const drawn = rec({ state: "drawn", position_id: 77 });
  const shape = posShape(77, { name: "short_position" });
  const r = clearCheck({ shapes: [shape], runId: RUN, log: logWith([drawn]), guard: guardWith() });
  assert.equal(r.blocking.length, 0);
  assert.deepEqual(r.reported.map((s) => s.id), [77]);
});

test("clearCheck: colour_ok exempts stored IDs", () => {
  const drawn = rec({ state: "drawn", position_id: 77 });
  const r = clearCheck({ shapes: [posShape(77)], runId: RUN, log: logWith([drawn], [77]), guard: guardWith() });
  assert.equal(r.blocking.length, 0);
  assert.equal(r.reported.length, 0);
});

test("clearCheck: run-coloured shapes and unstored BACKTEST labels are reported without refusing", () => {
  const r = clearCheck({
    shapes: [posShape(90), textShape(91)],
    runId: RUN,
    log: logWith([]),
    guard: guardWith(),
  });
  assert.equal(r.blocking.length, 0);
  assert.deepEqual(r.reported.map((s) => s.id).sort(), [90, 91]);
});

test("clearCheck: a run colour shape is reported once even when it is also a stored position", () => {
  const drawn = rec({ state: "drawn", position_id: 77 });
  const r = clearCheck({ shapes: [posShape(77)], runId: RUN, log: logWith([drawn]), guard: guardWith() });
  assert.equal(r.blocking.length, 1);
  assert.equal(r.reported.length, 0);
});

// ---------- matchResolve (design line 162) ----------

test("matchResolve: one exact position and one exact text in both reads give drawn with those IDs", () => {
  const pending = rec({ state: "pending" });
  const reads = [posShape(77), textShape(78)];
  const r = matchResolve({ record: pending, read1: reads, read2: reads, log: logWith([pending]), guard: guardWith() });
  assert.equal(r.verdict, "drawn");
  assert.equal(r.position_id, 77);
  assert.equal(r.text_id, 78);
  assert.equal(r.saw_position, true);
});

test("matchResolve: no candidate in either read gives not drawn", () => {
  const pending = rec({ state: "pending" });
  // a long position at another entry time and a plain user label are not candidates
  const elsewhere = posShape(5, { pts: [{ time: 3000, price: 5000 }, { time: 4000, price: 4990 }] });
  const plain = textShape(6, { text: "my note", pts: [{ time: 9999, price: 1 }] });
  const r = matchResolve({ record: pending, read1: [elsewhere, plain], read2: [], log: logWith([pending]), guard: guardWith() });
  assert.equal(r.verdict, "not drawn");
  assert.equal(r.candidates.length, 0);
  assert.equal(r.position_id, null);
  assert.equal(r.text_id, null);
  assert.equal(r.saw_position, false);
});

test("matchResolve: not drawn keeps seen_position when the record already had it", () => {
  const pending = rec({ state: "pending", seen_position: true });
  const r = matchResolve({ record: pending, read1: [], read2: [], log: logWith([pending]), guard: guardWith() });
  assert.equal(r.verdict, "not drawn");
  assert.equal(r.saw_position, true);
});

test("matchResolve: a position in only one read is undecided, lists candidates and saw_position", () => {
  const pending = rec({ state: "pending" });
  const r = matchResolve({ record: pending, read1: [posShape(77), textShape(78)], read2: [], log: logWith([pending]), guard: guardWith() });
  assert.equal(r.verdict, "undecided");
  assert.equal(r.position_id, null);
  assert.equal(r.saw_position, true);
  assert.deepEqual(r.candidates.map((c) => c.id).sort(), [77, 78]);
});

test("matchResolve: a position and text whose IDs differ between reads is undecided", () => {
  const pending = rec({ state: "pending" });
  const r = matchResolve({ record: pending, read1: [posShape(77), textShape(78)], read2: [posShape(79), textShape(80)], log: logWith([pending]), guard: guardWith() });
  assert.equal(r.verdict, "undecided");
  assert.equal(r.saw_position, true);
  assert.equal(r.candidates.length, 4);
});

test("matchResolve: two candidate positions in one read is undecided", () => {
  const pending = rec({ state: "pending" });
  const reads = [posShape(77), posShape(79), textShape(78)];
  const r = matchResolve({ record: pending, read1: reads, read2: reads, log: logWith([pending]), guard: guardWith() });
  assert.equal(r.verdict, "undecided");
});

test("matchResolve: a candidate position that is not exact (stopLevel differs) is undecided with saw_position", () => {
  const pending = rec({ state: "pending" });
  const reads = [posShape(77, { stopLevel: 41 }), textShape(78)];
  const r = matchResolve({ record: pending, read1: reads, read2: reads, log: logWith([pending]), guard: guardWith() });
  assert.equal(r.verdict, "undecided");
  assert.equal(r.saw_position, true);
  assert.equal(r.candidates.find((c) => c.id === 77).exact, false);
});

test("matchResolve: a position in the wrong colour is not exact", () => {
  const pending = rec({ state: "pending" });
  const reads = [posShape(77, { linecolor: "#000000" }), textShape(78)];
  const r = matchResolve({ record: pending, read1: reads, read2: reads, log: logWith([pending]), guard: guardWith() });
  assert.equal(r.verdict, "undecided");
});

test("matchResolve: IDs stored in another record or in colour_ok are ignored", () => {
  const pending = rec({ state: "pending" });
  const other = rec({ key: "HTF-a:1:1:1000:1", index: 1, state: "drawn", position_id: 77, text_id: 78 });
  const reads = [posShape(77), textShape(78)];
  const r1 = matchResolve({ record: pending, read1: reads, read2: reads, log: logWith([pending, other]), guard: guardWith() });
  assert.equal(r1.verdict, "not drawn");
  const r2 = matchResolve({ record: pending, read1: reads, read2: reads, log: logWith([pending], [77, 78]), guard: guardWith() });
  assert.equal(r2.verdict, "not drawn");
});

test("matchResolve: the record's own stored IDs are not ignored", () => {
  const pending = rec({ state: "pending", position_id: 77, text_id: 78 });
  const reads = [posShape(77), textShape(78)];
  const r = matchResolve({ record: pending, read1: reads, read2: reads, log: logWith([pending]), guard: guardWith() });
  assert.equal(r.verdict, "drawn");
});

test("matchResolve: an unreadable read is undecided and records nothing", () => {
  const pending = rec({ state: "pending" });
  const r = matchResolve({ record: pending, read1: null, read2: [], log: logWith([pending]), guard: guardWith() });
  assert.equal(r.verdict, "undecided");
  assert.equal(r.position_id, null);
});

test("matchResolve: a text whose point time matches but text differs is a candidate, not exact", () => {
  const pending = rec({ state: "pending" });
  const reads = [posShape(77), textShape(78, { text: "HTF-a BACKTEST" })];
  const r = matchResolve({ record: pending, read1: reads, read2: reads, log: logWith([pending]), guard: guardWith() });
  assert.equal(r.verdict, "undecided");
  assert.equal(r.candidates.find((c) => c.id === 78).exact, false);
});
