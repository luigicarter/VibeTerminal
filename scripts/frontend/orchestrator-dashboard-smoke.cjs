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
const runtimePath = path.resolve(path.dirname(sourcePath), "../terminalRuntime.ts");
const runtime = new Module(runtimePath, module);
runtime._compile(ts.transpileModule(fs.readFileSync(runtimePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, runtimePath);
const originalRequire = helper.require.bind(helper);
helper.require = id => id === "../terminalRuntime" ? runtime.exports : originalRequire(id);
helper._compile(compiled, sourcePath);
const { dashboardLayout, dashboardScale, dashboardSessionVisible, dashboardStatus, dashboardSessionMetadata, dashboardTargeted, dashboardSessionTitle, dashboardProvider, dashboardSessionOrder, dashboardRecency } = helper.exports;

// All possible simultaneous enlargements and drift must fit on one page.
for (const viewport of [0, 132, 180, 212, 260, 272, 320, 600, 1000, 1600]) {
  for (const height of [0, 160, 600, 1000]) for (const count of [0, 1, 2, 6, 20, 31]) {
    const layout = dashboardLayout(viewport, count, height);
    assert.ok(layout.diameter <= 232 && layout.diameter >= 220);
    assert.ok(Number.isFinite(layout.width) && layout.columns >= 1);
    assert.ok(Number.isFinite(layout.fitScale)&&layout.fitScale>=0&&layout.fitScale<=1);
    assert.ok(layout.width*layout.fitScale<=viewport+.001&&layout.height*layout.fitScale<=height+.001, "The full field fits both dimensions without scrolling");
    if(viewport&&height&&count) assert.ok(layout.fitScale>0, "Nonempty viewports retain visible bubbles");
    for (const activeIndices of [[], Array.from({ length: count }, (_, i) => i), [0], [1, 3, 5]]) {
      const circles = Array.from({ length: count }, (_, i) => ({
        x: layout.positions[i].x + layout.slot / 2,
        y: layout.positions[i].y + layout.slot / 2,
        radius: layout.diameter * dashboardScale(activeIndices.includes(i), activeIndices.length > 0, `session-${i}`) / 2 + layout.halo
      }));
      for (const [i, circle] of circles.entries()) {
        assert.ok(circle.x - circle.radius >= 0 && circle.x + circle.radius <= layout.width);
        assert.ok(circle.y - circle.radius >= 0 && circle.y + circle.radius <= layout.height);
        for (const other of circles.slice(i + 1)) assert.ok(Math.hypot(circle.x - other.x, circle.y - other.y) >= circle.radius + other.radius + 23.99, "No active set overlaps; reserved circles retain a 24px gap");
      }
    }
  }
}
for(const dimension of [NaN,Infinity,-100]) assert.equal(dashboardLayout(dimension,6,500).fitScale,0);
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
for (const [status, expected] of [["running", "working"], ["waiting", "needs-you"], ["done", "done"], ["failed", "error"], ["idle", "idle"], ["starting", "starting"], ["response", "response"], ["something new", "unknown"]]) assert.equal(dashboardStatus({ ...session, status }), expected);
for (const statusLabel of ["unobserved", "observing"]) assert.equal(dashboardStatus({ ...session, statusLabel }), "unknown", "Do not guess from a coarse running status");
for (const statusLabel of ["awaiting activity", "interrupt requested"]) assert.equal(dashboardStatus({ ...session, statusLabel }), "pending");
assert.equal(dashboardStatus({ ...session, statusLabel: "response available" }), "response");
const current = { ...session, revision: 12, status: "waiting" };
assert.equal(dashboardStatus(dashboardSessionMetadata(current, { ...session, revision: 11, statusLabel: "working" })), "needs-you", "Older renderer revisions cannot override live state");
assert.equal(dashboardSessionMetadata(current, { ...session, revision: 12, generation: "old", statusLabel: "working" }).statusLabel, undefined);
const native = { ...current, provider: "codex", processState: "running", agentProcessState: "running", turnState: "completed", children: [], observation: "observed", telemetryHealth: "available" };
const projectedStatus = patch => dashboardStatus(dashboardSessionMetadata({ ...native, ...patch }, { ...current, statusLabel: "working" }));
assert.equal(projectedStatus({}), "done");
assert.equal(projectedStatus({ observation: "provisional" }), "response", "Provisional completion is not confirmed Done");
assert.equal(projectedStatus({ observation: "unavailable" }), "unknown");
assert.equal(projectedStatus({ turnState: "unknown", provider: "terminal" }), "idle");
assert.equal(projectedStatus({ pendingInput: "submit" }), "pending");
assert.equal(projectedStatus({ turnState: "waiting" }), "needs-you");
assert.equal(projectedStatus({ children: [{ id: "child" }] }), "working");
const cloud = dashboardLayout(1600, 20, 1000);
assert.ok(new Set(cloud.positions.slice(0, cloud.columns).map(p => Math.round(p.y))).size > 1, "Bubbles do not form a rigid horizontal row");
const appended = dashboardLayout(1600, 21, 1000);
assert.equal(appended.columns,cloud.columns);
assert.deepEqual(appended.positions.slice(0, 20), cloud.positions, "Appending within the same column count keeps logical centers stable");
assert.ok(dashboardLayout(320,31,600).fitScale<dashboardLayout(320,6,600).fitScale, "Adding sessions scales the bubbles down");
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
  const layout = dashboardLayout(1600, 20, 1000);
  const resting = dashboardScale(false, false, id), subdued = dashboardScale(false, true, id);
  assert.ok(layout.diameter*resting>=160&&layout.diameter*resting<=200);
  assert.ok(subdued<resting&&subdued>=.64&&dashboardScale(true,true,id)===1);
}
const personalities=Array.from({length:30},(_,i)=>`session-${i}`);
assert.ok(new Set(personalities.map(id=>dashboardScale(false,false,id))).size>10, "Sessions have varied stable resting sizes");
const css = fs.readFileSync(path.resolve(path.dirname(sourcePath), "orchestratorDashboard.css"), "utf8");
const component = fs.readFileSync(path.resolve(path.dirname(sourcePath), "OrchestratorDashboard.tsx"), "utf8");
assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?transition: none/);
assert.match(css, /transition: transform 320ms cubic-bezier/);
assert.match(component, /document\.addEventListener\("visibilitychange"/);
assert.match(component, /document\.removeEventListener\("visibilitychange"/);
assert.match(component, /cancelAnimationFrame/);
const motionPath=path.resolve(path.dirname(sourcePath),'orchestratorBubbleMotion.ts');
const motionModule=new Module(motionPath,module);
motionModule._compile(ts.transpileModule(fs.readFileSync(motionPath,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,motionPath);
const {createBubbleMotion,stepBubbleMotion}=motionModule.exports;
function motionBounds(bodies,width,height) {
  for(const [i,a] of bodies.entries()) {
    assert.ok(a.x>=a.radius+18-.01&&a.x<=width-a.radius-18+.01&&a.y>=a.radius+18-.01&&a.y<=height-a.radius-18+.01,'Floating bodies and glow remain inside walls');
    for(const b of bodies.slice(i+1)) assert.ok(Math.hypot(a.x-b.x,a.y-b.y)>=a.radius+b.radius-.01,'Floating bodies meet without overlapping');
  }
}
for(const count of [1,6,31]) {
  const layout=dashboardLayout(400,count,800),width=400/layout.fitScale,height=800/layout.fitScale;
  const bodies=layout.positions.map((p,i)=>createBubbleMotion(`fixture-${i}`,p.x+layout.slot/2+(width-layout.width)/2,p.y+layout.slot/2+(height-layout.height)/2,130));
  const start=bodies.map(b=>({x:b.x,y:b.y}));let travel=0;
  for(let frame=0;frame<3600;frame++) {
    stepBubbleMotion(bodies,width,height,1/60);motionBounds(bodies,width,height);
    travel=Math.max(travel,...bodies.map((b,i)=>Math.hypot(b.x-start[i].x,b.y-start[i].y)));
  }
  assert.ok(travel>200,'Bubbles can roam beyond their original cells');
}
const left={...createBubbleMotion('left',130,200,30),vx:20,vy:0},right={...createBubbleMotion('right',189,200,30),vx:-20,vy:0};
stepBubbleMotion([left,right],500,500,.05);motionBounds([left,right],500,500);assert.ok(left.vx<0&&right.vx>0,'Approaching bubbles bounce apart');
assert.ok(left.impact>0&&right.impact>0,'Actual approaching contact produces visible deformation');
for(let i=0;i<120;i++)stepBubbleMotion([left,right],500,500,1/60);
assert.ok(left.impact<.001&&right.impact<.001,'Collision deformation settles without repeated artificial pulses');
const frozen={...createBubbleMotion('frozen',200,200,30),frozen:true};
const incoming={...createBubbleMotion('incoming',141,200,30),vx:20,vy:0};const held={...frozen};
stepBubbleMotion([incoming,frozen],500,500,.05);assert.deepEqual(frozen,held);assert.ok(incoming.vx<0);motionBounds([incoming,frozen],500,500);
const wall={...createBubbleMotion('wall',49,100,30),vx:-25,vy:0};stepBubbleMotion([wall],300,300,5);assert.equal(wall.x,48);assert.ok(wall.vx>0&&wall.impact>0);
const apart=[{...createBubbleMotion('apart-a',100,100,30),vx:-10,vy:0},{...createBubbleMotion('apart-b',159,100,30),vx:10,vy:0}];
stepBubbleMotion(apart,500,500,.05);assert.ok(apart.every(b=>b.impact===0),'Geometric correction of separating bodies must not fake a collision');
const capped={...createBubbleMotion('pause',500,500,30),vx:20,vy:0};stepBubbleMotion([capped],1000,1000,100);assert.equal(capped.x,501,'A paused frame cannot launch a bubble across the field');
const growingWall={...createBubbleMotion('growing-wall',70,200,30),frozen:true,radius:70};stepBubbleMotion([growingWall],500,500,1/60);assert.equal(growingWall.x,88);assert.equal(growingWall.impact,0);
const growingPair=[{...createBubbleMotion('grow-a',200,200,30),frozen:true,radius:60},{...createBubbleMotion('grow-b',270,200,30),frozen:true,radius:60}];
stepBubbleMotion(growingPair,500,500,1/60);motionBounds(growingPair,500,500);assert.ok(growingPair.every(b=>b.impact===0),'Expansion repairs placement without pretending two stationary bubbles collided');
assert.deepEqual(createBubbleMotion('stable',100,100,30),createBubbleMotion('stable',100,100,30));
console.log("Orchestrator dashboard smoke passed: fitting, identity, lifecycle, titles, recency, free roaming, collisions, frozen bubbles and wall bounds.");
