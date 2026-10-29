import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { TaskStore } from "../src/store.js";

async function withServer(fn) {
  const server = createApp(new TaskStore());
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /health returns ok", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});
