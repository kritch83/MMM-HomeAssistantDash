#!/usr/bin/env node
/**
 * Checks the Home Assistant side without MagicMirror: connects, reads the
 * dashboard, prints its parsed layout, current states and chart series.
 *
 *   node --env-file=.env.local scripts/probe.js [dashboard] [view]
 *
 * Reads HA_URL (default http://10.0.0.16:8123) and SECRET_HA_TOKEN from the
 * environment. The token is never printed.
 */
const { DashboardSession } = require("../lib/session");

const url = process.env.HA_URL || "http://10.0.0.16:8123";
const token = process.env.SECRET_HA_TOKEN;
const dashboard = process.argv[2] || "dashboard-ev";
const view = process.argv[3] ?? 0;

if (!token) {
	console.error("SECRET_HA_TOKEN is not set. Put SECRET_HA_TOKEN=<long-lived token> in .env.local and run with --env-file=.env.local.");
	process.exit(2);
}

const session = new DashboardSession({ url, token, dashboard, view, statsRefreshMinutes: 0 });
let layout = null;
let states = null;
let stats = null;
const timeout = setTimeout(() => finish("Timed out after 20 s waiting for HA."), 20e3);

session.on("status", ({ status, message }) => {
	console.log(`[status] ${status}${message ? ` — ${message}` : ""}`);
	if (status === "auth_invalid" || status === "error") finish(message);
});
session.on("layout", (l) => { layout = l; maybeFinish(); });
session.on("states", (s) => { states = s; maybeFinish(); });
session.on("stats", (s) => { stats = s; maybeFinish(); });

console.log(`Connecting to ${url}, dashboard "${dashboard}", view ${view} …`);
session.start();

function maybeFinish () {
	if (layout && states && stats) finish();
}

function finish (error) {
	clearTimeout(timeout);
	if (layout) {
		console.log("\nLayout:");
		layout.sections.forEach((section, i) => {
			console.log(`  section ${i + 1} (span ${section.span})`);
			for (const card of section.cards) {
				const what = card.entity || card.text || card.entities?.join(", ") || card.rows?.map((r) => r.entity).join(", ");
				console.log(`    ${card.type.padEnd(8)} ${what}${card.columns ? `  [${card.columns} cols]` : ""}`);
			}
		});
		console.log("\nDisplay precision:", layout.precision);
	}
	if (states) {
		console.log("\nStates:");
		for (const [id, s] of Object.entries(states)) {
			console.log(`  ${id.padEnd(48)} ${s.state} ${s.attributes.unit_of_measurement ?? ""}`);
		}
	}
	if (stats) {
		console.log("\nCharts:");
		for (const [chartId, seriesList] of Object.entries(stats)) {
			for (const series of seriesList) {
				const values = series.points.map((p) => (p.value === null ? "–" : p.value.toFixed(2)));
				console.log(`  ${chartId} ${series.entity} (${series.statType}, ${values.length} points): ${values.join(" ")}`);
			}
		}
	}
	session.stop();
	if (error) {
		console.error(`\n${error}`);
		process.exit(1);
	}
	process.exit(0);
}
