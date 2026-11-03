// Stop while connecting: a browser that never answers (as Chrome does while
// its "Allow remote debugging?" waits) can be walked away from, with no error
// left behind.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { startHarness, sleep } = require("./helpers/harness");

test("Stop ends a connection still being made", { timeout: 60000 }, async (t) => {
  const h = await startHarness({ connect: false });
  const silent = net.createServer((socket) => socket.on("error", () => {})); // takes the connection, says nothing
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  t.after(async () => {
    silent.close();
    await h.close();
  });

  const connecting = h.browser.connect({
    mode: "attach",
    wsEndpoint: `ws://127.0.0.1:${silent.address().port}/devtools/browser/x`,
    label: "silent"
  });
  const outcome = connecting.then(() => "connected", (err) => err.message);
  await sleep(1500);
  assert.equal(h.browser.state, "connecting");

  await h.browser.disconnect();
  const result = await Promise.race([outcome, sleep(5000).then(() => "still waiting")]);
  assert.equal(result, "stopped");
  assert.equal(h.browser.status().state, "disconnected");
  assert.ok(!h.browser.status().error, "no error is left to show");
});
