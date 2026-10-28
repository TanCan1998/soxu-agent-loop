import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLocalRoadmap } from "../src/roadmap-local.mjs";

const task = (n, milestone, archived = false) => ({ id: "TASK-00" + n, number: n, title: "任务 " + n, milestone, archived, dependencies: [], priority: "P1" });

test("local roadmap groups tasks by milestone and derives merge state from checkpoints", () => {
  const tasks = [task(1,"M1",true), task(2,"M1",true), task(3,"M1"), task(4,"M2"), task(5,"M3",true), task(6,"M4"), task(7,null)];
  const progress = {
    done: [{ id: 1 }, { id: 2 }, { id: 5 }],
    running: [{ id: 3 }],
    paused: [],
    blocked: [{ id: 4 }],
    pending: [{ id: 6 }],
  };
  const roadmap = buildLocalRoadmap(tasks, progress);
  assert.equal(roadmap.source, "local");
  assert.equal(roadmap.limited, false);
  assert.equal(roadmap.unclassified, 1);
  const byId = Object.fromEntries(roadmap.stages.map(stage => [stage.id, stage]));
  assert.equal(byId.M1.total, 3);
  assert.equal(byId.M1.merged, 2);
  assert.equal(byId.M1.running, 1);
  assert.equal(byId.M2.paused, 1, "blocked counts as paused");
  assert.equal(byId.M3.merged, 1);
  assert.equal(byId.M4.merged, 0);
  assert.equal(byId.M0.total, 0);
  const m3 = byId.M3.items[0];
  assert.deepEqual({ number: m3.number, merged: m3.merged, state: m3.state, url: m3.url }, { number: 5, merged: true, state: "CLOSED", url: null });
  const m4 = byId.M4.items[0];
  assert.equal(m4.merged, false);
  assert.equal(m4.state, "OPEN");
});

test("archived tasks count as merged even without a checkpoint", () => {
  const roadmap = buildLocalRoadmap([task(9, "M2", true)], { done: [], running: [], paused: [], blocked: [], pending: [] });
  const m2 = roadmap.stages.find(stage => stage.id === "M2");
  assert.equal(m2.merged, 1);
  assert.equal(m2.items[0].localStatus, "done");
});
