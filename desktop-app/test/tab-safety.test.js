// Tabs of the person's own, in a profile the app is attached to: never taken
// for the app's and never closed. No browser is needed: list_pages and
// close_page are stood in for.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { McpBrowser } = require("../src/mcp-browser");

const GLASSDOOR = "https://www.glassdoor.com/Job/data-engineer-jobs.htm";

function attached() {
  const browser = new McpBrowser({ extensionDir: "../jobright-monitor" });
  const closed = [];
  browser.profileScope = { dir: "Profile 1", name: "Test" };
  browser.call = async (name, args) => {
    if (name === "close_page") closed.push(args.pageId);
    return {};
  };
  return { browser, closed };
}

const list = (...pages) => ({ content: [{ text: pages.map(([id, url]) => `${id}: Page (${url})`).join("\n") }] });

test("a tab of the person's that drops out of the list is not taken for the app's new page", () => {
  const { browser } = attached();
  browser.syncList(list([1, GLASSDOOR]));

  const mine = browser.claim(2);
  browser.opened.add(mine.id);
  mine.goingTo = "www.glassdoor.com";

  // The person's tab is missing twice, so it is forgotten, then comes back
  // while the app's tab is still on its way to the same site.
  browser.syncList(list([2, "about:blank"]));
  browser.syncList(list([2, "about:blank"]));
  assert.equal(browser.tabs.has(1), false);
  browser.syncList(list([1, GLASSDOOR], [2, "about:blank"]));

  assert.equal(browser.pageOf(mine.id), 2);
  assert.equal(browser.ours.has(browser.byPage.get(1)), false);
});

test("the app's tab still follows Chrome's swap to a new page", () => {
  const { browser } = attached();
  browser.syncList(list([1, GLASSDOOR]));

  const mine = browser.claim(2);
  mine.goingTo = "www.glassdoor.com";
  browser.syncList(list([1, GLASSDOOR], [3, GLASSDOOR]));

  assert.equal(browser.pageOf(mine.id), 3);
});

test("a tab taken over from the person is left open; a tab the app opened is closed", async () => {
  const { browser, closed } = attached();
  browser.syncList(list([1, GLASSDOOR], [2, GLASSDOOR]));

  const takenOver = browser.claim(1);
  const mine = browser.claim(2);
  browser.opened.add(mine.id);

  await browser.remove([takenOver.id, mine.id]);

  assert.deepEqual(closed, [2]);
  assert.equal(browser.tabs.has(takenOver.id), true);
});
