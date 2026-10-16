const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildStatsRequest, toSeries } = require("../lib/stats");
const { normalizeDashboard } = require("../lib/layout");
const dashboardEv = require("./fixtures/dashboard-ev.json");
const energyDay = require("./fixtures/stats-energy-day.json");
const voltageHour = require("./fixtures/stats-voltage-hour.json");

const [barChart, lineChart] = normalizeDashboard(dashboardEv).charts;
const NOW = new Date(1792159300000);

test("buildStatsRequest mirrors HA's statistics-graph window (days_to_show + 1h)", () => {
	assert.deepEqual(buildStatsRequest(barChart, NOW), {
		type: "recorder/statistics_during_period",
		start_time: new Date(NOW.getTime() - (7 * 24 + 1) * 3600e3).toISOString(),
		statistic_ids: ["sensor.charlie_energy_active_import_register"],
		period: "day",
		types: ["sum"]
	});
});

test("bar chart of `sum` is relative to the first sum in the window (matches HA's chart)", () => {
	const [series] = toSeries(barChart, energyDay);
	assert.equal(series.entity, "sensor.charlie_energy_active_import_register");
	assert.equal(series.statType, "sum");
	const values = series.points.map((p) => Number(p.value.toFixed(2)));
	assert.deepEqual(values, [0, 0, 19.24, 27.03, 27.03, 36.84, 46.41, 46.41]);
	assert.equal(series.points[0].start, 1791522000000);
});

test("line chart of `mean` passes values through", () => {
	const [series] = toSeries(lineChart, voltageHour);
	assert.equal(series.statType, "mean");
	assert.deepEqual(series.points.map((p) => p.value), voltageHour["sensor.charlie_voltage"].map((p) => p.mean));
});

test("`change` passes through, and the first stat type present in the data wins", () => {
	const chart = { ...barChart, statTypes: ["mean", "change"] };
	const [series] = toSeries(chart, energyDay);
	assert.equal(series.statType, "change");
	assert.equal(series.points[2].value, 19.24369999999999);
});

test("entities with no data produce an empty series rather than throwing", () => {
	const [series] = toSeries(barChart, {});
	assert.deepEqual(series.points, []);
});
