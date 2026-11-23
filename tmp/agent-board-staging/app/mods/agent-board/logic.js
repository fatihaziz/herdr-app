export const GROUPS = ["blocked", "working", "done", "idle", "unknown"];
export function group(status) {
  return GROUPS.includes(status) ? status : "unknown";
}

const string = value => typeof value === "string" ? value : "";
export function normalizeAgents(value) {
  if (!Array.isArray(value)) return { agents: null, partial: false };
  const agents = [];
  const seen = new Set();
  let partial = false;
  for (const a of value) {
    if (!a || typeof a !== "object" || Array.isArray(a) ||
        ![a.address, a.pane, a.tab, a.space].every(v => typeof v === "string" && v.length > 0) || seen.has(a.address)) {
      partial = true;
      continue;
    }
    seen.add(a.address);
    agents.push({
      address: a.address, pane: a.pane, tab: a.tab, space: a.space,
      title: string(a.title), tab_name: string(a.tab_name), space_name: string(a.space_name),
      app: string(a.app), program: { name: string(a.program?.name) }, status: group(a.status),
    });
  }
  return { agents, partial };
}
export function terminalMap(value) {
  const map = new Map();
  if (!Array.isArray(value)) return map;
  for (const term of value) {
    if (term && typeof term === "object" && typeof term.address === "string" && term.address)
      map.set(term.address, term);
  }
  return map;
}
export function spaceMatches(projects, query, limit = 12) {
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  const matches = projects.filter(([, name]) => name.toLowerCase().includes(q));
  return { matches: matches.slice(0, limit), total: matches.length };
}

function ratio(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) return null;
  const done = Number(match[1]), total = Number(match[2]);
  return Number.isSafeInteger(done) && Number.isSafeInteger(total) && total > 0 && done <= total ? { done, total } : null;
}
function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
export function progress(terminal) {
  const labels = terminal?.labels && typeof terminal.labels === "object" ? terminal.labels : {};
  const todo = ratio(labels["agents.todo"]), tasks = ratio(labels["agents.tasks"]);
  const rawPct = labels["agents.tasksPct"], rawFail = labels["agents.tasksFail"];
  const pct = typeof rawPct === "string" && /^\d+$/.test(rawPct) && Number(rawPct) <= 100 ? Number(rawPct) : null;
  const failed = typeof rawFail === "string" && /^\d+$/.test(rawFail) && Number.isSafeInteger(Number(rawFail)) ? Number(rawFail) : null;
  return {
    todo: todo && { ...todo, now: text(labels["agents.todoNow"]) },
    tasks: tasks && { ...tasks, pct, failed, now: text(labels["agents.tasksNow"]) },
  };
}
export function liveTarget(list, address, original) {
  return Array.isArray(list) && [address, original?.space, original?.tab, original?.pane].every(v => typeof v === "string" && v.length > 0)
    ? list.find(a => a?.address === address && a.space === original.space && a.tab === original.tab && a.pane === original.pane) ?? null
    : null;
}
