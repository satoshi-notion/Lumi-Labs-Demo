import { createServer } from "node:http";
import { TaskStore, ValidationError } from "./store.js";

const store = new TaskStore();

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export function createApp(taskStore = store) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const [, resource, id] = url.pathname.split("/");

    if (resource === "health" && req.method === "GET") return send(res, 200, { status: "ok" });
    if (resource !== "tasks") return send(res, 404, { error: "Not found" });

    try {
      if (req.method === "GET" && !id) return send(res, 200, taskStore.list());
      if (req.method === "POST" && !id) {
        return send(res, 201, taskStore.create(await readJson(req)));
      }
      if (req.method === "GET" && id) {
        const task = taskStore.get(id);
        return task ? send(res, 200, task) : send(res, 404, { error: "Not found" });
      }
      if (req.method === "PATCH" && id) {
        const task = taskStore.update(id, await readJson(req));
        return task ? send(res, 200, task) : send(res, 404, { error: "Not found" });
      }
      if (req.method === "DELETE" && id) {
        return taskStore.delete(id)
          ? send(res, 204)
          : send(res, 404, { error: "Not found" });
      }
      send(res, 405, { error: "Method not allowed" });
    } catch (err) {
      const message = err instanceof ValidationError ? err.message : "Invalid JSON";
      send(res, 400, { error: message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT ?? 3000;
  createApp().listen(port, () => console.log(`Lumi Tasks API on :${port}`));
}
