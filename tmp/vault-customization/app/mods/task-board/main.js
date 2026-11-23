// Task board: Board and Gantt over ONE task file, plus the task editor and
// agent-attach dialogs. Board and Gantt are separate copies of this mod; they
// share data through <appHome>/data/task-board/board.json and re-render each
// other through shared("task-board.rev"). Manual stages only; Herdr never
// moves a task or invents dates on its own.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, InputState, Input } from "gpui-base";
import {
  appHome,
  readTextFile,
  writeTextFile,
  setShared,
  shared,
  theme,
  agents,
  openOverlay,
  closeOverlay,
  props,
  checking,
  notify,
} from "herdr";
import {
  STAGES,
  REL,
  parseBoard,
  boardText,
  emptyBoard,
  validRange,
  upsertTask,
  moveTask,
  deleteTask,
  attachAgent,
  filterTasks,
  ganttRows,
  barGeometry,
} from "./logic.js";

const REV = "task-board.rev";
const path = () => `${appHome()}/${REL}`;
const ic = (name) => `mods/task-board/icons/${name}.svg`;

export default class TaskBoard extends View {
  init(_props, cx) {
    this.mode = props()?.mode ?? "view";
    this.view = props()?.view === "gantt" ? "gantt" : "board";
    this.handle = cx.focus_handle();
    this.loading = true;
    this.error = null;
    this.saveError = null;
    this.doc = null;
    this.rev = 0;
    this.raw = undefined;
    this.loadSeq = 0;
    this.polling = false;
    this.armed = null;
    this.flash = null;
    this.size = null;
    this.search = "";
    this.query = InputState.new({ value: "" });
    this.query.on("change", (e, cx) => {
      this.search = this.query.value();
      cx.notify();
    });
    if (this.mode === "edit") this.initEditor();
    if (this.mode === "attach") this.initAttach();
    this.load(cx);
    if (!checking()) cx.timer.every(4000, (cx) => this.poll(cx));
  }

  initEditor() {
    const t = props()?.task ?? {};
    this.originalTask = t.id ? JSON.stringify(t) : null;
    const start = t.start ?? "";
    const end = t.end ?? "";
    this.form = {
      id: t.id ?? null,
      title: t.title ?? "",
      notes: t.notes ?? "",
      stage: STAGES.includes(t.stage) ? t.stage : STAGES[0],
      start,
      end,
    };
    this.titleInput = InputState.new({ value: this.form.title });
    this.notesInput = InputState.new({ value: this.form.notes });
    this.startInput = InputState.new({ value: start });
    this.endInput = InputState.new({ value: end });
    this.formError = null;
    const bind = (state, key) =>
      state.on("change", (e, cx) => {
        this.form[key] = state.value();
        this.formError = null;
        cx.notify();
      });
    bind(this.titleInput, "title");
    bind(this.notesInput, "notes");
    bind(this.startInput, "start");
    bind(this.endInput, "end");
    for (const state of [this.titleInput, this.notesInput, this.startInput, this.endInput])
      state.on("submit", (_e, cx) => this.save(cx));
  }

  initAttach() {
    this.attachId = props()?.taskId ?? null;
  }

