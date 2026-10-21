/*
 * Minimal stand-in for the VS Code webview API.
 *
 * The real host exposes `acquireVsCodeApi()` before the webview bundle runs.
 * This mock records the messages the webview posts (including `ready`) and
 * answers `getState`/`setState` locally. It never talks to an extension host
 * and never makes a network request.
 */
(function () {
  var recorded = [];
  var state;

  var api = {
    postMessage: function (message) {
      recorded.push(message);
      if (message && message.type === 'ready') {
        window.__visualReady = true;
      }
    },
    getState: function () {
      return state;
    },
    setState: function (next) {
      state = next;
    }
  };

  window.__visualHostMessages = recorded;
  window.__visualReady = false;
  window.acquireVsCodeApi = function () {
    return api;
  };
})();
