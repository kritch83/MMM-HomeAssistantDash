/**
 * One mirrored dashboard: reads its layout, keeps the states of the entities
 * on it live, and fetches chart statistics. Used by node_helper.js and by
 * scripts/probe.js; knows nothing about MagicMirror.
 *
 * Events: "status" {status, message}, "layout" {sections, precision},
 * "states" {entity_id: state}, "stats" {chartId: series[]}.
 */
const { EventEmitter } = require("node:events");
const { ERR_INVALID_AUTH } = require("home-assistant-js-websocket");
const { acquireConnection, releaseConnection } = require("./connection");
const { normalizeDashboard } = require("./layout");
const { applyEntityDiff } = require("./entities");
const { buildStatsRequest, toSeries } = require("./stats");

class DashboardSession extends EventEmitter {
	/**
	 * @param {object} options
	 * @param {string} options.url Home Assistant base URL
	 * @param {string} options.token long-lived access token
	 * @param {string} options.dashboard dashboard url_path ("lovelace" for the default one)
	 * @param {number|string} [options.view] view index or path
	 * @param {boolean} [options.hideDefaultHeadings]
	 * @param {number} [options.statsRefreshMinutes] fallback chart refresh interval
	 * @param {object} [log] logger with log/warn/error
	 */
	constructor (options, log = console) {
		super();
		this.options = options;
		this.log = log;
		this.conn = null;
		this.layout = null;
		this.precision = {};
		this.states = {};
		this.stats = {};
		this.status = { status: "connecting", message: null };
		this.unsubs = [];
		this.unsubEntities = null;
		this.subscribedIds = "";
		this.timer = null;
		this.stopped = false;
		this.loading = null;
		this.reloadQueued = false;
	}

	async start () {
		this.setStatus("connecting");
		try {
			this.conn = await acquireConnection(this.options.url, this.options.token);
		} catch (err) {
			if (err === ERR_INVALID_AUTH) {
				this.setStatus("auth_invalid", "Home Assistant rejected the access token.");
			} else {
				this.setStatus("error", `Could not connect to ${this.options.url} (${describe(err)}).`);
			}
			return;
		}
		if (this.stopped) {
			releaseConnection(this.options.url, this.options.token);
			return;
		}

		this.onReady = () => {
			this.setStatus("connected");
			this.reloadLayout();
		};
		this.onDisconnected = () => this.setStatus("disconnected", "Lost connection to Home Assistant, reconnecting…");
		this.onReconnectError = () => this.setStatus("auth_invalid", "Home Assistant rejected the access token.");
		this.conn.addEventListener("ready", this.onReady);
		this.conn.addEventListener("disconnected", this.onDisconnected);
		this.conn.addEventListener("reconnect-error", this.onReconnectError);

		this.setStatus("connected");
		try {
			this.unsubs.push(await this.conn.subscribeEvents((event) => {
				const changed = event.data?.url_path ?? "lovelace";
				if (changed === this.dashboardPath()) this.reloadLayout();
			}, "lovelace_updated"));
			this.unsubs.push(await this.conn.subscribeEvents(() => this.refreshStats(), "recorder_hourly_statistics_generated"));
		} catch (err) {
			this.log.warn(`Could not subscribe to HA events (${describe(err)}); layout edits need a restart.`);
		}

		const minutes = this.options.statsRefreshMinutes ?? 15;
		if (minutes > 0) this.timer = setInterval(() => this.refreshStats(), minutes * 60e3);

		await this.reloadLayout();
	}

	stop () {
		this.stopped = true;
		clearInterval(this.timer);
		if (this.conn) {
			this.conn.removeEventListener("ready", this.onReady);
			this.conn.removeEventListener("disconnected", this.onDisconnected);
			this.conn.removeEventListener("reconnect-error", this.onReconnectError);
			for (const unsub of [...this.unsubs, this.unsubEntities]) {
				if (unsub) unsub().catch(() => {});
			}
			releaseConnection(this.options.url, this.options.token);
			this.conn = null;
		}
		this.removeAllListeners();
	}

