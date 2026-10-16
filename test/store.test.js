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

test("update ignores immutable fields", () => {
  const store = new TaskStore();
  const task = store.create({ title: "Locked" });
  const { id, createdAt } = task;
  store.update(id, { id: "hacked", createdAt: "1970-01-01T00:00:00.000Z" });
  assert.equal(store.get(id).id, id);
  assert.equal(store.get(id).createdAt, createdAt);
});
