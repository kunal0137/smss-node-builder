# smss-node-builder

A lightweight Node.js build service for [SEMOSS](https://github.com/SEMOSS/template)
projects. Send a zipped `client/` folder, get back a zipped `portals/` folder — in
a single synchronous HTTP call.

## How it works

```
curl -F "source=@client.zip" http://build-service/build --output portals.zip
```

1. Upload a zip containing the SEMOSS `client/` folder
2. The service runs `pnpm install && pnpm build` inside it
3. Vite outputs the compiled app to `portals/` (configured in the SEMOSS template)
4. The `portals/` directory is zipped and returned in the same response

## Quick start

### Run locally

```bash
pnpm install
node server.js
```

### Run with Docker

```bash
docker build -t smss-node-builder .
docker run -p 3000:3000 smss-node-builder
```

### Send a build

```bash
# Using the helper script
./build-client.sh ./client http://localhost:3000

# Or directly with curl
zip -r client.zip client/ --exclude "client/node_modules/*"
curl -F "source=@client.zip" http://localhost:3000/build --output portals.zip
unzip portals.zip -d dist-output/
```

## API

### `POST /build`

Runs a SEMOSS client build synchronously and returns the compiled output as a zip.

| | |
|---|---|
| Content-Type | `multipart/form-data` |
| Field | `source` — zip file containing the `client/` folder |
| Response | `application/zip` (`portals.zip`) |

**Query parameters**

| Param | Default | Description |
|---|---|---|
| `buildCmd` | `pnpm install && pnpm build` | Shell command to run inside `client/` |
| `outDir` | `portals` | Output directory to zip and return |

**Error response**

```json
{
  "error": "Build exited with code 1",
  "logs": "... full build output ..."
}
```

### `GET /health`

Liveness probe. Always returns 200 while the process is running.

```json
{ "status": "ok", "activeBuilds": 1, "maxConcurrent": 3 }
```

### `GET /ready`

Readiness probe. Returns 200 when the pod has capacity, 503 when saturated.

## Zip layout

The service accepts two layouts:

**Layout A — project root wrapped (preferred)**
```
client/
  package.json
  vite.config.ts
  src/
```

**Layout B — client contents at zip root (auto-detected)**
```
package.json
vite.config.ts
src/
```

Both layouts produce `portals/` as output, matching the SEMOSS template's
Vite config (`outDir: "../../portals"` relative to the `src/` root).

## Configuration

Set via environment variables or the Kubernetes ConfigMap.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `MAX_CONCURRENT_BUILDS` | `3` | Concurrent builds per pod (503 above this) |
| `BUILD_MEMORY_LIMIT_MB` | `512` | Memory cap via `ulimit -v` + `NODE_OPTIONS` |
| `BUILD_TIMEOUT_MS` | `300000` | Kill build after 5 minutes |
| `MAX_UPLOAD_MB` | `100` | Max upload size |
| `WORK_DIR` | `/tmp/builds` | Temp directory for builds |

## Kubernetes deployment

```bash
# Set your image registry
sed -i 's|your-registry/build-service:latest|ghcr.io/your-org/smss-node-builder:latest|' k8s-manifests.yaml

kubectl apply -f k8s-manifests.yaml
```

The manifest includes:

- **Namespace** — `build-system`
- **Deployment** — 3 replicas, spread across nodes, non-root container
- **Service** — ClusterIP on port 80
- **HPA** — scales 2–10 pods at 70% CPU / 75% memory

Each pod handles up to 3 concurrent builds. The readiness probe removes saturated
pods from rotation automatically, so callers receive a 503 from the load balancer
and can retry on another pod rather than queueing behind a slow build.

## `build-client.sh`

Helper script for calling the service from a shell.

```
Usage: ./build-client.sh <source-dir> <build-service-url> [outDir] [buildCmd]
```

```bash
# Basic usage
./build-client.sh ./client http://build-service

# Override output dir and build command
./build-client.sh ./client http://build-service portals "pnpm install && pnpm build --mode production"
```

Output is extracted to `./dist-output/`.

## Tech stack

- **Runtime**: Node.js 20, ESM
- **Framework**: Express 4
- **Upload handling**: multer
- **Zip extraction**: extract-zip
- **Zip creation**: archiver
- **Package manager (client builds)**: pnpm (via corepack in the Docker image)
