import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./server.js";

async function withServer(fn) {
  const server = createApp();
  await new Promise((r) => server.listen(0, r));
  try {
    await fn(`http://localhost:${server.address().port}`);
  } finally {
    server.close();
  }
}

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
