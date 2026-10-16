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

test("list({ overdue: true }) returns only incomplete past-due tasks", () => {
  const store = new TaskStore();
  store.create({ title: "Late", dueDate: "2020-01-01T00:00:00Z" });
  const done = store.create({ title: "Late but done", dueDate: "2020-01-01T00:00:00Z" });
  store.update(done.id, { done: true });
  store.create({ title: "Future", dueDate: "2999-01-01T00:00:00Z" });
  assert.deepEqual(store.list({ overdue: true }).map((t) => t.title), ["Late"]);
});
