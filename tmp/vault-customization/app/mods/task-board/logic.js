// Pure task-board model: parsing, validation, mutations, filtering and Gantt
// geometry. No imports so the mod and the focused tests share one source.
// Data lives outside the mod: <appHome>/data/task-board/board.json (ignored).

export const STAGES = ["Brainstorm", "Doing", "Triage", "Review", "Done"];
export const REL = "data/task-board/board.json";
const DAY = 86400000;

export const newId = () =>
  `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function emptyBoard() {
  return { version: 1, tasks: [] };
}

function validTimestamp(value) {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m || !isDate(m[1]) || +m[2] > 23 || +m[3] > 59 || +m[4] > 59) return false;
  if (m[5] !== "Z" && (+m[5].slice(1, 3) > 23 || +m[5].slice(4, 6) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

/** Parses a board document. Throws a message a person can act on; never
 *  rewrites or tolerates a corrupt file (the caller must not overwrite it). */
export function parseBoard(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("board.json is not valid JSON");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new Error("board.json is not a JSON object");
  if (!Array.isArray(doc.tasks))
    throw new Error("board.json has no tasks array");
  if (doc.version !== 1) throw new Error("board.json has an unsupported version");
  const ids = new Set();
  for (const task of doc.tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task) ||
        typeof task.id !== "string" || !task.id || ids.has(task.id) ||
        typeof task.title !== "string" || typeof task.notes !== "string" ||
        !STAGES.includes(task.stage) ||
        (("start" in task) !== ("end" in task)) ||
        !((task.start === undefined && task.end === undefined) ||
          ((task.start === null || isDate(task.start)) &&
           (task.end === null || isDate(task.end)) && !validRange(task.start, task.end))) ||
        !validTimestamp(task.createdAt) || !validTimestamp(task.updatedAt) ||
        !(task.agent == null || (task.agent && typeof task.agent === "object" &&
          !Array.isArray(task.agent) && typeof task.agent.address === "string" && task.agent.address &&
          ["space", "tab", "title", "app"].every((key) =>
            task.agent[key] === undefined || task.agent[key] === null || typeof task.agent[key] === "string"))))
      throw new Error("board.json contains an invalid task");
    ids.add(task.id);
  }
  return doc;
}

export const boardText = (doc) => JSON.stringify(doc, null, 2) + "\n";

/** A real calendar date in YYYY-MM-DD; rejects 2026-02-30 and friends. */
export function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/** null when the pair is usable, else the exact reason shown in the editor. */
export function validRange(start, end) {
  if (start !== null && start !== undefined && start !== "" && !isDate(start))
    return "Start must be a real date as YYYY-MM-DD";
  if (end !== null && end !== undefined && end !== "" && !isDate(end))
    return "End must be a real date as YYYY-MM-DD";
  const s = start || null;
  const e = end || null;
  if (s && !e) return "An end date is required when a start date is set";
  if (e && !s) return "A start date is required when an end date is set";
  if (s && e && e < s) return "End cannot be before start";
  return null;
}

export function upsertTask(doc, input) {
  const err = validRange(input.start ?? null, input.end ?? null);
  if (err) throw new Error(err);
  const title = (input.title ?? "").trim();
  if (!title) throw new Error("Title is required");
  const stage = STAGES.includes(input.stage) ? input.stage : "Brainstorm";
  const now = new Date().toISOString();
  const tasks = doc.tasks.map((t) => ({ ...t }));
  const i = input.id ? tasks.findIndex((t) => t.id === input.id) : -1;
  if (input.id && i === -1) throw new Error("That task no longer exists");
  const base = i === -1 ? { id: newId(), createdAt: now, agent: null } : tasks[i];
  const next = {
    ...base,
    title,
    notes: input.notes ?? "",
    stage,
    start: input.start || null,
    end: input.end || null,
    updatedAt: now,
  };
  if (i === -1) tasks.push(next);
  else tasks[i] = next;
  return { ...doc, tasks };
}

export function moveTask(doc, id, direction) {
  const now = new Date().toISOString();
  const tasks = doc.tasks.map((t) => {
    if (t.id !== id) return t;
    const i = STAGES.indexOf(t.stage);
    const nextStage = STAGES[Math.max(0, Math.min(STAGES.length - 1, i + direction))];
    return nextStage === t.stage ? t : { ...t, stage: nextStage, updatedAt: now };
  });
  return { ...doc, tasks };
}

export function deleteTask(doc, id) {
  return { ...doc, tasks: doc.tasks.filter((t) => t.id !== id) };
}

/** agent: { address, space, tab, title, app } or null to detach. */
export function attachAgent(doc, id, agent) {
  const now = new Date().toISOString();
  return {
    ...doc,
    tasks: doc.tasks.map((t) =>
      t.id === id ? { ...t, agent: agent ?? null, updatedAt: now } : t,
    ),
  };
}

export function filterTasks(tasks, query) {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter((t) =>
    [t.title, t.notes, t.stage, t.agent?.title ?? "", t.agent?.app ?? ""]
      .join("\n")
      .toLowerCase()
      .includes(q),
  );
}

export const dayValue = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);

/** Explicit start+end only. Everything else is unscheduled, never guessed. */
export function ganttRows(tasks) {
  const scheduled = [];
  const unscheduled = [];
  for (const t of tasks) {
    if (isDate(t.start) && isDate(t.end) && !validRange(t.start, t.end)) scheduled.push({ task: t, from: dayValue(t.start), to: dayValue(t.end) });
    else unscheduled.push(t);
  }
  scheduled.sort(
    (a, b) =>
      a.from - b.from ||
      a.to - b.to ||
      a.task.title.localeCompare(b.task.title),
  );
  const min = scheduled.length ? Math.min(...scheduled.map((r) => r.from)) : 0;
  const max = scheduled.length ? Math.max(...scheduled.map((r) => r.to)) : 0;
  return { scheduled, unscheduled, min, max };
}

export function barGeometry(row, min, max, trackPx) {
  const usable = Math.max(60, Math.floor(trackPx) - 8);
  const span = Math.max(1, max - min);
  const left = Math.round(((row.from - min) / span) * usable);
  const width = Math.round(((row.to - row.from + 1) / (span + 1)) * usable);
  return {
    left: Math.max(0, Math.min(left, usable - 4)),
    width: Math.max(6, Math.min(width, usable - left)),
  };
}
