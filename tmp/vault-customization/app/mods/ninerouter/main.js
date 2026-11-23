// 9Router status and lifecycle for the vault-owned launcher. Contract from the
// launcher's own source:
//   rust-script <LAUNCHER> status|start|stop [--vault <vault>]
// status -> {"ok":true,"owned":…,"installed":…,"version":…,"port":20129,
//            "baseUrl":"http://127.0.0.1:20129","healthy":…,"authenticated":…,
//            "running":…,"pid":…,"apiKeyConfigured":…}
// start  -> {"ok":true,"running":…,"alreadyRunning":…,"pid":…,"version":…,"port":…,"apiKeyConfigured":…}
// stop   -> {"ok":true,"running":false,"stopped":true,"pid":…}
// Failure: exit 1 with a one-line JSON {"ok":false,"error":"…"} on stderr.
// The mod never calls api-key, never kills a process and never retries a
// foreign-listener refusal with force.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import { exec, theme, checking, window, notify, props, openOverlay, closeOverlay, shared, setShared } from "herdr";

const VAULT = "D:/__CODING/personal/__my-vault";
const LAUNCHER = `${VAULT}/.fatih-agentic-tools/scripts/ninerouter-vault.rs`;
const POLL_MS = 15000;
const START_WAIT_MS = 240000;
const START_EXEC_MS = 600000;
const STARTING_KEY = "ninerouter-starting";
const FALLBACK_URL = "http://127.0.0.1:20129";
const ic = (name) => `mods/ninerouter/icons/${name}.svg`;

