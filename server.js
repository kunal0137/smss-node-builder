import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdir, rm } from 'fs/promises';
import { createWriteStream } from 'fs';
import { join } from 'path';
import extractZip from 'extract-zip';
import archiver from 'archiver';

// Config from env vars with defaults
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_CONCURRENT_BUILDS = parseInt(process.env.MAX_CONCURRENT_BUILDS || '3', 10);
const BUILD_MEMORY_LIMIT_MB = parseInt(process.env.BUILD_MEMORY_LIMIT_MB || '512', 10);
const BUILD_TIMEOUT_MS = parseInt(process.env.BUILD_TIMEOUT_MS || '300000', 10);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '100', 10);
const WORK_DIR = process.env.WORK_DIR || '/tmp/builds';
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/tmp/uploads';

// Track active builds
const builds = new Map();

const app = express();

// Set X-Pod header on every response
app.use((req, res, next) => {
  res.setHeader('X-Pod', process.env.HOSTNAME || 'unknown');
  next();
});

// Ensure work dirs exist
await mkdir(WORK_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// Multer config: store uploads in UPLOADS_DIR, limit by MAX_UPLOAD_MB
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, `${randomUUID()}.zip`),
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// Cleanup helper
async function cleanupBuild(jobId) {
  const build = builds.get(jobId);
  if (!build) return;
  builds.delete(jobId);
  try {
    await rm(build.workDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

// POST /build — accept zip, run build in background
app.post('/build', (req, res, next) => {
  // Check capacity before accepting upload
  if (builds.size >= MAX_CONCURRENT_BUILDS) {
    return res.status(503).json({ error: 'Pod at capacity' });
  }
  next();
}, upload.single('source'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Missing required field: source (zip file)' });
  }

  // Re-check capacity after upload (race condition guard)
  if (builds.size >= MAX_CONCURRENT_BUILDS) {
    await rm(req.file.path, { force: true }).catch(() => {});
    return res.status(503).json({ error: 'Pod at capacity' });
  }

  const jobId = randomUUID();
  const workDir = join(WORK_DIR, jobId);
  const buildCmd = req.query.buildCmd || 'pnpm install && pnpm build';
  const outDir = req.query.outDir || 'dist';

  const buildEntry = {
    status: 'extracting',
    startedAt: Date.now(),
    workDir,
    outDir,
    proc: null,
    logs: [],
  };
  builds.set(jobId, buildEntry);

  res.status(202).json({ jobId, status: 'accepted' });

  // Run build in background
  (async () => {
    try {
      await mkdir(workDir, { recursive: true });

      // Extract zip
      await extractZip(req.file.path, { dir: workDir });
      await rm(req.file.path, { force: true }).catch(() => {});

      if (!builds.has(jobId)) return; // deleted while extracting
      builds.get(jobId).status = 'building';

      // Build memory limit via ulimit + NODE_OPTIONS
      const ulimitKB = BUILD_MEMORY_LIMIT_MB * 1024;
      const shellCmd = `ulimit -v ${ulimitKB}; ${buildCmd}`;

      const proc = spawn('sh', ['-c', shellCmd], {
        cwd: workDir,
        env: {
          ...process.env,
          NODE_OPTIONS: `--max-old-space-size=${BUILD_MEMORY_LIMIT_MB}`,
          PNPM_HOME: join(workDir, '.pnpm-store'),
          PATH: process.env.PATH,
        },
      });

      builds.get(jobId).proc = proc;

      const timeout = setTimeout(() => {
        if (builds.has(jobId) && builds.get(jobId).status === 'building') {
          proc.kill('SIGKILL');
          const entry = builds.get(jobId);
          if (entry) {
            entry.status = 'failed';
            entry.error = `Build timed out after ${BUILD_TIMEOUT_MS}ms`;
          }
        }
      }, BUILD_TIMEOUT_MS);

      const collectOutput = (chunk) => {
        const entry = builds.get(jobId);
        if (entry) entry.logs.push(chunk.toString());
      };

      proc.stdout.on('data', collectOutput);
      proc.stderr.on('data', collectOutput);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        const entry = builds.get(jobId);
        if (!entry) return;
        if (entry.status === 'failed') return; // timeout already set it
        entry.status = code === 0 ? 'complete' : 'failed';
        if (code !== 0) {
          entry.error = `Build process exited with code ${code}`;
        }
        entry.proc = null;
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        const entry = builds.get(jobId);
        if (!entry) return;
        entry.status = 'failed';
        entry.error = err.message;
        entry.proc = null;
      });
    } catch (err) {
      await rm(req.file.path, { force: true }).catch(() => {});
      const entry = builds.get(jobId);
      if (entry) {
        entry.status = 'failed';
        entry.error = err.message;
      }
    }
  })();
});

// GET /build/:id — job status
app.get('/build/:id', (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) {
    return res.status(404).json({ error: 'Build not found' });
  }

  const response = {
    status: build.status,
    elapsedMs: Date.now() - build.startedAt,
  };

  if (build.logs.length > 0) {
    response.logs = build.logs.join('');
  }

  if (build.error) {
    response.error = build.error;
  }

  res.json(response);
});

// GET /build/:id/download — stream outDir as zip
app.get('/build/:id/download', async (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) {
    return res.status(404).json({ error: 'Build not found' });
  }

  if (build.status !== 'complete') {
    return res.status(409).json({ error: `Build is not complete (status: ${build.status})` });
  }

  const outDirPath = join(build.workDir, build.outDir);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="build-${req.params.id}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  });

  archive.pipe(res);
  archive.directory(outDirPath, false);
  await archive.finalize();

  res.on('close', async () => {
    await cleanupBuild(req.params.id);
  });
});

// DELETE /build/:id — kill and clean up
app.delete('/build/:id', async (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) {
    return res.status(404).json({ error: 'Build not found' });
  }

  if (build.proc) {
    try {
      build.proc.kill('SIGKILL');
    } catch {
      // ignore if already dead
    }
  }

  await cleanupBuild(req.params.id);
  res.json({ status: 'deleted' });
});

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeBuilds: builds.size,
    maxConcurrent: MAX_CONCURRENT_BUILDS,
  });
});

// GET /ready — Kubernetes readiness probe
app.get('/ready', (req, res) => {
  if (builds.size < MAX_CONCURRENT_BUILDS) {
    res.status(200).json({ status: 'ready', activeBuilds: builds.size });
  } else {
    res.status(503).json({ error: 'Pod at capacity' });
  }
});

// Background GC: remove stale complete/failed builds older than 30 minutes
const GC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const GC_MAX_AGE_MS = 30 * 60 * 1000;  // 30 minutes

setInterval(async () => {
  const now = Date.now();
  for (const [jobId, build] of builds.entries()) {
    if (
      (build.status === 'complete' || build.status === 'failed') &&
      now - build.startedAt > GC_MAX_AGE_MS
    ) {
      await cleanupBuild(jobId);
    }
  }
}, GC_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`Build service listening on port ${PORT}`);
  console.log(`Max concurrent builds: ${MAX_CONCURRENT_BUILDS}`);
  console.log(`Build memory limit: ${BUILD_MEMORY_LIMIT_MB}MB`);
  console.log(`Build timeout: ${BUILD_TIMEOUT_MS}ms`);
  console.log(`Work dir: ${WORK_DIR}`);
});
