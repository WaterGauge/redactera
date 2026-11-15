// POSIX test-launch ownership. Birth identity prevents acting on a reused PID.
const cp = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function processes() {
  const output = cp.execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='],
    { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } });
  return output.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), birth: match[3], command: match[4] }] : [];
  });
}
const identity = row => `${row.pid}:${row.birth}`;
function track(rootPid) {
  const known = new Map(); let rootSeen = false; let observationError = false;
  function observe() {
    const rows = processes();
    if (!rootSeen) {
      const root = rows.find(row => row.pid === rootPid && row.ppid === process.pid);
      if (!root) throw Error('The active test launcher identity could not be established');
      known.set(identity(root), root); rootSeen = true;
    }
    let added;
    do {
      added = false;
      const ownedParents = new Set(rows.filter(row => known.has(identity(row))).map(row => row.pid));
      for (const row of rows) if (ownedParents.has(row.ppid) && !known.has(identity(row))) {
        known.set(identity(row), row); added = true;
      }
    } while (added);
    return rows.filter(row => known.has(identity(row)));
  }
  observe();
  const timer = setInterval(() => { try { observe(); } catch { observationError = true; } }, 250);
  async function stop() {
    const signals = [];
    try {
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        for (const old of observe().reverse()) {
          const current = processes().find(row => identity(row) === identity(old));
          if (!current) continue;
          try { process.kill(current.pid, signal); signals.push({ pid: current.pid, birth: current.birth, signal }); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        for (let attempt = 0; attempt < 20; attempt++) { if (!observe().length) break; await pause(100); }
        if (!observe().length) break;
      }
      const live = observe();
      return { confirmed: rootSeen && !observationError && live.length === 0, observationError,
        known: [...known.values()], live, signals };
    } finally { clearInterval(timer); }
  }
  return { observe, stop };
}
module.exports = { track, processes };