	/** Re-sends everything known so far, for a browser that (re)connected. */
	replay () {
		this.emit("status", this.status);
		if (this.layout) this.emit("layout", { sections: this.layout.sections, precision: this.precision });
		if (Object.keys(this.states).length) this.emit("states", this.states);
		if (Object.keys(this.stats).length) this.emit("stats", this.stats);
	}

	dashboardPath () {
		return this.options.dashboard || "lovelace";
	}

	setStatus (status, message = null) {
		this.status = { status, message };
		this.emit("status", this.status);
	}

	/** Serializes layout loads: a reload requested mid-load runs once afterwards. */
	reloadLayout () {
		if (this.loading) {
			this.reloadQueued = true;
			return this.loading;
		}
		this.loading = this.loadLayout()
			.catch((err) => this.setStatus("error", describe(err)))
			.finally(() => {
				this.loading = null;
				if (this.reloadQueued && !this.stopped) {
					this.reloadQueued = false;
					this.reloadLayout();
				}
			});
		return this.loading;
	}

	async loadLayout () {
		const path = this.dashboardPath();
		const config = await this.conn.sendMessagePromise({ type: "lovelace/config", url_path: path === "lovelace" ? null : path, force: false })
			.catch((err) => {
				throw new Error(err?.code === "config_not_found" ? `Dashboard "${path}" not found, or it has never been edited.` : `Could not load dashboard "${path}" (${describe(err)}).`);
			});
		if (this.stopped) return;

		this.layout = normalizeDashboard(config, { view: this.options.view ?? 0, hideDefaultHeadings: this.options.hideDefaultHeadings !== false });
		if (this.layout.skipped.length) {
			this.log.log(`Card types not drawn on the mirror: ${[...new Set(this.layout.skipped)].join(", ")}`);
		}

		try {
			const display = await this.conn.sendMessagePromise({ type: "config/entity_registry/list_for_display" });
			this.precision = {};
			for (const entry of display.entities || []) {
				if (typeof entry.dp === "number" && this.layout.entityIds.includes(entry.ei)) this.precision[entry.ei] = entry.dp;
			}
		} catch (err) {
			this.log.warn(`No display precision from HA (${describe(err)}); showing raw values.`);
		}

		this.emit("layout", { sections: this.layout.sections, precision: this.precision });
		await this.subscribeEntities(this.layout.entityIds);
		await this.refreshStats();
	}

	async subscribeEntities (ids) {
		const idsKey = [...ids].sort().join(",");
		if (idsKey === this.subscribedIds) return;
		if (this.unsubEntities) await this.unsubEntities().catch(() => {});
		this.unsubEntities = null;
		this.subscribedIds = idsKey;
		this.states = {};
		if (ids.length === 0) return;
		this.unsubEntities = await this.conn.subscribeMessage((event) => {
			this.states = applyEntityDiff(this.states, event);
			this.emit("states", this.states);
		}, { type: "subscribe_entities", entity_ids: ids });
	}

	async refreshStats () {
		if (!this.conn || !this.layout || this.layout.charts.length === 0) return;
		const stats = {};
		await Promise.all(this.layout.charts.map(async (chart) => {
			try {
				stats[chart.id] = toSeries(chart, await this.conn.sendMessagePromise(buildStatsRequest(chart)));
			} catch (err) {
				this.log.warn(`Statistics for ${chart.entities.join(", ")} failed (${describe(err)}).`);
				stats[chart.id] = this.stats[chart.id] ?? [];
			}
		}));
		if (this.stopped) return;
		this.stats = stats;
		this.emit("stats", this.stats);
	}
}

function describe (err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "number") return `error code ${err}`;
	return err?.message || err?.code || String(err);
}

module.exports = { DashboardSession };
