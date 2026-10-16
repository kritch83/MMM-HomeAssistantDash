const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeDashboard } = require("../lib/layout");
const dashboardEv = require("./fixtures/dashboard-ev.json");

test("dashboard-ev: four sections, default headings hidden", () => {
	const layout = normalizeDashboard(dashboardEv);
	assert.equal(layout.sections.length, 4);
	assert.deepEqual(layout.sections.map((s) => s.span), [1, 1, 3, 1]);
	assert.deepEqual(
		layout.sections.map((s) => s.cards.map((c) => c.type)),
		[["gauge"], ["entity", "entity", "entity"], ["chart"], ["chart"]]
	);
});

test("dashboard-ev: collects every entity, including gauge secondary and chart entities", () => {
	const layout = normalizeDashboard(dashboardEv);
	assert.deepEqual([...layout.entityIds].sort(), [
		"sensor.charlie_current_export",
		"sensor.charlie_energy_active_import_register",
		"sensor.charlie_energy_session",
		"sensor.charlie_power_active_import",
		"sensor.charlie_status_connector",
		"sensor.charlie_voltage",
		"switch.charlie_charge_control"
	]);
});

test("dashboard-ev: modern-circular-gauge maps primary and inner secondary ring", () => {
	const [gauge] = normalizeDashboard(dashboardEv).sections[0].cards;
	assert.equal(gauge.entity, "sensor.charlie_current_export");
	assert.equal(gauge.name, "Current Draw");
	assert.equal(gauge.unit, "A");
	assert.equal(gauge.min, 0);
	assert.equal(gauge.max, 32);
	assert.equal(gauge.decimals, 2);
	assert.equal(gauge.columns, 12);
	assert.deepEqual(gauge.secondary, {
		entity: "sensor.charlie_power_active_import",
		unit: "kW",
		min: 0,
		max: 7.3,
		decimals: 2,
		color: "green",
		showGauge: true
	});
});

test("dashboard-ev: tile and entity cards keep name, icon and grid width", () => {
	const [toggle, status, session] = normalizeDashboard(dashboardEv).sections[1].cards;
	assert.deepEqual(toggle, { type: "entity", variant: "tile", entity: "switch.charlie_charge_control", name: null, icon: null, attribute: null, unit: null, columns: 6 });
	assert.equal(status.variant, "entity");
	assert.equal(status.name, "Status");
	assert.equal(status.icon, "mdi:lightning-bolt");
	assert.equal(session.columns, null, "grid_options.columns: full → null (full width)");
});

test("dashboard-ev: statistics graphs become chart requests with stable ids", () => {
	const layout = normalizeDashboard(dashboardEv);
	assert.deepEqual(layout.charts.map((c) => c.id), ["chart-0", "chart-1"]);
	const [bar, line] = layout.charts;
	assert.deepEqual(
		{ chartType: bar.chartType, daysToShow: bar.daysToShow, period: bar.period, statTypes: bar.statTypes, entities: bar.entities, columns: bar.columns },
		{ chartType: "bar", daysToShow: 7, period: "day", statTypes: ["sum"], entities: ["sensor.charlie_energy_active_import_register"], columns: 21 }
	);
	assert.equal(line.chartType, "line");
	assert.equal(line.period, "hour");
	assert.deepEqual(line.statTypes, ["mean"]);
	assert.equal(layout.sections[2].cards[0], bar, "section card and chart list share the same object");
});

test("hideDefaultHeadings: false keeps the placeholder headings", () => {
	const layout = normalizeDashboard(dashboardEv, { hideDefaultHeadings: false });
	assert.deepEqual(layout.sections[0].cards[0], { type: "heading", text: "New section", columns: null });
});

test("view can be picked by index, numeric string or path", () => {
	const cfg = { views: [{ path: "home", cards: [{ type: "entity", entity: "light.a" }] }, { path: "ev", cards: [{ type: "entity", entity: "sensor.b" }] }] };
	assert.deepEqual(normalizeDashboard(cfg, { view: 1 }).entityIds, ["sensor.b"]);
	assert.deepEqual(normalizeDashboard(cfg, { view: "1" }).entityIds, ["sensor.b"]);
	assert.deepEqual(normalizeDashboard(cfg, { view: "ev" }).entityIds, ["sensor.b"]);
	assert.throws(() => normalizeDashboard(cfg, { view: "nope" }), /View "nope" not found/);
});

test("masonry view: each top-level card becomes its own section", () => {
	const cfg = { views: [{ cards: [{ type: "entity", entity: "light.a" }, { type: "gauge", entity: "sensor.b" }] }] };
	const layout = normalizeDashboard(cfg);
	assert.equal(layout.sections.length, 2);
	assert.equal(layout.sections[1].cards[0].type, "gauge");
	assert.equal(layout.sections[1].cards[0].max, 100, "core gauge defaults to 0–100");
});

test("stacks are flattened and conditional cards unwrapped", () => {
	const cfg = {
		views: [{
			cards: [{
				type: "vertical-stack",
				cards: [
					{ type: "horizontal-stack", cards: [{ type: "tile", entity: "light.a" }, { type: "tile", entity: "light.b" }] },
					{ type: "conditional", conditions: [], card: { type: "entity", entity: "sensor.c" } }
				]
			}]
		}]
	};
	const layout = normalizeDashboard(cfg);
	assert.deepEqual(layout.sections[0].cards.map((c) => c.entity), ["light.a", "light.b", "sensor.c"]);
});

test("entities/glance cards become rows; unknown cards fall back or are skipped", () => {
	const cfg = {
		views: [{
			type: "sections",
			sections: [{
				cards: [
					{ type: "entities", title: "Car", entities: ["sensor.range", { entity: "sensor.soc", name: "Battery" }, { type: "divider" }] },
					{ type: "custom:mystery-card", entity: "sensor.mystery" },
					{ type: "markdown", content: "hi" }
				]
			}]
		}]
	};
	const layout = normalizeDashboard(cfg);
	const [list, fallback] = layout.sections[0].cards;
	assert.equal(layout.sections[0].cards.length, 2, "markdown has no entity and is skipped");
	assert.equal(list.title, "Car");
	assert.deepEqual(list.rows, [{ entity: "sensor.range", name: null, icon: null }, { entity: "sensor.soc", name: "Battery", icon: null }]);
	assert.deepEqual(fallback.rows, [{ entity: "sensor.mystery", name: null, icon: null }]);
	assert.deepEqual(layout.skipped, ["markdown"]);
});

test("gauge min/max may reference an entity, which is then subscribed", () => {
	const cfg = { views: [{ cards: [{ type: "custom:modern-circular-gauge", entity: "sensor.amps", max: "number.charger_max_current" }] }] };
	const layout = normalizeDashboard(cfg);
	assert.equal(layout.sections[0].cards[0].max, "number.charger_max_current");
	assert.deepEqual(layout.entityIds, ["sensor.amps", "number.charger_max_current"]);
});
