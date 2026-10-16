const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyEntityDiff } = require("../lib/entities");

const LC = 1792159200; // seconds, as HA sends them

test("a: adds full compressed states", () => {
	const next = applyEntityDiff({}, { a: { "sensor.x": { s: "9.576", a: { unit_of_measurement: "kWh" }, c: "ctx", lc: LC } } });
	assert.deepEqual(next, {
		"sensor.x": {
			entity_id: "sensor.x",
			state: "9.576",
			attributes: { unit_of_measurement: "kWh" },
			last_changed: new Date(LC * 1000).toISOString(),
			last_updated: new Date(LC * 1000).toISOString()
		}
	});
});

test("c: applies state and attribute changes without mutating the input", () => {
	const prev = applyEntityDiff({}, { a: { "sensor.x": { s: "0", a: { icon: "mdi:ev-station", unit_of_measurement: "A" }, c: "ctx", lc: LC } } });
	const frozen = structuredClone(prev);
	const next = applyEntityDiff(prev, { c: { "sensor.x": { "+": { s: "16.2", lc: LC + 5, a: { icon: "mdi:flash" } }, "-": { a: ["unit_of_measurement"] } } } });
	assert.deepEqual(prev, frozen, "input map untouched");
	assert.equal(next["sensor.x"].state, "16.2");
	assert.deepEqual(next["sensor.x"].attributes, { icon: "mdi:flash" });
	assert.equal(next["sensor.x"].last_changed, new Date((LC + 5) * 1000).toISOString());
});

test("c: lu-only change bumps last_updated but not last_changed", () => {
	const prev = applyEntityDiff({}, { a: { "sensor.x": { s: "1", a: {}, c: "ctx", lc: LC } } });
	const next = applyEntityDiff(prev, { c: { "sensor.x": { "+": { lu: LC + 60, a: { foo: 1 } } } } });
	assert.equal(next["sensor.x"].last_changed, new Date(LC * 1000).toISOString());
	assert.equal(next["sensor.x"].last_updated, new Date((LC + 60) * 1000).toISOString());
	assert.equal(next["sensor.x"].state, "1");
});

test("c: change for an unknown entity is ignored", () => {
	assert.deepEqual(applyEntityDiff({}, { c: { "sensor.ghost": { "+": { s: "1" } } } }), {});
});

test("r: removes entities", () => {
	const prev = applyEntityDiff({}, { a: { "sensor.x": { s: "1", a: {}, c: "ctx", lc: LC }, "sensor.y": { s: "2", a: {}, c: "ctx", lc: LC } } });
	assert.deepEqual(Object.keys(applyEntityDiff(prev, { r: ["sensor.x"] })), ["sensor.y"]);
});
