import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdir, rm, rename, access } from 'fs/promises';
import { join } from 'path';
import extractZip from 'extract-zip';
import archiver from 'archiver';

// Config from env vars with defaults
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_CONCURRENT_BUILDS = parseInt(process.env.MAX_CONCURRENT_BUILDS || '3', 10);
const BUILD_MEMORY_LIMIT_MB = parseInt(process.env.BUILD_MEMORY_LIMIT_MB || '1024', 10);
const BUILD_TIMEOUT_MS = parseInt(process.env.BUILD_TIMEOUT_MS || '300000', 10);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '100', 10);
const WORK_DIR = process.env.WORK_DIR || '/tmp/builds';
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/tmp/uploads';

// Simple counter — no job Map needed for synchronous mode
let activeBuilds = 0;

const app = express();

// Set X-Pod header on every response
app.use((req, res, next) => {
  res.setHeader('X-Pod', process.env.HOSTNAME || 'unknown');
  next();
});

// Ensure work dirs exist
await mkdir(WORK_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, `${randomUUID()}.zip`),
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// Check if a path exists
async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Run a shell command; resolves with stdout+stderr, rejects with exit code + logs on failure
function runCommand(cmd, cwd, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('sh', ['-c', cmd], { cwd, env });
    const chunks = [];

    proc.stdout.on('data', (d) => chunks.push(d.toString()));
    proc.stderr.on('data', (d) => chunks.push(d.toString()));

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      const err = new Error(`Build timed out after ${BUILD_TIMEOUT_MS}ms`);
      err.logs = chunks.join('');
      reject(err);
    }, BUILD_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const logs = chunks.join('');
      if (code === 0) {
        resolve(logs);
      } else {
        const err = new Error(`Build exited with code ${code}`);
        err.logs = logs;
        reject(err);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      err.logs = chunks.join('');
      reject(err);
    });
  });
}

// POST /build
//
// Accepts multipart/form-data with field `source` (a zipped client folder).
// The zip should contain either:
//   - a top-level `client/` directory (the full SEMOSS project root), or
//   - the client folder contents directly (auto-wrapped in client/)
//
// Runs `pnpm install && pnpm build` inside the client dir.
// Vite is configured (in the SEMOSS template) to output to ../../portals relative
// to src/, which resolves to portals/ next to the client/ directory.
//
// Responds synchronously with the portals/ folder zipped as portals.zip.
// Optional query params:
//   ?buildCmd=  override the build command  (default: pnpm install && pnpm build)
//   ?outDir=    override the output dir name (default: portals)
app.post(
  '/build',
  (req, res, next) => {
    if (activeBuilds >= MAX_CONCURRENT_BUILDS) {
      return res.status(503).json({ error: 'Pod at capacity' });
    }
    next();
  },
  upload.single('source'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing required field: source (zip file)' });
    }

    // Re-check after upload completes (race condition guard)
    if (activeBuilds >= MAX_CONCURRENT_BUILDS) {
      await rm(req.file.path, { force: true }).catch(() => {});
      return res.status(503).json({ error: 'Pod at capacity' });
    }

    activeBuilds++;
    const workDir = join(WORK_DIR, randomUUID());

    try {
      await mkdir(workDir, { recursive: true });

      // ── 1. Extract zip ────────────────────────────────────────────────────
      await extractZip(req.file.path, { dir: workDir });
      await rm(req.file.path, { force: true }).catch(() => {});

      // ── 2. Locate the client dir ──────────────────────────────────────────
      // Case A: zip had a top-level client/ wrapper  → workDir/client/package.json
      // Case B: zip contained client contents directly → workDir/package.json
      // In both cases we want buildDir = workDir/client/ so portals lands at workDir/portals/
      let buildDir;

      if (await pathExists(join(workDir, 'client', 'package.json'))) {
        // Case A — already structured correctly
        buildDir = join(workDir, 'client');
      } else if (await pathExists(join(workDir, 'package.json'))) {
        // Case B — wrap the bare contents inside a client/ subdirectory
        const tmpName = join(WORK_DIR, `${randomUUID()}-wrap`);
        await rename(workDir, tmpName);           // workDir → tmpName
        await mkdir(workDir, { recursive: true }); // recreate workDir
        await rename(tmpName, join(workDir, 'client')); // tmpName → workDir/client
        buildDir = join(workDir, 'client');
      } else {
        return res.status(400).json({ error: 'No package.json found in uploaded zip' });
      }

      // ── 3. Run the build ──────────────────────────────────────────────────
      const buildCmd = req.query.buildCmd || 'pnpm install && pnpm build';
      const shellCmd = buildCmd;

      await runCommand(shellCmd, buildDir, {
        ...process.env,
        CI: 'true',
        NODE_OPTIONS: `--max-old-space-size=${BUILD_MEMORY_LIMIT_MB}`,
        // Isolate pnpm store to avoid cross-build cache collisions
        PNPM_HOME: join(workDir, '.pnpm-store'),
        PATH: process.env.PATH,
      });

      // ── 4. Locate output dir ─────────────────────────────────────────────
      // SEMOSS vite.config.ts: root="src", outDir="../../portals"
      // → resolves to portals/ sitting next to client/ (i.e. workDir/portals/)
      const outDirName = req.query.outDir || 'portals';
      const portalsDir = join(workDir, outDirName);

      if (!(await pathExists(portalsDir))) {
        return res.status(500).json({
          error: `Build succeeded but output directory '${outDirName}' was not found`,
        });
      }

      // ── 5. Stream portals.zip back ────────────────────────────────────────
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="portals.zip"');

      const archive = archiver('zip', { zlib: { level: 6 } });

      archive.on('error', (err) => {
        console.error('Archiver error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });

      archive.pipe(res);
      archive.directory(portalsDir, false);
      await archive.finalize();

    } catch (err) {
      await rm(req.file.path, { force: true }).catch(() => {});
      console.error('Build error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({
          error: err.message,
          ...(err.logs ? { logs: err.logs } : {}),
        });
      }
    } finally {
      activeBuilds--;
      // Clean up workDir after response is fully sent
      res.on('close', () => {
        rm(workDir, { recursive: true, force: true }).catch(() => {});
      });
    }
  }
);

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeBuilds,
    maxConcurrent: MAX_CONCURRENT_BUILDS,
  });
});

// GET /ready — Kubernetes readiness probe
// Returns 503 when saturated so the pod is pulled from the load balancer
app.get('/ready', (req, res) => {
  if (activeBuilds < MAX_CONCURRENT_BUILDS) {
    res.status(200).json({ status: 'ready', activeBuilds });
  } else {
    res.status(503).json({ error: 'Pod at capacity' });
  }
});

app.listen(PORT, () => {
  console.log(`SEMOSS build service listening on port ${PORT}`);
  console.log(`Max concurrent builds: ${MAX_CONCURRENT_BUILDS}`);
  console.log(`Build memory limit: ${BUILD_MEMORY_LIMIT_MB}MB`);
  console.log(`Build timeout: ${BUILD_TIMEOUT_MS}ms`);
  console.log(`Work dir: ${WORK_DIR}`);
});
