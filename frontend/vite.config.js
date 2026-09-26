import os from 'node:os';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Names this machine answers to, besides its addresses.
 *
 * Vite refuses a request whose Host header is a name it has not been told
 * about -- a defence against DNS rebinding -- and answers 403. An IP always
 * passes, so `http://172.20.1.125:5175` works while
 * `http://DESKTOP-H44M2EH:5175` from the same browser does not, which looks
 * from the other computer exactly like the server being unreachable. The
 * machine's own name is read at startup rather than written down, so renaming
 * the machine cannot leave this stale.
 */
const MACHINE = os.hostname();
const HOST_NAMES = [
  ...new Set([
    MACHINE,
    // A browser lowercases the Host header and Vite matches it exactly, so the
    // name as typed and the name as sent are not always the same string.
    MACHINE.toLowerCase(),
    `${MACHINE}.local`,
    `${MACHINE.toLowerCase()}.local`,
  ]),
];

/**
 * Where the API is, for every build and every machine.
 *
 * The host's address on the network, not a loopback name: the dashboard is
 * opened from other machines as well as this one, and `localhost` there means
 * that machine's own port 4500, which is nothing. VITE_API_URL overrides it.
 */
const API_ORIGIN = 'http://172.20.1.125:4500';

/**
 * Nothing is redirected any more.
 *
 * An earlier version answered `localhost` with a redirect to the LAN address,
 * so that the dashboard had one origin and one set of localStorage settings.
 * That cannot stand alongside a proxy switched on in the browser: such a proxy
 * leaves loopback alone but has no route to this network, so redirecting the
 * one path that still works onto the one that does not takes the dashboard
 * down on this machine entirely. Use one address per machine and the settings
 * stay put; the API follows whichever it is (see hooks/useArchive.js).
 */

export default defineConfig(() => {
  const api = process.env.VITE_API_URL || API_ORIGIN;

  return {
    plugins: [react()],

    // Backend origin baked into the client, in dev and in a build alike. The
    // page talks to the API directly rather than through the dev server: the
    // event stream is a long-lived response, and proxying it only adds a hop
    // that logs an error every time the page reloads.
    define: {
      __API_ORIGIN__: JSON.stringify(api),
    },

    // `0.0.0.0` rather than the default 'localhost': the dashboard is opened
    // from other machines on the network, and a server bound to loopback only
    // answers the machine it runs on. Bound explicitly to the IPv4 wildcard
    // because 'localhost' resolves to ::1 only on Windows, which some browsers
    // then refuse to reach. Either way the page is reachable at
    // http://172.20.1.125:5175 -- and still at 127.0.0.1 from here.
    server: {
      port: 5175,
      host: '0.0.0.0',
      allowedHosts: HOST_NAMES,
    },

    // `npm run preview` serves the built dist/; same reasoning.
    preview: {
      port: 5176,
      host: '0.0.0.0',
      allowedHosts: HOST_NAMES,
    },
  };
});
