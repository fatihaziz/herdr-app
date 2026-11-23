// Icon+label launchers for the customization's surfaces. Board/Gantt/Router
// select the layout panel stack, so no second copy is docked; the rest use
// mod.open, which toggles that mod's own place.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, openOverlay } from "herdr";

const ic = (name) => `mods/launch-bar/icons/${name}.svg`;

const ITEMS = [
  { id: "board", label: "Board", icon: "board", view: "board" },
  { id: "gantt", label: "Gantt", icon: "gantt", view: "gantt" },
  { id: "search", label: "Find", icon: "search", mod: "session-search" },
  { id: "git", label: "Git", icon: "git", mod: "git" },
  { id: "servers", label: "Servers", icon: "servers", mod: "servers" },
  { id: "leader", label: "Leader", icon: "leader", mod: "leader" },
  { id: "usage", label: "Usage", icon: "usage", mod: "token-usage" },
  { id: "log", label: "Log", icon: "log", mod: "convo-log" },
  { id: "schedule", label: "Sched", icon: "schedule", mod: "task-sched" },
  { id: "router", label: "Router", icon: "router", router: true },
];

export default class LaunchBar extends View {
  open(item) {
    if (item.router) {
      openOverlay({
        mod: "ninerouter",
        kind: "window",
        key: "ninerouter-control",
        width: 440,
        height: 380,
        props: { assumeOwned: true },
      });
      return;
    }
    if (item.view) {
      openOverlay({
        mod: "task-board",
        kind: "window",
        key: `task-board-${item.view}`,
        width: 1120,
        height: 720,
        props: { view: item.view },
      });
      return;
    }
    if (item.panel) {
      run("layout.show", { id: "panel" });
      run("layout.select", { stack: "panel-body", child: item.panel });
      return;
    }
    run("mod.open", { name: item.mod });
  }

  render() {
    const t = theme();
    return h_flex()
      .id("launch-bar")
      .size_full()
      .px(6)
      .gap(4)
      .items_center()
      .bg(t.chrome)
      .children(
        ITEMS.map((item) =>
          h_flex()
            .id(`launch-${item.id}`)
            .h(24)
            .px(7)
            .gap(5)
            .items_center()
            .rounded(6)
            .border_1()
            .border_color(t.border)
            .bg(t.raised)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.open(item))
            .child(svg(ic(item.icon)).size(12).text_color(t.muted))
            .child(div().text_size(11).text_color(t.muted).child(item.label)),
        ),
      );
  }
}
