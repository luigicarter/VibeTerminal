const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const sourcePath = path.resolve(__dirname, "../../frontend/components/orchestratorDashboardLayout.ts");
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const helper = new Module(sourcePath, module);
helper.filename = sourcePath;
helper.paths = Module._nodeModulePaths(path.dirname(sourcePath));
helper._compile(compiled, sourcePath);
const { dashboardLayout, dashboardScale, dashboardSessionVisible, dashboardStatus, dashboardTargeted, dashboardSessionTitle, dashboardProvider, dashboardSessionOrder, dashboardRecency, dashboardDrift } = helper.exports;

// All possible simultaneous enlargements must fit, even when the viewport needs scrolling.
for (const viewport of [0, 132, 180, 212, 260, 272, 320, 600, 1000, 1600]) {
  for (const count of [0, 1, 2, 6, 20]) {
    const layout = dashboardLayout(viewport, count);
    assert.ok(layout.diameter <= 280 && layout.diameter >= 220);
    assert.ok(Number.isFinite(layout.width) && layout.columns >= 1);
    for (const activeIndices of [[], Array.from({ length: count }, (_, i) => i), [0], [1, 3, 5]]) {
      const circles = Array.from({ length: count }, (_, i) => ({
        x: (i % layout.columns) * (layout.slot + layout.gap) + layout.slot / 2,
        y: Math.floor(i / layout.columns) * (layout.slot + layout.gap) + layout.slot / 2,
        radius: layout.diameter * dashboardScale(activeIndices.includes(i), activeIndices.length > 0) / 2 + layout.halo
      }));
      for (const [i, circle] of circles.entries()) {
        assert.ok(circle.x - circle.radius >= 0 && circle.x + circle.radius <= layout.width);
        assert.ok(circle.y - circle.radius >= 0 && circle.y + circle.radius <= layout.height);
        for (const other of circles.slice(i + 1)) assert.ok(Math.hypot(circle.x - other.x, circle.y - other.y) >= circle.radius + other.radius + 23.99, "No active set overlaps; reserved circles retain a 24px gap");
      }
    }
    if (layout.width > viewport && count > 0) assert.equal(layout.columns, 1, "Only minimum readable cells require horizontal scrolling");
  }
}
const session = { id: "a", generation: "new", started: true, kind: "codex", name: "API", cwd: "C:\\Projects\\API", status: "running" };
assert.equal(dashboardTargeted(session, [{ id: "a", generation: "old" }]), false);
assert.equal(dashboardTargeted({ ...session, generation: undefined }, [{ id: "a", generation: "new" }]), false);
assert.equal(dashboardTargeted(session, [{ id: "a", generation: "new" }]), true);
assert.equal(dashboardTargeted(session, [{ id: "b", generation: "new" }]), false);
assert.equal(dashboardSessionVisible({ ...session, started: false }), false);
assert.equal(dashboardSessionVisible({ ...session, processState: "exited" }), false);
assert.equal(dashboardSessionVisible({ ...session, agentProcessState: "failed" }), false);
assert.equal(dashboardSessionVisible({ ...session, kind: "terminal", agentProcessState: "exited" }), true);
assert.equal(dashboardSessionVisible({ ...session, processState: "running", status: "failed" }), true);
assert.equal(dashboardSessionVisible({ ...session, statusLabel: "paused" }), false);
for (const [status, expected] of [["running", "working"], ["waiting", "needs-you"], ["done", "done"], ["failed", "error"], ["idle", "idle"], ["starting", "unknown"], ["something new", "unknown"]]) assert.equal(dashboardStatus({ ...session, status }), expected);
for (const statusLabel of ["unobserved", "observing", "awaiting activity", "interrupt requested", "response available"]) assert.equal(dashboardStatus({ ...session, statusLabel }), "unknown", "Do not guess from a coarse running status");
const longTitle = "Conversation title ".repeat(120);
assert.equal(dashboardSessionTitle({ ...session, conversationTitle: longTitle }), longTitle.trim(), "Full accessible title is preserved; CSS ellipsis handles display");
assert.equal(dashboardSessionTitle({ ...session, threadRef: { title: "Stale" } }), "API", "A stale thread title cannot replace the current name");
assert.equal(dashboardSessionTitle({ ...session, name: " ", projectName: "Project" }), "Project");
assert.equal(dashboardProvider({ ...session, openFusion: true }), "Open Fusion");
assert.ok(dashboardScale(true, true) > dashboardScale(false, true));
assert.ok(dashboardScale(false, false) > dashboardScale(false, true));
const now = 1700000000000;
const before = [{ id: "unknown-a" }, { id: "old", lastUsedAt: now - 2 * 86400000 }, { id: "unknown-b" }, { id: "recent", lastUsedAt: now - 1000 }];
const openedOrder = dashboardSessionOrder(null, before);
assert.deepEqual(openedOrder, ["recent", "old", "unknown-a", "unknown-b"]);
assert.deepEqual(dashboardSessionOrder([], before), openedOrder, "The first asynchronously loaded inventory gets the opening recency sort");
const changed = before.map(item => ({ ...item, lastUsedAt: item.id === "old" ? now : item.lastUsedAt, status: "running" })).reverse();
assert.deepEqual(dashboardSessionOrder(openedOrder, changed), openedOrder, "Status, arrival order and newer interactions do not rearrange an open dashboard");
assert.deepEqual(dashboardSessionOrder(null, changed), ["old", "recent", "unknown-b", "unknown-a"], "A new visit intentionally uses the new recency ranking");
assert.deepEqual(dashboardSessionOrder(openedOrder, [{ id: "new", lastUsedAt: now }, ...changed]), [...openedOrder, "new"], "A new session appends without displacing existing centers");
assert.deepEqual(dashboardSessionOrder(null, [{ id: "one" }, { id: "two" }]), ["one", "two"], "Absent timestamps preserve input order");
assert.equal(dashboardRecency({ id: "old", lastUsedAt: now - 2 * 86400000 }, now, true).opacity, 1);
assert.equal(dashboardRecency({ id: "recent", lastUsedAt: now - 1000 }, now, false).recent, true);
assert.equal(dashboardRecency({ id: "unknown", lastActivityAt: now }, now, false).recent, false, "Agent output is not user interaction");
assert.equal(dashboardRecency({ id: "future", lastUsedAt: now + 1000 }, now, false).recent, false);
assert.ok(dashboardRecency({ id: "old", lastUsedAt: 1 }, now, false).opacity >= .9);
for (const id of ["a", "long-session-id", "b", "c", "recent", "unknown-b"]) {
  const drift = dashboardDrift(id);
  assert.deepEqual(drift, dashboardDrift(id));
  assert.ok(drift.duration >= 8 && drift.duration <= 12 && drift.distance <= 3);
  const layout = dashboardLayout(1600, 20);
  assert.ok(Math.hypot(drift.distance, drift.distance) <= layout.motionMargin, "Worst diagonal movement fits reserved margin");
  const maxRadius = layout.diameter / 2 + 12;
  for (const dx of [-drift.distance, drift.distance]) {
    assert.ok(layout.slot / 2 + dx - maxRadius >= 0);
    assert.ok(layout.slot / 2 + dx + maxRadius <= layout.slot);
    assert.ok(layout.slot + layout.gap - 2 * drift.distance - 2 * maxRadius >= 24, "Opposing drift preserves spacing even with both circles fully enlarged and focused");
  }
}
const css = fs.readFileSync(path.resolve(path.dirname(sourcePath), "orchestratorDashboard.css"), "utf8");
const component = fs.readFileSync(path.resolve(path.dirname(sourcePath), "OrchestratorDashboard.tsx"), "utf8");
assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?orchestrator-dashboard-drift\s*\{\s*animation: none/);
assert.match(css, /data-motion="false"[^}]+animation-play-state: paused/);
assert.match(css, /data-in-view="true"[^}]+animation-play-state: paused/);
assert.match(css, /transition: transform 320ms cubic-bezier/);
assert.match(component, /document\.addEventListener\("visibilitychange"/);
assert.match(component, /document\.removeEventListener\("visibilitychange"/);
assert.doesNotMatch(component, /requestAnimationFrame|setInterval|setTimeout/);
console.log("Orchestrator dashboard smoke passed: geometry, identity, lifecycle, titles, frozen recency order, drift bounds and motion safeguards.");
