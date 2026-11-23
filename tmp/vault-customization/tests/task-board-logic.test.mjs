// Focused model tests for the native task board. Run: node --test tests/
// Loads logic.js through a data URL because mod modules are app-flavoured ESM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../app/mods/task-board/logic.js", import.meta.url), "utf8");
const L = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`);

test("parseBoard rejects corrupt and non-board documents", () => {
  assert.throws(() => L.parseBoard("{"), /not valid JSON/);
  assert.throws(() => L.parseBoard("[]"), /not a JSON object/);
  assert.throws(() => L.parseBoard('{"tasks":{}}'), /no tasks array/);
});

test("parseBoard refuses malformed records and preserves extension fields", () => {
  const valid = L.upsertTask(L.emptyBoard(), { title: "kept" });
  valid.extra = { original: true };
  valid.tasks[0].extra = { original: true };
  assert.deepEqual(L.parseBoard(L.boardText(valid)), valid);
  for (const change of [
    (d) => { d.version = 7; },
    (d) => { d.tasks.push(null); },
    (d) => { d.tasks[0].stage = "Someday"; },
    (d) => { d.tasks[0].title = 5; },
    (d) => { d.tasks[0].createdAt = "not a timestamp"; },
    (d) => { d.tasks[0].updatedAt = "2026-02-30T12:00:00Z"; },
    (d) => { d.tasks[0].createdAt = null; },
    (d) => { d.tasks[0].updatedAt = null; },
    (d) => { delete d.tasks[0].start; },
    (d) => { delete d.tasks[0].end; },
    (d) => { d.tasks[0].agent = { address: "t1", space: 42 }; },
    (d) => { d.tasks[0].agent = { address: "t1", tab: {} }; },
    (d) => { d.tasks[0].agent = { address: "t1", title: false }; },
    (d) => { d.tasks[0].agent = { address: "t1", app: [] }; },
    (d) => { d.tasks[0].start = "2026-02-30"; },
    (d) => { d.tasks[0].start = "2026-11-10"; d.tasks[0].end = "2026-11-01"; },
    (d) => { d.tasks[0].start = "2026-11-10"; },
    (d) => { d.tasks.push({ ...d.tasks[0] }); },
  ]) {
    const doc = JSON.parse(JSON.stringify(valid));
    change(doc);
    assert.throws(() => L.parseBoard(JSON.stringify(doc)));
  }
});

test("optional timestamps and agent metadata remain untouched", () => {
  const doc = L.upsertTask(L.emptyBoard(), { title: "optional" });
  delete doc.tasks[0].createdAt;
  delete doc.tasks[0].updatedAt;
  doc.tasks[0].agent = { address: "t1", space: null, extension: { keep: true } };
  assert.deepEqual(L.parseBoard(L.boardText(doc)), doc);
});

test("omitted date pair remains absent and unscheduled", () => {
  const doc = L.upsertTask(L.emptyBoard(), { title: "undated" });
  delete doc.tasks[0].start;
  delete doc.tasks[0].end;
  const parsed = L.parseBoard(L.boardText(doc));
  assert.deepEqual(parsed, doc);
  assert.equal(L.ganttRows(parsed.tasks).scheduled.length, 0);
  assert.equal(L.ganttRows(parsed.tasks).unscheduled.length, 1);
});

test("isDate accepts real dates only", () => {
  assert.equal(L.isDate("2026-02-28"), true);
  assert.equal(L.isDate("0001-01-01"), true);
  assert.equal(L.isDate("0000-02-29"), true);
  assert.equal(L.isDate("0001-02-29"), false);
  assert.equal(L.isDate("2026-02-30"), false);
  assert.equal(L.isDate("16-11-2026"), false);
  assert.equal(L.isDate(""), false);
});

test("validRange requires both ends and rejects end before start", () => {
  assert.match(L.validRange("2026-11-01", null), /end date is required/);
  assert.match(L.validRange(null, "2026-11-01"), /start date is required/);
  assert.match(L.validRange("2026-11-10", "2026-11-01"), /before start/);
  assert.equal(L.validRange("2026-11-01", "2026-11-01"), null);
  assert.equal(L.validRange(null, null), null);
});

test("upsertTask creates, edits and refuses an empty title", () => {
  const doc = L.upsertTask(L.emptyBoard(), { title: "  Plan  ", stage: "Doing", start: null, end: null });
  assert.equal(doc.tasks.length, 1);
  assert.equal(doc.tasks[0].title, "Plan");
  assert.equal(doc.tasks[0].stage, "Doing");
  const id = doc.tasks[0].id;
  const edited = L.upsertTask(doc, { id, title: "Plan v2", stage: "Review", start: "2026-11-02", end: "2026-11-04" });
  assert.equal(edited.tasks.length, 1);
  assert.equal(edited.tasks[0].title, "Plan v2");
  assert.equal(edited.tasks[0].end, "2026-11-04");
  assert.throws(() => L.upsertTask(doc, { title: "   " }), /Title is required/);
  assert.throws(() => L.upsertTask(doc, { title: "x", start: "2026-11-05", end: "2026-11-01" }), /before start/);
});

test("moveTask steps through the fixed stages and clamps at both ends", () => {
  let doc = L.upsertTask(L.emptyBoard(), { title: "t", stage: "Brainstorm" });
  const id = doc.tasks[0].id;
  doc = L.moveTask(doc, id, -1);
  assert.equal(doc.tasks[0].stage, "Brainstorm");
  for (const expected of ["Doing", "Triage", "Review", "Done", "Done"]) {
    doc = L.moveTask(doc, id, 1);
    assert.equal(doc.tasks[0].stage, expected);
  }
});

test("attachAgent stores and clears a live address", () => {
  let doc = L.upsertTask(L.emptyBoard(), { title: "t" });
  const id = doc.tasks[0].id;
  doc = L.attachAgent(doc, id, { address: "t7", space: "s", tab: "s/1", title: "Claude", app: "claude-code" });
  assert.equal(doc.tasks[0].agent.address, "t7");
  doc = L.attachAgent(doc, id, null);
  assert.equal(doc.tasks[0].agent, null);
});

test("filterTasks searches title, notes, stage and agent", () => {
  let doc = L.upsertTask(L.emptyBoard(), { title: "Router cutover", notes: "vault owned", stage: "Doing" });
  doc = L.attachAgent(doc, doc.tasks[0].id, { address: "t1", title: "Claude Code", app: "claude-code" });
  doc = L.upsertTask(doc, { title: "Board design", stage: "Review" });
  assert.equal(L.filterTasks(doc.tasks, "vault").length, 1);
  assert.equal(L.filterTasks(doc.tasks, "claude").length, 1);
  assert.equal(L.filterTasks(doc.tasks, "review").length, 1);
  assert.equal(L.filterTasks(doc.tasks, "  ").length, 2);
});

test("ganttRows splits explicit dates from undated work and never guesses", () => {
  let doc = L.emptyBoard();
  doc = L.upsertTask(doc, { title: "dated", start: "2026-11-03", end: "2026-11-07" });
  doc = L.upsertTask(doc, { title: "undated" });
  doc = L.upsertTask(doc, { title: "half", start: null, end: null });
  const g = L.ganttRows(doc.tasks);
  assert.deepEqual(g.scheduled.map(r => r.task.title), ["dated"]);
  assert.deepEqual(g.unscheduled.map(t => t.title).sort(), ["half", "undated"]);
  assert.equal(g.min, L.dayValue("2026-11-03"));
  assert.equal(g.max, L.dayValue("2026-11-07"));
});

test("gantt never schedules malformed, partial or reversed ranges", () => {
  const tasks = [
    { title: "reversed", start: "2026-11-10", end: "2026-11-01" },
    { title: "invalid", start: "2026-02-30", end: "2026-03-01" },
    { title: "partial", start: "2026-11-01", end: null },
  ];
  const result = L.ganttRows(tasks);
  assert.equal(result.scheduled.length, 0);
  assert.deepEqual(result.unscheduled, tasks);
});

test("barGeometry stays inside the track for the whole span", () => {
  const g = L.ganttRows([
    { id: "a", title: "a", start: "2026-11-01", end: "2026-11-10" },
    { id: "b", title: "b", start: "2026-11-05", end: "2026-11-20" },
  ]);
  const track = 400;
  for (const row of g.scheduled) {
    const bar = L.barGeometry(row, g.min, g.max, track);
    assert.ok(bar.left >= 0, "left in track");
    assert.ok(bar.width >= 6, "visible width");
    assert.ok(bar.left + bar.width <= track, "right edge in track");
  }
  const first = L.barGeometry(g.scheduled[0], g.min, g.max, track);
  const second = L.barGeometry(g.scheduled[1], g.min, g.max, track);
  assert.ok(second.left > first.left, "later start sits further right");
});

test("boardText round-trips and keeps unknown top-level keys", () => {
  const doc = L.upsertTask(L.emptyBoard(), { title: "t" });
  const text = L.boardText({ ...doc, note: "keep me" });
  const again = L.parseBoard(text);
  assert.equal(again.note, "keep me");
  assert.equal(again.tasks.length, 1);
});
