import { randomUUID } from "node:crypto";

export const PRIORITIES = ["low", "medium", "high"];

export class ValidationError extends Error {}

/** In-memory task store. Swap for a database later. */
export class TaskStore {
  #tasks = new Map();

  create({ title, priority = "medium" }) {
    if (typeof title !== "string" || title.trim() === "") {
      throw new ValidationError("title is required");
    }
    if (!PRIORITIES.includes(priority)) {
      throw new ValidationError(`priority must be one of: ${PRIORITIES.join(", ")}`);
    }
    const task = {
      id: randomUUID(),
      title: title.trim(),
      priority,
      done: false,
      createdAt: new Date().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return task;
  }

  get(id) {
    return this.#tasks.get(id) ?? null;
  }

  list({ priority, done } = {}) {
    return [...this.#tasks.values()].filter(
      (t) =>
        (priority === undefined || t.priority === priority) &&
        (done === undefined || t.done === done),
    );
  }

  update(id, changes) {
    const task = this.#tasks.get(id);
    if (!task) return null;
    Object.assign(task, changes);
    return task;
  }

  delete(id) {
    return this.#tasks.delete(id);
  }
}
