import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTaskStore } from "../src/file-store.js";

test("tasks survive a restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "lumi-")), "tasks.json");
  const first = new FileTaskStore(file);
  const { id } = first.create({ title: "Persist me" });

  const second = new FileTaskStore(file);
  assert.equal(second.get(id)?.title, "Persist me");
});
