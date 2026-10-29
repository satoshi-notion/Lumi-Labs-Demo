import { randomUUID } from "node:crypto";

export const PRIORITIES = ["low", "medium", "high"];

function normalizeTags(tags = []) {
  if (!Array.isArray(tags) || tags.length > 5) {
    throw new ValidationError("tags must be an array of at most 5 strings");
  }
  return tags.map((tag) => {
    if (typeof tag !== "string" || tag.trim() === "" || tag.trim().length > 20) {
      throw new ValidationError("tags must contain strings of at most 20 characters");
    }
    return tag.trim().toLowerCase();
  });
}

export class ValidationError extends Error {}

/** In-memory task store. Swap for a database later. */
export class TaskStore {
  #tasks = new Map();

  create({ title, priority = "medium", tags = [] }) {
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
      tags: normalizeTags(tags),
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
    if (Object.hasOwn(changes, "tags")) changes = { ...changes, tags: normalizeTags(changes.tags) };
    Object.assign(task, changes);
    return task;
  }

  delete(id) {
    return this.#tasks.delete(id);
  }
}
