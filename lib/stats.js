/**
 * Statistics for `statistics-graph` cards, fetched and shaped the same way the
 * HA frontend does it so the mirror's chart matches the dashboard's.
 */

/**
 * @param {object} chart normalized chart card (see lib/layout.js)
 * @param {Date} [now]
 * @returns {object} a `recorder/statistics_during_period` WebSocket message
 */
function buildStatsRequest (chart, now = new Date()) {
	// HA's card looks back days_to_show days plus one hour.
	const start = new Date(now.getTime() - (chart.daysToShow * 24 + 1) * 3600e3);
	return {
		type: "recorder/statistics_during_period",
		start_time: start.toISOString(),
		statistic_ids: chart.entities,
		period: chart.period,
		types: [...new Set(chart.statTypes)]
	};
}

/**
 * One series per entity, using the first of the card's stat types that has data.
 * `sum` is plotted relative to the first sum in the window, like HA's chart:
 * a running total for the window, not the meter's lifetime reading.
 * @param {object} chart normalized chart card
 * @param {object} response result of statistics_during_period: id → rows
 * @returns {{entity: string, statType: string, points: {start: number, end: number, value: number|null}[]}[]}
 */
function toSeries (chart, response) {
	return chart.entities.map((entity) => {
		const rows = response?.[entity] ?? [];
		const statType = chart.statTypes.find((t) => rows.some((r) => r[t] != null)) ?? chart.statTypes[0];
		let firstSum = null;
		const points = rows.map((row) => {
			let value = row[statType] ?? null;
			if (statType === "sum" && value !== null) {
				if (firstSum === null) firstSum = value;
				value -= firstSum;
			}
			return { start: row.start, end: row.end, value };
		});
		return { entity, statType, points };
	});
}

module.exports = { buildStatsRequest, toSeries };
