/**
 * Shared Home Assistant WebSocket connections, one per (url, token), so
 * several module instances pointed at the same HA don't each open a socket.
 */
const { createConnection, createLongLivedTokenAuth } = require("home-assistant-js-websocket");

const pool = new Map();

function key (url, token) {
	return `${url}\n${token}`;
}

/**
 * Connects (or reuses a connection). Network failures retry forever, so a
 * mirror that boots before HA just waits. An invalid token rejects with
 * ERR_INVALID_AUTH and is never retried.
 * @param {string} url e.g. http://10.0.0.16:8123
 * @param {string} token long-lived access token
 * @returns {Promise<import("home-assistant-js-websocket").Connection>}
 */
async function acquireConnection (url, token) {
	const k = key(url, token);
	let entry = pool.get(k);
	if (!entry) {
		const auth = createLongLivedTokenAuth(url.replace(/\/+$/, ""), token);
		entry = { refs: 0, promise: createConnection({ auth, setupRetry: -1 }) };
		pool.set(k, entry);
	}
	entry.refs += 1;
	try {
		return await entry.promise;
	} catch (err) {
		pool.delete(k);
		throw err;
	}
}

function releaseConnection (url, token) {
	const k = key(url, token);
	const entry = pool.get(k);
	if (!entry) return;
	entry.refs -= 1;
	if (entry.refs <= 0) {
		pool.delete(k);
		entry.promise.then((conn) => conn.close(), () => {});
	}
}

module.exports = { acquireConnection, releaseConnection };
