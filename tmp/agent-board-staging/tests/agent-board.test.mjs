import assert from "node:assert/strict";
import { group, progress, liveTarget, normalizeAgents, terminalMap, spaceMatches } from "../app/mods/agent-board/logic.js";
assert.equal(group("blocked"), "blocked");
assert.equal(group("done"), "done");
assert.equal(group("ready"), "unknown");
assert.equal(group(null), "unknown");
assert.deepEqual(progress({ labels: { "agents.todo": "2/3", "agents.tasks": "1/2", "agents.tasksPct": "50" } }), { todo: { done: 2, total: 3, now: null }, tasks: { done: 1, total: 2, pct: 50, failed: null, now: null } });
assert.deepEqual(progress({ labels: { "agents.todo": "4/3", "agents.tasks": {}, "agents.tasksPct": "101" } }), { todo: null, tasks: null });
assert.deepEqual(progress(null), { todo: null, tasks: null });
const a = { address: "a", pane: "p", tab: "t", space: "s" };
assert.equal(liveTarget([a], "a", a), a);
assert.equal(liveTarget([], "a", a), null);
assert.equal(liveTarget([{ ...a, pane: "new" }], "a", a), null);
assert.equal(liveTarget([{ address: "a" }], "a", null), null);
assert.equal(normalizeAgents([{ ...a }, { ...a }]).partial, true);
assert.deepEqual(normalizeAgents(null), { agents: null, partial: false });
assert.deepEqual(normalizeAgents([null, {}, { ...a, status: "ready", title: {}, program: null }]), {
  agents: [{ ...a, status: "unknown", title: "", tab_name: "", space_name: "", app: "", program: { name: "" } }],
  partial: true,
});
assert.equal(terminalMap([null, {}, { address: "a", labels: 42 }]).size, 1);
assert.deepEqual(progress({ labels: 42 }), { todo: null, tasks: null });
const spaces = Array.from({ length: 20 }, (_, i) => [`s${i}`, `Space ${i}`]);
assert.equal(spaceMatches(spaces, "").matches.length, 12);
assert.equal(spaceMatches(spaces, "").total, 20);
assert.deepEqual(spaceMatches(spaces, "space 19"), { matches: [["s19", "Space 19"]], total: 1 });
