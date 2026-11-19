const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

// The lock is a sibling of the output so cleaning the output cannot remove it.
// Exclusive creation also coordinates separate CLI/watch processes.
async function lockBuildOutput(outputDir, { timeoutMs = 120000, pollMs = 100 } = {}) {
  const lock = path.resolve(outputDir) + '.build-lock';
  const started = Date.now();
  let waiting = false;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  while (true) {
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Never silently steal an abandoned or unreadable lock. PID reuse and
      // multiple waiters make read-then-unlink unsafe for a new lock owner.
      let owner;
      try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* Writer may still be recording its PID. */ }
      if (Number.isInteger(owner?.pid)) {
        try { process.kill(owner.pid, 0); } catch (probe) {
          if (probe.code === 'ESRCH') throw new Error(`Abandoned build lock: ${lock} (PID ${owner.pid}). Verify no build is active, then remove this lock and retry.`);
        }
      }
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for build output: ${lock}. Check the owning build before removing its lock.`);
      if (!waiting) console.log(`[11ty] Waiting for build output: ${outputDir}`);
      waiting = true;
      await delay(pollMs);
      continue;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    } catch (error) {
      fs.unlinkSync(lock);
      throw error;
    } finally { fs.closeSync(fd); }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      process.removeListener('exit', release);
      fs.unlinkSync(lock);
    };
    // CLI errors before eleventy.after still release ownership on process exit.
    process.once('exit', release);
    return release;
  }
}

async function cleanBuildOutput({ project, inputDir, outputDir }) {
  project = path.resolve(project);
  inputDir = path.resolve(inputDir);
  outputDir = path.resolve(outputDir);
  // Never remove the project, its inputs, or an ancestor/outside directory.
  if (!outputDir.startsWith(project + path.sep) || outputDir === inputDir ||
      inputDir.startsWith(outputDir + path.sep) || outputDir.startsWith(inputDir + path.sep)) {
    throw new Error(`Unsafe build output directory: ${outputDir}`);
  }
  const release = await lockBuildOutput(outputDir);
  try { fs.rmSync(outputDir, { recursive: true, force: true }); }
  catch (error) { release(); throw error; }
  return release;
}

module.exports = { lockBuildOutput, cleanBuildOutput };
