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
      let buildDir;

      if (await pathExists(join(workDir, 'client', 'package.json'))) {
        buildDir = join(workDir, 'client');
      } else if (await pathExists(join(workDir, 'package.json'))) {
        const tmpName = join(WORK_DIR, `${randomUUID()}-wrap`);
        await rename(workDir, tmpName);
        await mkdir(workDir, { recursive: true });
        await rename(tmpName, join(workDir, 'client'));
        buildDir = join(workDir, 'client');
      } else {
        return res.status(400).json({ error: 'No package.json found in uploaded zip' });
      }

      // ── 3. Run the build ──────────────────────────────────────────────────
      const buildCmd = req.query.buildCmd || 'pnpm install --no-frozen-lockfile && pnpm build';
      const shellCmd = buildCmd;

      // ── DEBUG: log exactly what we're about to run ────────────────────────
      console.log('========== BUILD DEBUG START ==========');
      console.log('[build] query:', JSON.stringify(req.query));
      console.log('[build] cwd:', buildDir);
      console.log('[build] cmd:', shellCmd);

      // ── DEBUG: probe the environment inside the build dir ─────────────────
      await runCommand(
        'echo "--- pnpm version ---"; pnpm -v; ' +
        'echo "--- pnpm config list ---"; pnpm config list; ' +
        'echo "--- env CI ---"; echo "CI=$CI"; ' +
        'echo "--- .npmrc files ---"; ' +
        'for f in .npmrc ../.npmrc ~/.npmrc /etc/npmrc; do ' +
        '  if [ -f "$f" ]; then echo "FOUND: $f"; cat "$f"; else echo "not found: $f"; fi; ' +
        'done; ' +
        'echo "--- pnpm-lock.yaml ---"; ' +
        'if [ -f pnpm-lock.yaml ]; then ls -la pnpm-lock.yaml; head -5 pnpm-lock.yaml; else echo "no lockfile"; fi; ' +
        'echo "--- pnpm-workspace.yaml ---"; ' +
        'ls -la pnpm-workspace.yaml ../pnpm-workspace.yaml 2>/dev/null || echo "no workspace yaml"; ' +
        'echo "--- parent dir ---"; ls -la ..',
        buildDir,
        { ...process.env, CI: 'true', PATH: process.env.PATH }
      ).then(logs => {
        console.log('[debug probe output]');
        console.log(logs);
      }).catch(err => {
        console.log('[debug probe failed]', err.message, err.logs);
      });

      console.log('========== BUILD DEBUG END ==========');

      await runCommand(shellCmd, buildDir, {
        ...process.env,
        CI: 'true',
        NODE_OPTIONS: `--max-old-space-size=${BUILD_MEMORY_LIMIT_MB}`,
        PNPM_HOME: join(workDir, '.pnpm-store'),
        PATH: process.env.PATH,
      });

      // ── 4. Locate output dir ─────────────────────────────────────────────
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
      console.error('Build error logs:', err.logs);
      if (!res.headersSent) {
        res.status(500).json({
          error: err.message,
          ...(err.logs ? { logs: err.logs } : {}),
        });
      }
    } finally {
      activeBuilds--;
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

// GET /ready
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