export default class NineRouter extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.status = null; // last ok:true status object
    this.error = null;
    this.busy = null; // "status" | "start" | "stop"
    this.ensured = false;
    this.at = null;
    this.compact = props()?.compact === true;
    // Only the permanent status-row instance performs automatic startup.
    if (checking()) {
      this.note = "check mode: launcher not invoked";
      return;
    }
    if (this.compact) this.ensure(cx);
    else this.refresh(cx);
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
  }

  async call(cmd, timeout) {
    let r;
    try {
      r = await exec("rust-script", [LAUNCHER, cmd, "--vault", VAULT], {
        timeout: timeout ?? (cmd === "start" ? START_EXEC_MS : 30000),
      });
    } catch {
      return { ok: false, error: `Router ${cmd} failed. Check the launcher and retry.` };
    }
    const text = (r.stdout ?? "").trim();
    const line = text.split("\n").filter(Boolean).pop() ?? "";
    let doc = null;
    try {
      doc = JSON.parse(line);
    } catch {
      doc = null;
    }
    if (r.code !== 0 || !doc || doc.ok !== true) {
      let launcherError;
      try { launcherError = JSON.parse((r.stderr ?? "").trim()).error; } catch {}
      if (launcherError === "port 20129 is held by a foreign router; refusing to start or stop it" ||
          launcherError === "port 20129 is held by another program and no vault credential exists; refusing to interfere")
        return { ok: false, error: "Port 20129 is occupied by a foreign listener. The router was not started; resolve the conflict and retry." };
      return { ok: false, error: `Router ${cmd} failed. Check the launcher or port and retry.` };
    }
    if (cmd === "status" && typeof doc.running !== "boolean")
      return { ok: false, error: "Router status is invalid. Check the launcher and retry." };
    return doc;
  }

  ensure(cx) {
    if (this.ensured) return;
    this.ensured = true;
    cx.spawn(async (cx) => {
      this.busy = "status";
      cx.notify();
      let s = null;
      try {
        s = await this.call("status");
      } finally {
        // Release the status slot before starting, or doStart would see a busy panel.
        this.busy = null;
      }
      if (!s || !s.ok) {
        if (s && !s.ok) this.error = s.error;
        cx.notify();
        return;
      }
      this.status = s;
      this.at = new Date().toLocaleTimeString();
      if (s.running === false) await this.doStart(cx, true);
      cx.notify();
    });
  }

  refresh(cx) {
    if (this.busy) return;
    cx.spawn(async (cx) => {
      this.busy = "status";
      cx.notify();
      try {
        const s = await this.call("status");
        if (s.ok) {
          this.status = s;
          this.error = null;
          this.at = new Date().toLocaleTimeString();
          if (s.running && s.healthy && s.authenticated && s.owned && s.apiKeyConfigured) setShared(STARTING_KEY, false);
        } else this.error = s.error;
      } finally {
        this.busy = null;
        cx.notify();
      }
    });
  }

  // The one start path, shared by the button and the ensure-once start. It takes
  // the busy slot itself, so a click during the status read cannot start twice.
  async doStart(cx, silent) {
    if (this.busy || shared(STARTING_KEY)) return false;
    this.busy = "start";
    this.error = null;
    const token = `${Date.now()}-${Math.random()}`;
    setShared(STARTING_KEY, token);
    cx.notify();
    let startResult = null;
    let observedHealthy = false;
    try {
      // The host can await inherited output pipes after the launcher exits.
      // Observe status independently rather than treating that wait as failure.
      this.call("start", START_EXEC_MS).then(
        (result) => { startResult = result; if (!this.busy && shared(STARTING_KEY) === token) setShared(STARTING_KEY, false); },
        () => { startResult = { ok: false, error: "Router start failed. Check the launcher and retry." }; if (!this.busy && shared(STARTING_KEY) === token) setShared(STARTING_KEY, false); },
      ).catch(() => {});
      const deadline = Date.now() + START_WAIT_MS;
      while (Date.now() < deadline) {
        const s = await this.call("status", 15000);
        if (s.ok) {
          this.status = s;
          this.at = new Date().toLocaleTimeString();
          cx.notify();
          if (s.running === true && s.healthy === true && s.authenticated === true &&
              s.owned === true && s.apiKeyConfigured === true) {
            observedHealthy = true;
            if (!silent) notify({ title: "9Router healthy", body: "The owned router is responding." });
            return true;
          }
        }
        if (startResult && !startResult.ok) {
          this.error = startResult.error;
          return false;
        }
        await cx.sleep(1200);
      }
      this.error = "Startup is still unconfirmed after 4 minutes. Refresh status before retrying.";
      return false;
    } catch {
      this.error = "Router start failed. Check the launcher and retry.";
      return false;
    } finally {
      this.busy = null;
      if ((observedHealthy || startResult) && shared(STARTING_KEY) === token) setShared(STARTING_KEY, false);
      cx.notify();
    }
  }

  start(cx, silent) {
    if (this.busy) return;
    cx.spawn(async (cx) => {
      await this.doStart(cx, silent);
    });
  }

  stop(cx) {
    if (this.busy) return;
    cx.spawn(async (cx) => {
      this.busy = "stop";
      this.error = null;
      cx.notify();
      try {
        const r = await this.call("stop");
        if (!r.ok) this.error = r.error;
        const s = await this.call("status");
        if (s.ok) {
          this.status = s;
          this.at = new Date().toLocaleTimeString();
          if (s.running === true) this.error = "Stop returned but the router still reports running.";
        } else this.error = s.error;
      } finally {
        this.busy = null;
        cx.notify();
      }
    });
  }

  dashboard(cx) {
    const url = this.status?.baseUrl ?? FALLBACK_URL;
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) {
      this.error = "Refusing to open a non-loopback dashboard URL.";
      cx.notify();
      return;
    }
    cx.spawn(async (cx) => {
      try {
        const p = window()?.platform;
        const result = p === "macos" ? await exec("open", [url])
          : p === "windows" ? await exec("cmd", ["/c", "start", "", url])
          : await exec("xdg-open", [url]);
        if (result.code !== 0) this.error = "Could not open the router dashboard.";
      } catch {
        this.error = "Could not open the router dashboard.";
      }
      cx.notify();
    });
  }

  button(t, id, label, iconName, onclick, opts = {}) {
    const disabled = Boolean(this.busy) || (Boolean(shared(STARTING_KEY)) && (id === "nr-start" || id === "nr-stop")) || opts.disabled;
    return h_flex()
      .id(id)
      .h(26)
      .px(9)
      .gap(6)
      .items_center()
      .rounded(7)
      .border_1()
      .border_color(opts.primary ? t.solid : t.input)
      .bg(opts.primary ? t.solid : t.raised)
      .text_color(opts.primary ? t.solid_foreground : t.foreground)
      .text_size(12)
      .cursor_pointer()
      .when(disabled, (el) => el.opacity(0.45))
      .on_click((e, cx) => {
        if (disabled) return;
        onclick(cx);
      })
      .child(svg(ic(iconName)).size(12))
      .child(label);
  }

  truth(t, label, value) {
    const on = value === true;
    const known = typeof value === "boolean";
    return h_flex()
      .gap(4)
      .items_center()
      .child(div().size(6).rounded(3).bg(on ? t.done : known ? t.blocked : t.dim))
      .child(div().text_size(10.5).text_color(known ? t.muted : t.dim).child(`${label} ${known ? (on ? "yes" : "no") : "unknown"}`));
  }

  render(cx) {
    const t = theme();
    const s = this.status;
    if (this.compact) {
      const running = s?.running === true;
      const healthy = s?.healthy === true && s?.authenticated === true && s?.owned === true && s?.apiKeyConfigured === true;
      const dot = this.error ? t.blocked : running && healthy ? t.done : running ? t.working : t.idle;
      const label = this.busy
        ? `9Router ${this.busy === "start" ? "starting" : "checking"}`
        : this.error
          ? "9Router error"
          : !s
            ? "9Router not checked"
            : running && healthy
              ? "9Router healthy"
              : running
                ? "9Router unavailable"
                : "9Router stopped";
      return h_flex()
        .id("ninerouter-chip")
        .size_full()
        .px(10)
        .gap(6)
        .items_center()
        .bg(t.chrome)
        .border_t(1)
        .border_color(t.border)
        .cursor_pointer()
        .hover((st) => st.bg(t.hover))
        .on_click(() =>
          openOverlay({
            mod: "ninerouter",
            kind: "window",
            key: "ninerouter-control",
            width: 440,
            height: 380,
            props: { assumeOwned: true },
          }),
        )
        .child(svg(ic("router")).size(12).text_color(t.muted))
        .child(div().size(6).rounded(3).bg(dot))
        .child(div().text_size(10.5).text_color(this.error ? t.blocked : t.muted).truncate().child(label));
    }
    const running = s?.running === true;
    const healthy = s?.healthy === true && s?.authenticated === true && s?.owned === true && s?.apiKeyConfigured === true;
    const dot = this.error ? t.blocked : running && healthy ? t.done : running ? t.working : t.idle;
    const label = this.busy
      ? `9Router · ${this.busy}…`
      : this.error
        ? "9Router · error"
        : !s
          ? "9Router · not checked"
          : running && healthy
            ? "9Router · healthy"
            : running
              ? "9Router · unavailable"
              : "9Router · stopped";
    return v_flex()
      .id("ninerouter")
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
      .p(10)
      .gap(8)
      .bg(t.background)
      .text_size(12)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(svg(ic("router")).size(15).text_color(t.muted))
          .child(div().size(7).rounded(4).bg(dot))
          .child(div().flex_1().font_semibold().text_color(t.foreground).child(label))
          .child(div().text_size(10.5).text_color(t.dim).child(this.at ?? this.note ?? "not checked"))
          .when(Boolean(props()?.overlay), (el) =>
            el.child(
              Button.new("nr-close-window")
                .h(24).px(9).gap(6).items_center().rounded(7)
                .border_1().border_color(t.input).bg(t.raised)
                .text_color(t.foreground).text_size(12).cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .focus((s) => s.border_color(t.accent))
                .on_click(() => closeOverlay(props().overlay))
                .child(svg("mods/task-board/icons/x.svg").size(11))
                .child("Close"),
            ),
          ),
      )
      .child(
        v_flex()
          .gap(4)
          .child(
            h_flex()
              .gap(10)
              .children([
                this.truth(t, "running", s?.running),
                this.truth(t, "healthy", s?.healthy),
                this.truth(t, "authed", s?.authenticated),
              ]),
          )
          .child(
            h_flex()
              .gap(10)
              .children([
                this.truth(t, "owned", s?.owned),
                this.truth(t, "installed", s?.installed),
                this.truth(t, "api key", s?.apiKeyConfigured),
              ]),
          ),
      )
      .child(
        h_flex()
          .gap(6)
          .child(this.button(t, "nr-start", "Start", "play", (cx) => this.start(cx), { primary: true, disabled: running }))
          .child(this.button(t, "nr-stop", "Stop", "stop", (cx) => this.stop(cx), { disabled: !running }))
          .child(this.button(t, "nr-refresh", "Refresh", "refresh", (cx) => this.refresh(cx)))
          .child(this.button(t, "nr-dash", "Dashboard", "external", (cx) => this.dashboard(cx))),
      )
      .when(Boolean(this.error), (el) =>
        el.child(
          v_flex()
            .id("nr-error")
            .gap(4)
            .p(8)
            .rounded(7)
            .bg(t.raised)
            .border_1()
            .border_color(t.blocked)
            .child(div().text_size(11.5).text_color(t.blocked).child(this.error))
            .child(
              h_flex()
                .justify_end()
                .child(this.button(t, "nr-retry", "Retry", "refresh", (cx) => this.refresh(cx))),
            ),
        ),
      )
      .child(div().flex_1().min_h(0))
      .child(
        v_flex()
          .id("nr-detail")
          .gap(3)
          .child(div().text_size(10.5).text_color(t.muted).child(`version ${s?.version ?? "n/a"} · port ${s?.port ?? "n/a"} · pid ${s?.pid ?? "n/a"}`))
          .child(div().text_size(10).text_color(t.dim).child(s?.baseUrl ?? FALLBACK_URL))
          .child(div().text_size(10).text_color(t.dim).child(`launcher ${LAUNCHER}`)),
      );
  }
}
