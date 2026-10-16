/**
 * DashboardSession against a fake Home Assistant WebSocket server that speaks
 * just enough of the protocol: auth, lovelace/config, list_for_display,
 * subscribe_entities, subscribe_events and statistics_during_period.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DashboardSession } = require("../lib/session");
const { startFakeHa: fakeHa } = require("./helpers/fake-ha");

const silent = { log () {}, warn () {}, error () {} };
const LC = 1792159200;

function nextEvent (emitter, name, predicate = () => true) {
	return new Promise((resolve) => {
		const handler = (value) => {
			if (!predicate(value)) return;
			emitter.off(name, handler);
			resolve(value);
		};
		emitter.on(name, handler);
	});
}

test("reads the dashboard, streams states and fetches charts", async (t) => {
	const ha = await fakeHa();
	const session = new DashboardSession({ url: ha.url, token: "good", dashboard: "dashboard-ev", statsRefreshMinutes: 0 }, silent);
	t.after(async () => { session.stop(); await ha.close(); });

	const layoutP = nextEvent(session, "layout");
	const statesP = nextEvent(session, "states");
	const statsP = nextEvent(session, "stats");
	session.start();

	const layout = await layoutP;
	assert.equal(layout.sections.length, 4);
	assert.equal(layout.precision["sensor.charlie_energy_session"], 2);
	assert.equal(layout.precision["sensor.charlie_voltage"], 0);
	assert.equal(layout.precision["light.elsewhere"], undefined, "only entities on the dashboard");

	const states = await statesP;
	assert.equal(Object.keys(states).length, 7);
	assert.equal(states["sensor.charlie_energy_session"].state, "9.57600000000002");
	assert.equal(states["sensor.charlie_energy_session"].attributes.unit_of_measurement, "kWh");
	assert.equal(ha.entitySubs[0].ids.length, 7, "subscribes only to the dashboard's entities");

	const stats = await statsP;
	assert.equal(stats["chart-0"][0].points.at(-1).value.toFixed(2), "46.41");
	assert.equal(stats["chart-1"][0].statType, "mean");

	const changed = nextEvent(session, "states");
	ha.pushEntityChange({ c: { "sensor.charlie_current_export": { "+": { s: "16.1", lc: LC + 10 } } } });
	assert.equal((await changed)["sensor.charlie_current_export"].state, "16.1");
});

test("an edit to the dashboard (lovelace_updated) reloads the layout", async (t) => {
	const ha = await fakeHa();
	const session = new DashboardSession({ url: ha.url, token: "good", dashboard: "dashboard-ev", statsRefreshMinutes: 0 }, silent);
	t.after(async () => { session.stop(); await ha.close(); });

	const first = nextEvent(session, "stats");
	session.start();
	await first;

	const reloaded = nextEvent(session, "layout");
	ha.fireEvent("lovelace_updated", { url_path: "some-other-dashboard", mode: "storage" });
	ha.fireEvent("lovelace_updated", { url_path: "dashboard-ev", mode: "storage" });
	await reloaded;
	assert.equal(ha.calls.filter((c) => c === "lovelace/config").length, 2, "other dashboards are ignored");
	assert.equal(ha.calls.filter((c) => c === "subscribe_entities").length, 1, "same entities: no resubscribe");
});

test("a bad token is reported once and never retried", async (t) => {
	const ha = await fakeHa();
	const session = new DashboardSession({ url: ha.url, token: "wrong", dashboard: "dashboard-ev" }, silent);
	t.after(async () => { session.stop(); await ha.close(); });

	const statusP = nextEvent(session, "status", (s) => s.status !== "connecting");
	session.start();
	assert.deepEqual(await statusP, { status: "auth_invalid", message: "Home Assistant rejected the access token." });
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.equal(ha.authAttempts, 1);
});

test("a missing dashboard is reported as an error status", async (t) => {
	const ha = await fakeHa();
	const session = new DashboardSession({ url: ha.url, token: "good", dashboard: "nope" }, silent);
	t.after(async () => { session.stop(); await ha.close(); });

	const statusP = nextEvent(session, "status", (s) => s.status === "error");
	session.start();
	assert.match((await statusP).message, /Dashboard "nope" not found/);
});

test("after a dropped connection it reconnects and refreshes", async (t) => {
	const ha = await fakeHa();
	const session = new DashboardSession({ url: ha.url, token: "good", dashboard: "dashboard-ev", statsRefreshMinutes: 0 }, silent);
	t.after(async () => { session.stop(); await ha.close(); });

	const first = nextEvent(session, "stats");
	session.start();
	await first;

	const disconnected = nextEvent(session, "status", (s) => s.status === "disconnected");
	const reconnected = nextEvent(session, "status", (s) => s.status === "connected");
	const restats = nextEvent(session, "stats");
	for (const ws of ha.sockets) ws.terminate();
	await disconnected;
	await reconnected;
	await restats;
	assert.equal(ha.authAttempts, 2);
	assert.equal(ha.calls.filter((c) => c === "lovelace/config").length, 2);
});
