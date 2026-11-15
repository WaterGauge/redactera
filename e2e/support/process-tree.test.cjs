const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { track } = require('./process-tree.cjs');

test('tracks a detached grandchild and preserves a separate control process', { skip: process.platform === 'win32' }, async () => {
  const control = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const child = cp.spawn(process.execPath, ['-e', `const c=require('child_process').spawn(process.execPath,
    ['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000);`],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const tracker = track(child.pid);
  try {
    const grandchild = await new Promise(resolve => child.stdout.once('data', bytes => resolve(Number(bytes.toString().trim()))));
    const observed = tracker.observe();
    assert(observed.some(row => row.pid === grandchild));
    assert(!observed.some(row => row.pid === control.pid));
    const result = await tracker.stop();
    assert(result.confirmed);
    assert.equal(result.live.length, 0);
    process.kill(control.pid, 0);
  } finally {
    await tracker.stop();
    control.kill();
  }
});
