// Loads the extension's background.js — unchanged — against the app's chrome,
// so the job pipeline (find, check, open, generate, save, next page) is the
// extension's own code and is never copied here.

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { McpBrowser } = require("./mcp-browser");
const { createChromeApi, installExtensionFetch } = require("./chrome-api");

async function startEngine({ extensionDir, dataDir, toPanel, onBadge, log = console.log, ensureConnected }) {
  const browser = new McpBrowser({ extensionDir, log });
  // A run started before Connect connects to the browser picked in the bar.
  browser.ensureConnected = ensureConnected;

  const api = createChromeApi({
    browser,
    extensionDir,
    storageFile: path.join(dataDir, "extension-storage.json"),
    toPanel,
    onBadge
  });

  globalThis.chrome = api.chrome;
  installExtensionFetch(extensionDir);
  await import(pathToFileURL(path.join(extensionDir, "background.js")).href);

  return { browser, api };
}

module.exports = { startEngine };
