import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { TaskStore } from "./store.js";

/** TaskStore that persists to a JSON file after every mutation. */
export class FileTaskStore extends TaskStore {
  #path;

  constructor(path) {
    super();
    this.#path = path;
    // TODO: load existing tasks from disk on startup
  }

  #save() {
    writeFileSync(this.#path, JSON.stringify(this.list(), null, 2));
  }

  static exists(path) {
    return existsSync(path);
  }

  static read(path) {
    return JSON.parse(readFileSync(path, "utf8"));
  }

  create(input) {
    const task = super.create(input);
    this.#save();
    return task;
  }

  update(id, changes) {
    const task = super.update(id, changes);
    this.#save();
    return task;
  }

  delete(id) {
    const ok = super.delete(id);
    this.#save();
    return ok;
  }
}
