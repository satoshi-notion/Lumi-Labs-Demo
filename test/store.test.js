import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskStore, ValidationError } from "../src/store.js";

test("create assigns an id and defaults done to false", () => {
  const store = new TaskStore();
  const task = store.create({ title: "Write docs" });
  assert.ok(task.id);
  assert.equal(task.done, false);
});

test("update modifies an existing task", () => {
  const store = new TaskStore();
  const { id } = store.create({ title: "Ship it" });
  assert.equal(store.update(id, { done: true }).done, true);
});

test("delete removes the task", () => {
  const store = new TaskStore();
  const { id } = store.create({ title: "Temp" });
  assert.equal(store.delete(id), true);
  assert.equal(store.get(id), null);
});

test("create rejects a missing or blank title", () => {
  const store = new TaskStore();
  assert.throws(() => store.create({}), ValidationError);
  assert.throws(() => store.create({ title: "   " }), ValidationError);
});

test("priority defaults to medium and rejects unknown values", () => {
  const store = new TaskStore();
  assert.equal(store.create({ title: "A" }).priority, "medium");
  assert.equal(store.create({ title: "B", priority: "high" }).priority, "high");
  assert.throws(() => store.create({ title: "C", priority: "urgent" }), ValidationError);
});

test("create and update normalize task tags", () => {
  const store = new TaskStore();
  const task = store.create({ title: "Tagged", tags: ["  Docs ", "API"] });
  assert.deepEqual(task.tags, ["docs", "api"]);
  assert.deepEqual(store.update(task.id, { tags: ["  Ship "] }).tags, ["ship"]);
});

test("create and update reject blank or non-string tags", () => {
  const store = new TaskStore();
  assert.throws(() => store.create({ title: "Blank tag", tags: ["   "] }), ValidationError);
  assert.throws(() => store.create({ title: "Numeric tag", tags: [123] }), ValidationError);

  const task = store.create({ title: "Tagged" });
  assert.throws(() => store.update(task.id, { tags: ["   "] }), ValidationError);
  assert.throws(() => store.update(task.id, { tags: [123] }), ValidationError);
});

test("list filters by priority and done", () => {
  const store = new TaskStore();
  store.create({ title: "a", priority: "high" });
  const b = store.create({ title: "b", priority: "low" });
  store.update(b.id, { done: true });
  assert.equal(store.list({ priority: "high" }).length, 1);
  assert.equal(store.list({ done: true }).length, 1);
  assert.equal(store.list({ priority: "high", done: true }).length, 0);
  assert.equal(store.list().length, 2);
});
