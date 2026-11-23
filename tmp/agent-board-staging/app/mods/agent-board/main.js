import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, InputState, Input } from "gpui-base";
import { agents, terminals, machines, layout, props, theme, run, checking } from "herdr";
import { GROUPS, group, progress, liveTarget, normalizeAgents, terminalMap, spaceMatches } from "./logic.js";

const names = { blocked: "Needs you", working: "Working", done: "Done", idle: "Idle", unknown: "Unknown" };
const icon = name => `mods/task-board/icons/${name}.svg`;
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const hit = find(child, id); if (hit) return hit; }
  return null;
}

export default class AgentBoard extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.project = null;
    this.search = "";
    this.error = null;
    this.query = InputState.new({ value: "" });
    this.query.on("change", (_e, cx) => { this.search = this.query.value(); cx.notify(); });
    if (!checking()) cx.timer.every(2000, cx => cx.notify());
  }
  go(a, cx) {
    try {
      if (!liveTarget(agents(), a.address, a)) { this.error = "Agent is no longer available. Refresh and choose another agent."; cx.notify(); return; }
      run("layout.select", { stack: "agent-board-stack", child: "main" });
      run("agent.focus", { terminal: a.address });
      this.error = null;
    } catch { this.error = "Could not open the agent. Check the connection and try again."; cx.notify(); }
  }
  button(t, id, label, glyph, action, selected = false) {
    return Button.new(id).h(30).px(9).gap(6).items_center().rounded(6)
      .border_1().border_color(selected ? t.accent : t.border).bg(selected ? t.selected : t.raised)
      .text_color(t.foreground).text_size(12).cursor_pointer().hover(s => s.bg(t.hover))
      .focus(s => s.border_color(t.accent)).on_click(action)
      .child(svg(icon(glyph)).size(12)).child(label);
  }
  render(cx) {
    const t = theme();
    let list = null, partial = false, terms = null, connections = null, machinePartial = false;
    try { ({ agents: list, partial } = normalizeAgents(agents())); } catch {}
    try { const value = terminals(); if (Array.isArray(value)) terms = value; } catch {}
    try {
      const value = machines();
      if (Array.isArray(value)) {
        connections = value.filter(m => m && typeof m === "object" && !Array.isArray(m) && ["loading", "ready", "unavailable"].includes(m.layout));
        machinePartial = connections.length !== value.length;
      }
    } catch {}
    if (props()?.part === "tab") {
      const n = list?.filter(a => a.status === "blocked").length;
      const active = find(layout(), "agent-board-stack")?.active === "live-board";
      return h_flex().size_full().items_center().justify_center().bg(t.chrome)
        .child(this.button(t, "agent-board-tab", n ? `Board ${n}${partial ? "+" : ""}` : "Board", "board", () => run("layout.select", { stack: "agent-board-stack", child: "live-board" }), active));
    }
    const byAddress = terminalMap(terms);
    const all = list ?? [];
    const projects = [...new Map(all.map(a => [a.space, a.space_name || "Unnamed space"])).entries()];
    const q = this.search.trim().toLowerCase();
    const spaceResults = spaceMatches(projects, q);
    const selectedName = projects.find(([id]) => id === this.project)?.[1] ?? "Selected space";
    const shown = all.filter(a => (!this.project || a.space === this.project) && (!q || [a.title, a.tab_name, a.space_name, a.app, a.program?.name].some(s => typeof s === "string" && s.toLowerCase().includes(q))));
    const counts = Object.fromEntries(GROUPS.map(s => [s, shown.filter(a => group(a.status) === s).length]));
    const priority = shown.find(a => a.status === "blocked");
    const card = a => {
      const p = progress(byAddress.get(a.address));
      const todo = p.todo ? `Todo ${p.todo.done}/${p.todo.total}${p.todo.now ? ` · ${p.todo.now}` : ""}` : null;
      const tasks = p.tasks ? `Subagents ${p.tasks.done}/${p.tasks.total}${p.tasks.pct !== null ? ` · ~${p.tasks.pct}% estimated` : ""}${p.tasks.failed !== null ? ` · ${p.tasks.failed} failed` : ""}${p.tasks.now ? ` · ${p.tasks.now}` : ""}` : null;
      return v_flex().id(`agent-card-${a.address}`).w(240).flex_none().p(10).gap(6).rounded(6).border_1().border_color(t.border).bg(t.raised)
        .child(div().text_size(11).text_color(t.muted).child(`${a.space_name || "Unnamed space"} · ${a.program.name || a.app || "Agent"}`))
        .child(div().text_size(13).text_color(t.foreground).child(a.title || a.tab_name || "Agent"))
        .child(div().text_size(11).text_color(t.muted).child(names[group(a.status)]))
        .when(Boolean(todo), el => el.child(div().text_size(11).text_color(t.foreground).child(todo)))
        .when(Boolean(tasks), el => el.child(div().text_size(11).text_color(t.foreground).child(tasks)))
        .when(!todo && !tasks, el => el.child(div().text_size(11).text_color(t.muted).child("Progress unavailable")))
        .child(this.button(t, `go-${a.address}`, "Go to agent", "agent", (_e, cx) => this.go(a, cx)));
    };
    const root = v_flex().id("agent-board").track_focus(this.handle).size_full().min_h(0).bg(t.background).p(12).gap(10)
      .on_key_down((e, cx) => { if (e.key === "escape") { run("layout.select", { stack: "agent-board-stack", child: "main" }); cx.stop_propagation(); } });
    root.child(h_flex().gap(8).items_center().child(div().text_size(16).font_semibold().text_color(t.foreground).child("Agent board"))
      .child(div().flex_1()).child(this.button(t, "board-work", "Work", "agent", () => run("layout.select", { stack: "agent-board-stack", child: "main" }))));
    if (!list) return root.child(div().text_color(t.foreground).child("Agent data unavailable. Check the connection and reopen Board."));
    if (!connections || machinePartial) root.child(div().text_color(t.foreground).child("Machine availability unavailable or incomplete."));
    if (connections?.some(m => m.layout === "loading")) root.child(div().text_color(t.muted).child("Loading spaces…"));
    if (connections?.some(m => m.layout === "unavailable")) root.child(div().text_color(t.foreground).child("Some machines are offline. Their agents may be missing."));
    if (partial) root.child(div().text_color(t.foreground).child("Some agent records are unavailable; counts are partial."));
    if (!terms) root.child(div().text_color(t.muted).child("Agent progress unavailable."));
    if (this.error) root.child(div().text_color(t.foreground).child(this.error));
    root.child(h_flex().gap(8).overflow_x_scrollbar().children([
      ...GROUPS.map(s => v_flex().w(128).flex_none().p(8).gap(4).bg(t.raised).rounded(6).child(div().text_size(11).text_color(t.muted).child(names[s])).child(div().text_size(18).text_color(t.foreground).child(partial ? (counts[s] ? `${counts[s]}+` : "Unavailable") : String(counts[s])))),
      ...["Ready to land", "Landed today", "Tokens", "Git / checks"].map(s => v_flex().w(128).flex_none().p(8).gap(4).bg(t.raised).rounded(6).child(div().text_size(11).text_color(t.muted).child(s)).child(div().text_size(12).text_color(t.foreground).child("Unavailable"))),
    ]));
    if (priority) root.child(h_flex().gap(10).p(10).items_center().border_1().border_color(t.blocked).rounded(6)
      .child(v_flex().flex_1().min_w(0).child(div().text_size(11).text_color(t.foreground).child("Next move · Needs you"))
        .child(div().text_size(13).text_color(t.foreground).child(priority.title || priority.tab_name || "Agent")))
      .child(this.button(t, "priority-go", "Go to agent", "agent", (_e, cx) => this.go(priority, cx))));
    root.child(h_flex().gap(8).items_center().child(svg(icon("search")).size(12).text_color(t.muted))
      .child(div().text_size(12).text_color(t.foreground).child("Search"))
      .child(v_flex().w(180).child(Input.new(this.query).h(28).text_size(12).text_color(t.foreground)))
      .child(div().text_size(11).text_color(t.muted).child(partial ? `${shown.length} agents shown · partial` : `${shown.length} agents`)));
    root.child(h_flex().gap(6).overflow_x_scrollbar()
      .child(this.button(t, "project-all", this.project === null ? "All spaces" : `Clear space: ${selectedName}`, "board", (_e, cx) => { this.project = null; cx.notify(); }, this.project === null))
      .children(spaceResults.matches.map(([id, name], i) => this.button(t, `project-${i}`, name, "agent", (_e, cx) => { this.project = this.project === id ? null : id; cx.notify(); }, this.project === id))));
    root.child(div().text_size(11).text_color(t.muted).child(`${spaceResults.matches.length} of ${spaceResults.total} matching spaces · ${projects.length} total${spaceResults.total > spaceResults.matches.length ? " · refine search" : ""}`));
    if (!all.length) return root.child(div().text_color(t.foreground).child(partial ? "Agent records are unavailable." : "No agents reporting status in this window."));
    if (!shown.length) return root.child(div().text_color(t.foreground).child("No agents match these filters."));
    return root.child(div().flex().flex_row().flex_1().min_h(0).gap(8).overflow_x_scrollbar().children(GROUPS.map(s => v_flex().w(250).flex_none().min_h(0).gap(6)
      .child(div().text_size(12).font_semibold().text_color(t.foreground).child(`${names[s]} · ${partial ? (counts[s] ? `${counts[s]}+` : "unavailable") : counts[s]}`))
      .child(v_flex().id(`column-${s}`).flex_1().min_h(0).gap(6).overflow_y_scrollbar().children(shown.filter(a => group(a.status) === s).map(card))))));
  }
}
