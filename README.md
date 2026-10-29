# Lumi Labs Tasks API

A tiny, dependency-free task management API built by Lumi Labs. It exists to
demo how GitHub issues, pull requests, and commits flow into Notion.

## Getting started

```bash
npm start        # starts the API on http://localhost:3000
npm test         # runs the test suite
```

## Endpoints

| Method | Path         | Description         |
| ------ | ------------ | ------------------- |
| GET    | `/tasks`     | List all tasks      |
| POST   | `/tasks`     | Create a task       |
| GET    | `/tasks/:id` | Fetch a task        |
| PATCH  | `/tasks/:id` | Update a task       |
| DELETE | `/tasks/:id` | Delete a task       |
| GET    | `/health`    | Liveness check      |

## Roadmap

See the open [issues](../../issues) for what's planned.
