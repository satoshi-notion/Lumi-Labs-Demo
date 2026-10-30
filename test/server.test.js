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

test("POST /tasks with malformed JSON returns 400", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/tasks`, { method: "POST", body: "{not json" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /valid JSON/);
  });
});

test("POST /tasks with a valid body still returns 201", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Write tests" }),
    });
    assert.equal(res.status, 201);
  });
});
