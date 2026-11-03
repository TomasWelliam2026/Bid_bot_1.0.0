// What runs inside a Chrome page so the extension's content scripts work
// unchanged when the page is driven through the Chrome DevTools MCP server.
//
// A content script talks to the extension with chrome.runtime.sendMessage and
// chrome.runtime.onMessage. Here there is no extension, so the bridge stands
// in for both, inside the page:
//
//   - a message a content script sends is queued in an outbox, which the app
//     empties every time it polls the page;
//   - a message the app sends to the page is handed to the content script's
//     listeners, and its answer kept under the request's id until the next
//     poll collects it.
//
// Every call the app makes into the page returns at once — nothing awaits a
// listener inside an evaluate_script — so one slow answer (a job page still
// loading its description) never holds up the MCP server for the other tabs.
//
// Each document gets its own bridge with its own docId. A new docId on a poll
// means the page navigated: its scripts are gone and must be injected again,
// and any answer still owed by the old document never comes.

const BRIDGE_SOURCE = String.raw`
(() => {
  if (window.__bidbotBridge) return;
  const listeners = [];
  const outbox = [];
  let results = {};
  const docId = Math.random().toString(36).slice(2) + Date.now().toString(36);

  // An answer is taken once; a listener that answers twice is ignored, as in Chrome.
  function dispatch(reqId, msg) {
    let answered = false;
    let pending = false;
    const sendResponse = (value) => {
      if (answered) return;
      answered = true;
      results[reqId] = { ok: true, value: value === undefined ? null : value };
    };
    if (!listeners.length) return { state: "none" };
    for (const fn of listeners) {
      try {
        if (fn(msg, { id: "bidbot" }, sendResponse) === true) pending = true;
      } catch (err) {
        if (!answered) {
          answered = true;
          results[reqId] = { ok: false, error: String((err && err.message) || err) };
        }
      }
    }
    if (answered) {
      const r = results[reqId];
      delete results[reqId];
      return { state: "done", result: r };
    }
    if (!pending) return { state: "done", result: { ok: true, value: null } };
    return { state: "pending" };
  }

  window.__bidbotBridge = {
    docId,
    scripts: {},
    chrome: {
      runtime: {
        id: "bidbot",
        sendMessage(message) {
          outbox.push(JSON.parse(JSON.stringify(message)));
          return Promise.resolve();
        },
        onMessage: {
          addListener: (fn) => listeners.push(fn),
          removeListener: (fn) => {
            const i = listeners.indexOf(fn);
            if (i !== -1) listeners.splice(i, 1);
          }
        },
        getURL: (p) => p
      }
    },
    hasListeners: () => listeners.length > 0,
    dispatch,
    poll() {
      const out = outbox.splice(0);
      const done = results;
      results = {};
      return { docId, outbox: out, results: done, scripts: window.__bidbotBridge.scripts };
    }
  };
})();
`;

// One poll of a page: where it is, whether it has loaded, whether it is the
// tab showing in its window, and whatever its bridge has for the app.
const POLL_FUNCTION = `() => {
  const b = window.__bidbotBridge;
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    visible: document.visibilityState === "visible",
    bridge: b ? b.poll() : null
  };
}`;

// A content script file, run as the extension would run it: once per document,
// with the bridge's chrome in place of the extension's. The wrapper binds a
// local chrome, so the page's own window.chrome is never touched.
function wrapContentScript(name, source) {
  return `${BRIDGE_SOURCE}
(() => {
  const bridge = window.__bidbotBridge;
  if (bridge.scripts[${JSON.stringify(name)}]) return;
  bridge.scripts[${JSON.stringify(name)}] = true;
  (function (chrome) {
${source}
  })(bridge.chrome);
})();`;
}

function dispatchFunction(reqId, message) {
  return `() => {
  const b = window.__bidbotBridge;
  if (!b) return { state: "none" };
  return b.dispatch(${JSON.stringify(reqId)}, ${JSON.stringify(message)});
}`;
}

module.exports = { BRIDGE_SOURCE, POLL_FUNCTION, wrapContentScript, dispatchFunction };
