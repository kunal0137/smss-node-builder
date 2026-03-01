# CLAUDE.md

## Project overview

Node.js Express service that builds SEMOSS projects on demand. Accepts a zipped
`client/` folder, runs `pnpm install && pnpm build` inside it, and returns the
compiled `portals/` directory as a zip in the same HTTP response.

## Architecture

```
POST /build  ──►  extract zip  ──►  pnpm build  ──►  zip portals/  ──►  return zip
```

- **Synchronous** — one HTTP request in, one zip out, no polling
- **Stateless** — each build gets an isolated temp directory, cleaned up after
  the response closes
- **Capacity-limited** — `MAX_CONCURRENT_BUILDS` (default 3) guards each pod

## Key files

| File | Purpose |
|---|---|
| `server.js` | Express server — the entire service |
| `Dockerfile` | node:20-alpine image with pnpm + zip/unzip |
| `k8s-manifests.yaml` | Namespace, Deployment, Service, HPA |
| `build-client.sh` | Shell script to call the service from the CLI |

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Listening port |
| `MAX_CONCURRENT_BUILDS` | `3` | Requests above this get 503 |
| `BUILD_MEMORY_LIMIT_MB` | `512` | Applied via `ulimit -v` + `NODE_OPTIONS` |
| `BUILD_TIMEOUT_MS` | `300000` | 5 minutes; build killed on exceed |
| `MAX_UPLOAD_MB` | `100` | Max size of uploaded zip |
| `WORK_DIR` | `/tmp/builds` | Temp dir for extractions and builds |
| `UPLOADS_DIR` | `/tmp/uploads` | Multer upload staging |

## API

### POST /build

- Body: `multipart/form-data` with field `source` (zip file)
- Query params:
  - `?buildCmd=` — shell command to run (default: `pnpm install && pnpm build`)
  - `?outDir=` — output folder name to zip and return (default: `portals`)
- Response: `application/zip` (`portals.zip`) on success, JSON error on failure

### GET /health

Returns `{ status, activeBuilds, maxConcurrent }`. Used as liveness probe.

### GET /ready

Returns 200 when pod has capacity, 503 when saturated. Used as readiness probe.

## SEMOSS zip layout

The service handles both layouts automatically:

```
# Layout A — zip wraps the whole project root (preferred)
client/
  package.json
  vite.config.ts
  src/
  ...

# Layout B — zip contains the client folder contents directly
package.json
vite.config.ts
src/
...
```

Layout B is auto-wrapped into `client/` so Vite's `outDir: "../../portals"`
(relative to `src/`) always resolves to `portals/` next to `client/`.

## Running locally

```bash
pnpm install
node server.js
```

Test with the helper script:

```bash
./build-client.sh /path/to/client-folder http://localhost:3000
```

Output lands in `./dist-output/`.

## Docker

```bash
docker build -t build-service .
docker run -p 3000:3000 build-service
```

## Kubernetes

```bash
# Replace the image placeholder first
sed -i 's|your-registry/build-service:latest|ghcr.io/your-org/build-service:latest|' k8s-manifests.yaml

kubectl apply -f k8s-manifests.yaml
```

The HPA scales between 2 and 10 pods based on CPU (70%) and memory (75%)
utilisation. Each pod handles up to 3 concurrent builds.

## Common tasks for Claude

- **Change the default build command**: edit the `buildCmd` default in `server.js`
  at the `POST /build` handler (`req.query.buildCmd || 'pnpm install && pnpm build'`)
- **Change the output folder**: edit `req.query.outDir || 'portals'` in the same handler
- **Tune resources**: edit `k8s-manifests.yaml` — `resources.requests/limits` and
  `ConfigMap` values
- **Add a new endpoint**: add a route in `server.js`; the server is a plain Express app
