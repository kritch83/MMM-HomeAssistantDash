const NodeHelper = require("node_helper");
const Log = require("logger");
const { DashboardSession } = require("./lib/session");

module.exports = NodeHelper.create({
	start () {
		Log.log(`Starting module helper: ${this.name}`);
		// identifier → {session, configKey}
		this.instances = new Map();
	},

	stop () {
		for (const { session } of this.instances.values()) session.stop();
		this.instances.clear();
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "HAD_INIT") return;
		const { id, config } = payload;
		const send = (name, data) => this.sendSocketNotification(name, { id, ...data });

		// MagicMirror swaps **SECRET_x** placeholders for the real value before
		// they reach us, as long as config.env defines SECRET_x.
		const token = config.token && !String(config.token).startsWith("**SECRET_") ? config.token : process.env.SECRET_HA_TOKEN;
		if (!token) {
			send("HAD_STATUS", { status: "error", message: "No access token. Set SECRET_HA_TOKEN in config/config.env and token: \"${SECRET_HA_TOKEN}\" in config.js." });
			return;
		}
		if (!config.url) {
			send("HAD_STATUS", { status: "error", message: "Missing `url` (for example http://10.0.0.16:8123)." });
			return;
		}

		// A browser reload, or a second browser, re-sends HAD_INIT. Same config:
		// keep the HA session and just replay what we have.
		const configKey = JSON.stringify({ ...config, token });
		const existing = this.instances.get(id);
		if (existing?.configKey === configKey) {
			existing.session.replay();
			return;
		}
		existing?.session.stop();

		const session = new DashboardSession({ ...config, token }, Log);
		session.on("status", (status) => {
			if (status.message) Log[status.status === "connected" ? "log" : "warn"](`${this.name}: ${status.message}`);
			send("HAD_STATUS", status);
		});
		session.on("layout", (layout) => send("HAD_LAYOUT", { layout }));
		session.on("states", (states) => send("HAD_STATES", { states }));
		session.on("stats", (stats) => send("HAD_STATS", { stats }));
		this.instances.set(id, { session, configKey });
		session.start();
	}
});