  load(cx) {
    const seq = ++this.loadSeq;
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(path());
        const doc = raw === null ? emptyBoard() : parseBoard(raw);
        if (seq !== this.loadSeq) return;
        this.raw = raw;
        this.doc = doc;
        this.error = null;
      } catch {
        if (seq !== this.loadSeq) return;
        this.doc = null;
        this.error = "Board could not be read or has an incompatible format. Check the file and retry.";
      }
      this.loading = false;
      this.rev = shared(REV)?.rev ?? 0;
      cx.notify();
    });
  }

  poll(cx) {
    if (this.polling || this.loading) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(path());
        if (raw !== this.raw || (shared(REV)?.rev ?? 0) !== this.rev) this.load(cx);
      } catch {
        this.load(cx);
      } finally {
        this.polling = false;
      }
    });
  }

  fail(cx) {
    const message = "Could not save the task. Check the board file and retry.";
    if (this.mode === "edit") this.formError = message;
    else this.error = message;
    cx.notify();
  }

  /** Optimistic write: read, mutate, write with the exact snapshot we read.
   *  A stale snapshot is retried up to 3 times; a corrupt file is never written. */
  commit(cx, fn, done) {
    cx.spawn(async (cx) => {
      const p = path();
      for (let attempt = 0; attempt < 3; attempt++) {
        let raw = null;
        try {
          raw = await readTextFile(p);
        } catch {
          this.doc = null;
          this.error = "Board could not be read or has an incompatible format. Check the file and retry.";
          cx.notify();
          return null;
        }
        let doc;
        try {
          doc = raw === null ? emptyBoard() : parseBoard(raw);
        } catch {
          this.doc = null;
          this.error = "Board could not be read or has an incompatible format. Check the file and retry.";
          cx.notify();
          return null;
        }
        let next;
        try {
          next = fn(doc);
        } catch (e) {
          this.fail(cx, e);
          return null;
        }
        try {
          await writeTextFile(p, boardText(next), raw);
        } catch (e) {
          // A changed snapshot is a conflict; an unreadable file is an I/O failure.
          let now;
          let readOk = true;
          try { now = await readTextFile(p); } catch { readOk = false; }
          const conflict = readOk && now !== raw;
          if (conflict && attempt < 2) continue;
          const message = conflict
            ? "Board changed while saving. Latest data reloaded; review and retry."
            : "Save failed. Check the board file and retry.";
          this.saveError = message;
          if (this.mode === "edit") this.formError = message;
          else this.error = message;
          if (conflict) this.load(cx);
          cx.notify();
          return null;
        }
        ++this.loadSeq;
        this.doc = next;
        this.raw = boardText(next);
        this.error = null;
        this.saveError = null;
        this.loading = false;
        this.rev = (shared(REV)?.rev ?? 0) + 1;
        setShared(REV, { rev: this.rev });
        cx.notify();
        done?.(next);
        return next;
      }
      return null;
    });
  }
  save(cx) {
    if (!cx || this.loading || this.error || !this.doc) return;
    const f = this.form;
    const start = f.start.trim() || null;
    const end = f.end.trim() || null;
    const err = validRange(start, end);
    if (err) {
      this.formError = err;
      cx.notify();
      return;
    }
    this.commit(
      cx,
      (doc) => {
        if (f.id && JSON.stringify(doc.tasks.find((task) => task.id === f.id)) !== this.originalTask)
          throw new Error("task changed");
        return upsertTask(doc, { ...f, start, end });
      },
      () => {
        const overlay = props()?.overlay;
        if (overlay) closeOverlay(overlay);
        notify({ title: "Task saved", body: f.title.trim() });
      },
    );
  }

  // ---- shared pieces -------------------------------------------------------

  header(t, title, actions) {
    return h_flex()
      .w_full()
      .h(34)
      .px(8)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(svg(ic(this.view === "gantt" ? "gantt" : "board")).size(13).text_color(t.muted))
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(title))
      .when(Boolean(props()?.overlay), (el) =>
        el.child(
          Button.new("tb-close-window")
            .h(24).px(9).gap(6).items_center().rounded(7)
            .border_1().border_color(t.input).bg(t.raised)
            .text_color(t.foreground).text_size(12).cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .focus((s) => s.border_color(t.accent))
            .on_click(() => closeOverlay(props().overlay))
            .child(svg(ic("x")).size(11))
            .child("Close"),
        ),
      )
      .child(div().flex_1())
      .children(actions ?? []);
  }

  iconButton(t, id, icon, onclick, opts = {}) {
    return h_flex()
      .id(id)
      .w(22)
      .h(22)
      .items_center()
      .justify_center()
      .rounded(6)
      .border_1()
      .border_color(opts.danger ? t.blocked : t.border)
      .bg(opts.active ? t.selected : t.raised)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(onclick)
      .child(
        svg(ic(icon))
          .size(12)
          .text_color(opts.danger ? t.blocked : t.muted),
      );
  }

  textButton(t, id, label, icon, onclick, primary) {
    return h_flex()
      .id(id)
      .h(24)
      .px(9)
      .gap(6)
      .items_center()
      .rounded(7)
      .border_1()
      .border_color(primary ? t.solid : t.input)
      .bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12)
      .cursor_pointer()
      .hover((s) => s.opacity(0.88))
      .on_click(onclick)
      .child(svg(ic(icon)).size(11))
      .child(label);
  }

  stateCard(t, iconName, title, body, action) {
    return v_flex()
      .id("state")
      .flex_1()
      .min_h(0)
      .p(18)
      .gap(8)
      .items_center()
      .justify_center()
      .child(svg(ic(iconName)).size(22).text_color(t.dim))
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child(title))
      .child(div().text_size(12).text_color(t.muted).child(body))
      .children(action ? [action] : []);
  }

  agentLine(t, task) {
    const a = task.agent;
    if (!a) return null;
    const live = agents().find((x) => x.address === a.address);
    const status = live?.status ?? null;
    const color = status === "blocked" ? t.blocked : status === "working" ? t.working : status === "done" ? t.done : t.idle;
    const label = live ? live.title || a.title || a.address : "offline · not in this window";
    return h_flex()
      .gap(5)
      .items_center()
      .child(div().size(6).rounded(3).bg(color))
      .child(div().text_size(10.5).text_color(live ? t.muted : t.dim).truncate().child(label));
  }

  // ---- board ---------------------------------------------------------------

  card(t, task) {
    const armed = this.armed === task.id;
    const stageIndex = STAGES.indexOf(task.stage);
    return v_flex()
      .id(`task-${task.id}`)
      .w_full()
      .p(8)
      .gap(5)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .hover((s) => s.border_color(t.input))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).truncate().child(task.title || "(untitled)"))
          .child(this.iconButton(t, `edit-${task.id}`, "edit", () =>
            openOverlay({
              mod: "task-board",
              kind: "dialog",
              width: 520,
              height: 430,
              props: { mode: "edit", task },
            }),
          ))
          .child(this.iconButton(t, `attach-${task.id}`, "agent", () =>
            openOverlay({
              mod: "task-board",
              kind: "dialog",
              width: 480,
              height: 420,
              props: { mode: "attach", taskId: task.id },
            }),
          )),
      )
      .when(Boolean(task.notes), (el) =>
        el.child(div().text_size(11).text_color(t.muted).truncate().child(task.notes)),
      )
      .children([this.agentLine(t, task)].filter(Boolean))
      // Dates get their own line, so they stay complete inside a 204px column.
      .when(Boolean(task.start || task.end), (el) =>
        el.child(
          h_flex()
            .gap(5)
            .items_center()
            .child(svg(ic("calendar")).size(11).text_color(t.dim))
            .child(
              div()
                .text_size(10.5)
                .text_color(t.dim)
                .child(`${task.start ?? "unscheduled"} → ${task.end ?? "unscheduled"}`),
            ),
        ),
      )
      // Actions keep a full icon box each and never share a line with a date string.
      .child(
        h_flex()
          .gap(5)
          .items_center()
          .children([
            stageIndex > 0
              ? this.iconButton(t, `left-${task.id}`, "chevron-left", (e, cx) =>
                  this.commit(cx, (doc) => moveTask(doc, task.id, -1)),
                )
              : null,
            stageIndex < STAGES.length - 1
              ? this.iconButton(t, `right-${task.id}`, "chevron-right", (e, cx) =>
                  this.commit(cx, (doc) => moveTask(doc, task.id, 1)),
                )
              : null,
          ].filter(Boolean))
          .child(div().flex_1())
          .child(
            armed
              ? this.textButton(t, `del-${task.id}`, "Delete?", "trash", (e, cx) => {
                  this.armed = null;
                  this.commit(cx, (doc) => deleteTask(doc, task.id));
                }, false)
              : this.iconButton(t, `del-${task.id}`, "trash", (e, cx) => {
                  this.armed = task.id;
                  cx.notify();
                }, { danger: true }),
          ),
      );
  }

  board(t, tasks) {
    const filtered = filterTasks(tasks, this.search);
    const byStage = {};
    for (const s of STAGES) byStage[s] = [];
    for (const task of filtered) byStage[task.stage].push(task);
    // A flex_1 scroll body under a horizontal scroll area has no definite height,
    // so it measured 0 and drew only the headers. Take the height from the window.
    const bodyH = Math.max(160, (this.size?.height ?? 620) - 150);
    return h_flex()
      .flex_1()
      .min_h(0)
      .gap(8)
      .items_start()
      .overflow_x_scrollbar()
      .children(
        STAGES.map((stage) => {
          const list = byStage[stage];
          return v_flex()
            .id(`col-${stage}`)
            .w(204)
            .flex_none()
            .min_h(0)
            .gap(6)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .px(2)
                .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(stage))
                .child(div().text_size(10.5).text_color(t.dim).child(String(list.length))),
            )
            .child(
              v_flex()
                .id(`col-body-${stage}`)
                .h(bodyH)
                .gap(6)
                .overflow_y_scrollbar()
                .children(
                  list.length === 0
                    ? [div().p(6).text_size(11).text_color(t.dim).child("Empty")]
                    : list.map((task) => this.card(t, task)),
                ),
            );
        }),
      );
  }

  // ---- gantt ---------------------------------------------------------------

  gantt(t, tasks) {
    const filtered = filterTasks(tasks, this.search);
    const { scheduled, unscheduled, min, max } = ganttRows(filtered);
    const track = Math.max(120, (this.size?.width ?? 520) - 250);
    const rowsH = Math.max(120, (this.size?.height ?? 620) - 250);
    const rows = scheduled.map((row) => {
      const bar = barGeometry(row, min, max, track);
      // One accent carries open work; muted means finished. The stage name is on the row's left.
      const stageColor = (i) => (STAGES[i] === "Done" ? t.muted : t.accent);
      return h_flex()
        .id(`g-${row.task.id}`)
        .h(26)
        .gap(6)
        .items_center()
        .child(div().w(150).min_w(0).text_size(11.5).text_color(t.foreground).truncate().child(row.task.title || "(untitled)"))
        .child(
          div()
            .w(track)
            .h(16)
            .rounded(4)
            .bg(t.raised)
            .child(
              h_flex()
                .w(track)
                .h(16)
                .items_center()
                .child(div().w(bar.left).h(16))
                .child(
                  div()
                    .id(`bar-${row.task.id}`)
                    .w(bar.width)
                    .h(16)
                    .rounded(4)
                    .bg(stageColor(STAGES.indexOf(row.task.stage)))
                    .cursor_pointer()
                    .on_click(() =>
                      openOverlay({
                        mod: "task-board",
                        kind: "dialog",
                        width: 520,
                        height: 430,
                        props: { mode: "edit", task: row.task },
                      }),
                    ),
                ),
            ),
        )
        .child(div().text_size(10).text_color(t.dim).child(`${row.task.start} → ${row.task.end}`));
    });
    return v_flex()
      .flex_1()
      .min_h(0)
      .gap(8)
      .overflow_y_scrollbar()
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(svg(ic("calendar")).size(11).text_color(t.dim))
          .child(
            div()
              .text_size(10.5)
              .text_color(t.dim)
              .child(scheduled.length ? `span ${dayLabel(min)} → ${dayLabel(max)}` : "No dated tasks yet"),
          )
          .child(div().flex_1())
          .child(h_flex().gap(4).items_center()
            .child(div().size(6).rounded(3).bg(t.accent))
            .child(div().text_size(10).text_color(t.dim).child("open")))
          .child(h_flex().gap(4).items_center()
            .child(div().size(6).rounded(3).bg(t.muted))
            .child(div().text_size(10).text_color(t.dim).child("Done"))),
      )
      .child(
        v_flex()
          .id("gantt-rows")
          .h(rowsH)
          .gap(2)
          .overflow_y_scrollbar()
          .children(rows.length ? rows : [div().text_size(11).text_color(t.dim).child("Nothing scheduled. Add start and end dates in a task to place it here.")]),
      )
      .child(
        v_flex()
          .id("gantt-unscheduled")
          .gap(4)
          .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(`Unscheduled · ${unscheduled.length}`))
          .children(
            unscheduled.length
              ? unscheduled.map((task) =>
                  h_flex()
                    .id(`u-${task.id}`)
                    .gap(6)
                    .items_center()
                    .child(div().size(5).rounded(3).bg(t.dim))
                    .child(div().text_size(11).text_color(t.dim).truncate().child(task.title || "(untitled)"))
                    .child(div().text_size(10).text_color(t.dim).child(task.stage)),
                )
              : [div().text_size(11).text_color(t.dim).child("Every task has explicit dates.")],
          ),
      );
  }

  // ---- dialogs -------------------------------------------------------------

  editor(t) {
    const label = (text) => div().pt(10).pb(4).text_size(11).text_color(t.dim).child(text);
    const field = (id, state, focused) =>
      Input.new(state)
        .id(id)
        .h(32)
        .px(9)
        .rounded(8)
        .border_1()
        .border_color(focused ? t.accent : t.input)
        .bg(t.background)
        .text_size(12.5)
        .text_color(t.foreground);
    const f = this.form;
    return v_flex()
      .id("task-editor")
      .track_focus(this.handle)
      .size_full()
      .p(16)
      .gap(4)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().text_size(14).font_semibold().child(f.id ? "Edit task" : "New task"))
          .child(div().text_size(10.5).text_color(t.dim).child("Esc")),
      )
      .child(label("Title"))
      .child(field("tb-title", this.titleInput, true))
      .child(label("Notes"))
      .child(field("tb-notes", this.notesInput, false))
      .child(label("Stage"))
      .child(
        h_flex()
          .gap(5)
          .children(
            STAGES.map((stage) =>
              h_flex()
                .id(`stage-${stage}`)
                .h(24)
                .px(8)
                .items_center()
                .rounded(6)
                .border_1()
                .border_color(f.stage === stage ? t.accent : t.input)
                .bg(f.stage === stage ? t.selected : t.raised)
                .text_size(11.5)
                .text_color(f.stage === stage ? t.foreground : t.muted)
                .cursor_pointer()
                .on_click(() => {
                  this.form.stage = stage;
                  this.formError = null;
                })
                .child(svg(ic(f.stage === stage ? "check" : "dot")).size(10).text_color(f.stage === stage ? t.foreground : t.dim))
                .child(stage),
            ),
          ),
      )
      .child(
        h_flex()
          .gap(10)
          .child(v_flex().flex_1().child(label("Start (YYYY-MM-DD)")).child(field("tb-start", this.startInput, false)))
          .child(v_flex().flex_1().child(label("End (YYYY-MM-DD)")).child(field("tb-end", this.endInput, false))),
      )
      .when(Boolean(this.error), (el) =>
        el.child(div().pt(8).text_size(11.5).text_color(t.blocked).child(this.error)),
      )
      .when(Boolean(this.formError), (el) =>
        el.child(div().pt(8).text_size(11.5).text_color(t.blocked).child(this.formError)),
      )
      .child(div().flex_1())
      .child(
        h_flex()
          .justify_end()
          .gap(8)
          .child(this.textButton(t, "tb-cancel", "Cancel", "x", () => closeOverlay(props().overlay), false))
          .child(this.error
            ? this.textButton(t, "tb-editor-retry", "Retry", "refresh", (e, cx) => {
                this.loading = true;
                this.load(cx);
              }, true)
            : this.loading
              ? div().text_size(11).text_color(t.muted).child("Reading board")
              : this.textButton(t, "tb-save", "Save", "check", (e, cx) => this.save(cx), true)),
      );
  }

  attach(t) {
    const task = this.doc?.tasks.find((x) => x.id === this.attachId) ?? null;
    const list = agents();
    return v_flex()
      .id("task-attach")
      .size_full()
      .p(16)
      .gap(6)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(14).font_semibold().child("Attach a live agent"))
      .child(div().text_size(11).text_color(t.dim).child("Observes the agent's real status. Attaching never starts or stops anything."))
      .when(Boolean(this.error || this.saveError), (el) =>
        el.child(
          v_flex().gap(4)
            .child(div().text_size(11.5).text_color(t.blocked).child(this.error || this.saveError))
            .child(this.textButton(t, "attach-retry", "Retry", "refresh", (e, cx) => {
              this.saveError = null;
              this.loading = true;
              this.load(cx);
            }, false)),
        ),
      )
      .child(
        v_flex()
          .id("agents")
          .flex_1()
          .min_h(0)
          .gap(4)
          .overflow_y_scrollbar()
          .children(
            this.error || this.loading ? [] : list.length === 0
              ? [div().text_size(11).text_color(t.dim).child("No agent is reporting a status in this window.")]
              : list.map((a) => {
                  const color = a.status === "blocked" ? t.blocked : a.status === "working" ? t.working : a.status === "done" ? t.done : t.idle;
                  const current = task?.agent?.address === a.address;
                  return h_flex()
                    .id(`ag-${a.address}`)
                    .h(30)
                    .px(8)
                    .gap(7)
                    .items_center()
                    .rounded(7)
                    .bg(current ? t.selected : t.raised)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((e, cx) => this.attachTo(a, cx))
                    .child(div().size(7).rounded(4).bg(color))
                    .child(div().flex_1().min_w(0).text_size(11.5).truncate().child(`${a.title || a.program?.name || a.address} · ${a.status}`))
                    .child(div().text_size(10).text_color(t.dim).child(a.space_name));
                }),
          ),
      )
      .child(
        h_flex()
          .justify_end()
          .gap(8)
          .when(Boolean(task?.agent), (el) =>
            el.child(this.textButton(t, "tb-detach", "Detach", "x", (e, cx) => this.attachTo(null, cx), false)),
          )
          .child(this.textButton(t, "tb-close", "Close", "check", () => closeOverlay(props().overlay), true)),
      );
  }

  attachTo(agent, cx) {
    const id = this.attachId;
    const overlay = props().overlay;
    if (!id) return;
    this.commit(
      cx,
      (doc) =>
        attachAgent(doc, id, agent ? { address: agent.address, space: agent.space, tab: agent.tab, title: agent.title, app: agent.app } : null),
      () => {
        if (overlay) closeOverlay(overlay);
      },
    );
  }

  // ---- view ----------------------------------------------------------------

  render(cx) {
    const t = theme();
    if (this.mode === "edit") {
      return v_flex()
        .id("tb-edit-root")
        .track_focus(this.handle)
        .on_key_down((e, cx) => {
          if (e.key === "escape") {
            closeOverlay(props().overlay);
            cx.stop_propagation();
          } else if (e.key === "enter" && (e.ctrl || e.meta)) {
            this.save(cx);
            cx.stop_propagation();
          }
        })
        .size_full()
        .min_h(0)
        .child(this.editor(t));
    }
    if (this.mode === "attach") {
      return v_flex()
        .id("tb-attach-root")
        .track_focus(this.handle)
        .on_key_down((e, cx) => {
          if (e.key === "escape") {
            closeOverlay(props().overlay);
            cx.stop_propagation();
          }
        })
        .size_full()
        .min_h(0)
        .child(this.attach(t));
    }

    const body = this.loading
      ? this.stateCard(t, "refresh", "Reading the board", "Loading data/task-board/board.json", null)
      : this.error
        ? this.stateCard(
            t,
            "x",
            "Task board could not be read",
            this.error,
            this.textButton(t, "tb-retry", "Retry", "refresh", (e, cx) => {
              this.loading = true;
              this.load(cx);
            }, true),
          )
        : !this.doc || this.doc.tasks.length === 0
          ? this.stateCard(t, "board", "No tasks yet", "Create a task to plan real work. Dates stay empty until you set them.", this.textButton(t, "tb-new", "New task", "edit", () => this.openNew(), true))
          : this.view === "gantt"
            ? this.gantt(t, this.doc.tasks)
            : this.board(t, this.doc.tasks);

    return v_flex()
      .id("task-board")
      .track_focus(this.handle)
      .when(Boolean(props()?.overlay), (el) =>
        el.on_key_down((e, cx) => {
          if (e.key === "escape") {
            closeOverlay(props().overlay);
            cx.stop_propagation();
          }
        }),
      )
      .size_full()
      .min_h(0)
      .bg(t.background)
      .on_size_change((size, cx) => {
        this.size = size;
        cx.notify();
      })
      .child(
        this.header(t, this.view === "gantt" ? "Gantt" : "Task board", [
          h_flex()
            .id("tb-search")
            .w(180)
            .h(24)
            .px(6)
            .items_center()
            .rounded(7)
            .border_1()
            .border_color(t.input)
            .bg(t.background)
            .child(svg(ic("search")).size(11).text_color(t.dim))
            .child(
              v_flex().flex_1().min_w(0).child(
                Input.new(this.query).h(22).text_size(11.5).text_color(t.foreground),
              ),
            ),
          this.iconButton(t, "tb-new-btn", "edit", () => this.openNew()),
          this.iconButton(t, "tb-retry-btn", "refresh", (e, cx) => this.load(cx)),
          this.textButton(t, "tb-switch", this.view === "gantt" ? "Board" : "Gantt", this.view === "gantt" ? "board" : "gantt", (e, cx) => {
            this.view = this.view === "gantt" ? "board" : "gantt";
            cx.notify();
          }, false),
        ]),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .p(8)
          .children([
            body,
            this.saveError
              ? h_flex()
                  .id("tb-banner")
                  .h(30)
                  .px(8)
                  .gap(6)
                  .items_center()
                  .rounded(6)
                  .bg(t.blocked)
                  .text_size(11)
                  .text_color(t.canvas)
                  .child(div().flex_1().min_w(0).truncate().child(this.saveError))
                  .child(this.iconButton(t, "tb-dismiss", "x", (e, cx) => {
                    this.saveError = null;
                    cx.notify();
                  }))
              : div().h(0),
          ]),
      );
  }

  openNew() {
    openOverlay({
      mod: "task-board",
      kind: "dialog",
      width: 520,
      height: 430,
      props: { mode: "edit", task: { stage: STAGES[0] } },
    });
  }
}

const dayLabel = (value) => new Date(value * 86400000).toISOString().slice(0, 10);
