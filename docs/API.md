# API Reference

Base URL: `http://localhost:3000`

## Create a task

```bash
curl -X POST localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Write docs", "priority": "high"}'
```

```json
{
  "id": "6f1c0f0e-9a43-4f4e-8d57-3a5c2c1c9a10",
  "title": "Write docs",
  "priority": "high",
  "done": false,
  "createdAt": "2026-10-16T09:00:00.000Z"
}
```

## List tasks

```bash
curl localhost:3000/tasks
```

## Update a task

```bash
curl -X PATCH localhost:3000/tasks/<id> -d '{"done": true}'
```

## Delete a task

```bash
curl -X DELETE localhost:3000/tasks/<id>   # 204 No Content
```

## Errors

| Status | Meaning                              |
| ------ | ------------------------------------ |
| 400    | Invalid JSON or failed validation    |
| 404    | Task not found                       |
| 405    | Method not allowed                   |

<!-- TODO: document dueDate and ?overdue=true once #3 lands -->
