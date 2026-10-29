import { randomUUID } from "node:crypto";

export const PRIORITIES = ["low", "medium", "high"];

const UPDATABLE_FIELDS = ["title", "done", "priority"];

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

  list() {
    return [...this.#tasks.values()];
  }

  update(id, changes) {
    const task = this.#tasks.get(id);
    if (!task) return null;
    for (const key of UPDATABLE_FIELDS) {
      if (key in changes) task[key] = changes[key];
    }
    return task;
  }

  delete(id) {
    return this.#tasks.delete(id);
  }
}
