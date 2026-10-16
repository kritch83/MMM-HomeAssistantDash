/**
 * A fake Home Assistant WebSocket server that speaks just enough of the
 * protocol for this module: auth, lovelace/config, list_for_display,
 * subscribe_entities, subscribe_events and statistics_during_period.
 * Serves the captured dashboard-ev fixtures. Used by the tests and for
 * developing the look of the module without a real HA.
 */
const { once } = require("node:events");
const { WebSocketServer } = require("ws");
const dashboardEv = require("../fixtures/dashboard-ev.json");
const statesEv = require("../fixtures/states-ev.json");
const energyDay = require("../fixtures/stats-energy-day.json");
const voltageHour = require("../fixtures/stats-voltage-hour.json");

const PRECISION = [
	{ ei: "sensor.charlie_current_export", dp: 2 },
	{ ei: "sensor.charlie_power_active_import", dp: 2 },
	{ ei: "sensor.charlie_energy_session", dp: 2 },
	{ ei: "sensor.charlie_energy_active_import_register", dp: 2 },
	{ ei: "sensor.charlie_voltage", dp: 0 },
	{ ei: "light.elsewhere", dp: 1 }
];

async function startFakeHa ({ token = "good", port = 0, dashboard = dashboardEv, states = statesEv } = {}) {
	const wss = new WebSocketServer({ port });
	await once(wss, "listening");
	const ha = { wss, url: `http://127.0.0.1:${wss.address().port}`, calls: [], authAttempts: 0, sockets: new Set(), entitySubs: [], eventSubs: [], states: structuredClone(states) };

	wss.on("connection", (ws) => {
		ha.sockets.add(ws);
		ws.on("close", () => {
			ha.sockets.delete(ws);
			ha.entitySubs = ha.entitySubs.filter((s) => s.ws !== ws);
			ha.eventSubs = ha.eventSubs.filter((s) => s.ws !== ws);
		});
		const send = (msg) => ws.send(JSON.stringify(msg));
		const result = (id, value = null) => send({ id, type: "result", success: true, result: value });
		send({ type: "auth_required", ha_version: "2026.10.1" });

		ws.on("message", (raw) => {
			const msg = JSON.parse(raw);
			if (msg.type === "auth") {
				ha.authAttempts += 1;
				if (msg.access_token === token) {
					send({ type: "auth_ok", ha_version: "2026.10.1" });
				} else {
					send({ type: "auth_invalid", message: "Invalid access token or password" });
					ws.close();
				}
				return;
			}
			ha.calls.push(msg.type);
			switch (msg.type) {
				case "lovelace/config":
					return msg.url_path === "dashboard-ev"
						? result(msg.id, dashboard)
						: send({ id: msg.id, type: "result", success: false, error: { code: "config_not_found", message: "No config found." } });
				case "config/entity_registry/list_for_display":
					return result(msg.id, { entity_categories: {}, entities: PRECISION });
				case "subscribe_entities": {
					ha.entitySubs.push({ ws, id: msg.id, ids: msg.entity_ids });
					result(msg.id);
					const lc = Math.floor(Date.now() / 1000);
					const added = {};
					for (const id of msg.entity_ids) {
						const s = ha.states[id] ?? { state: "unknown", attributes: {} };
						added[id] = { s: s.state, a: s.attributes, c: "fake", lc };
					}
					return send({ id: msg.id, type: "event", event: { a: added } });
				}
				case "subscribe_events":
					ha.eventSubs.push({ ws, id: msg.id, eventType: msg.event_type });
					return result(msg.id);
				case "recorder/statistics_during_period":
					return result(msg.id, msg.statistic_ids[0] === "sensor.charlie_voltage" ? voltageHour : energyDay);
				default:
					return result(msg.id);
			}
		});
	});

	/** Sends a raw compressed diff to the latest entity subscription. */
	ha.pushEntityChange = (event) => {
		const sub = ha.entitySubs.at(-1);
		sub.ws.send(JSON.stringify({ id: sub.id, type: "event", event }));
	};
	/** Changes one state and tells every subscriber that watches it. */
	ha.setState = (entityId, state) => {
		ha.states[entityId] = { ...ha.states[entityId], state: String(state) };
		const event = { c: { [entityId]: { "+": { s: String(state), lc: Math.floor(Date.now() / 1000) } } } };
		for (const sub of ha.entitySubs.filter((s) => s.ids.includes(entityId))) {
			sub.ws.send(JSON.stringify({ id: sub.id, type: "event", event }));
		}
	};
	ha.fireEvent = (eventType, data) => {
		for (const sub of ha.eventSubs.filter((s) => s.eventType === eventType)) {
			sub.ws.send(JSON.stringify({ id: sub.id, type: "event", event: { event_type: eventType, data } }));
		}
	};
	ha.close = async () => {
		for (const ws of ha.sockets) ws.terminate();
		await new Promise((resolve) => wss.close(resolve));
	};
	return ha;
}

module.exports = { startFakeHa };

// `node test/helpers/fake-ha.js [port] [token]` runs it standalone and
// simulates a charging session so the gauge moves.
if (require.main === module) {
	const port = Number(process.argv[2] || 8124);
	const token = process.argv[3] || "dev-token";
	startFakeHa({ port, token }).then((ha) => {
		console.log(`Fake HA on ${ha.url} (token "${token}")`);
		let t = 0;
		setInterval(() => {
			t += 1;
			const amps = Math.max(0, 24 + 6 * Math.sin(t / 5));
			ha.setState("sensor.charlie_current_export", amps.toFixed(3));
			ha.setState("sensor.charlie_power_active_import", ((amps * 240) / 1000).toFixed(3));
			ha.setState("sensor.charlie_energy_session", (9.576 + t * 0.0016).toFixed(4));
		}, 2000);
		setTimeout(() => {
			ha.setState("switch.charlie_charge_control", "on");
			ha.setState("sensor.charlie_status_connector", "Charging");
		}, 1000);
	});
}
