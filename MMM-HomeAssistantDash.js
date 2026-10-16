/* global HADashRenderers, config */

/*
 * MMM-HomeAssistantDash
 * Mirrors a Home Assistant dashboard: the node_helper reads the dashboard's
 * layout and keeps its entities live over the HA WebSocket API; this file
 * draws the cards in MagicMirror style.
 */
Module.register("MMM-HomeAssistantDash", {
	defaults: {
		url: "http://homeassistant.local:8123",
		token: "", // use "${SECRET_HA_TOKEN}" with SECRET_HA_TOKEN in config/config.env
		dashboard: "lovelace", // dashboard url_path, e.g. "dashboard-ev"
		view: 0, // view index or path
		columns: 1, // sections per row on the mirror
		width: null, // CSS width of the module, e.g. "640px"
		hideDefaultHeadings: true, // drop headings still called "New section"
		statsRefreshMinutes: 15, // fallback chart refresh; HA also pushes hourly
		updateThrottleMs: 1000 // redraw at most this often while values stream in
	},

	start () {
		this.layout = null;
		this.states = {};
		this.stats = {};
		this.status = { status: "connecting", message: null };
		this.lastRender = 0;
		this.renderTimer = null;
		this.sendSocketNotification("HAD_INIT", { id: this.identifier, config: this.config });
	},

	getStyles () {
		return [this.file("node_modules/@mdi/font/css/materialdesignicons.min.css"), this.file("css/MMM-HomeAssistantDash.css")];
	},

	getScripts () {
		return [this.file("renderers.js")];
	},

	socketNotificationReceived (notification, payload) {
		if (payload?.id !== this.identifier) return;
		switch (notification) {
			case "HAD_STATUS":
				this.status = { status: payload.status, message: payload.message };
				break;
			case "HAD_LAYOUT":
				this.layout = payload.layout;
				break;
			case "HAD_STATES":
				this.states = payload.states;
				break;
			case "HAD_STATS":
				this.stats = payload.stats;
				break;
			default:
				return;
		}
		this.scheduleRender();
	},

	/** Power sensors can report every second; redraw at most once per updateThrottleMs. */
	scheduleRender () {
		if (this.renderTimer) return;
		const wait = Math.max(0, this.lastRender + this.config.updateThrottleMs - Date.now());
		this.renderTimer = setTimeout(() => {
			this.renderTimer = null;
			this.lastRender = Date.now();
			this.updateDom(0);
		}, wait);
	},

	getDom () {
		return HADashRenderers.render({
			layout: this.layout,
			states: this.states,
			stats: this.stats,
			status: this.status,
			columns: Math.max(1, Number(this.config.columns) || 1),
			width: this.config.width,
			locale: config.locale || config.language
		});
	}
});
