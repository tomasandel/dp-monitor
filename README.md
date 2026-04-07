# Monitor

CT log monitor that polls Signed Tree Heads (STHs) from Certificate Transparency logs and reports them to the backend. Built as a sidecar around [certspotter](https://github.com/SSLMate/certspotter).

## What it does

- Runs certspotter to track CT log state (tree size, root hash)
- A Node.js sidecar reads certspotter's state files and periodically sends verified STHs to the backend API
- Multiple monitor instances can run independently - the backend compares their STH reports for consistency

## Prerequisites

- Docker
- Backend running

## Setup

```bash
cp .env.example .env
# Edit .env
docker compose up -d --build
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `BACKEND_URL` | Backend API URL (e.g. `http://127.0.0.1:3000`) |
| `MONITOR_ID` | Unique identifier for this monitor instance |
| `POLL_INTERVAL_MS` | How often to check for new STHs (default: 30000) |
| `MONITOR_API_KEY` | Shared secret matching the backend's `MONITOR_API_KEY` |
| `CT_LOG_LIST_URL` | URL to log-list.json (e.g. `https://www.gstatic.com/ct/log_list/v3/log_list.json`) |

## Project structure

```
Dockerfile          # Multi-stage: builds certspotter from Go, runs with Node.js
entrypoint.sh       # Starts certspotter + sidecar, supervises both
sidecar.js          # Reads certspotter state, POSTs STHs to backend
docker-compose.yml  # Host networking + extra_hosts
```
