/**
 * Turns a Lovelace dashboard config (the result of the `lovelace/config`
 * WebSocket command) into the flat structure the front end draws: sections of
 * normalized cards, the entities to subscribe to, and the charts whose
 * statistics have to be fetched.
 */

// HA names every new section's heading this; it carries no information.
const DEFAULT_HEADING = "New section";
const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

// Width in the 12-column section grid when a card has no grid_options.columns.
// null means full width. Mirrors the sections-view defaults in the HA frontend.
const DEFAULT_COLUMNS = { heading: null, gauge: 6, entity: 6, entities: null, chart: null };

const STACK_TYPES = new Set(["vertical-stack", "horizontal-stack", "grid"]);
const GAUGE_TYPES = new Set(["gauge", "custom:modern-circular-gauge"]);
const ENTITY_TYPES = { tile: "tile", entity: "entity", sensor: "entity" };
const ROW_TYPES = new Set(["entities", "glance"]);

/**
 * @param {object} config Lovelace config for one dashboard.
 * @param {object} [options]
 * @param {number|string} [options.view] View index, numeric string, or view `path`.
 * @param {boolean} [options.hideDefaultHeadings] Drop headings still called "New section".
 * @returns {{sections: object[], entityIds: string[], charts: object[], skipped: string[]}}
 */
function normalizeDashboard (config, { view = 0, hideDefaultHeadings = true } = {}) {
	if (config?.strategy && !config.views) {
		throw new Error("This dashboard is auto-generated (strategy). In HA, open it and choose \"Take control\" first.");
	}
	const selected = pickView(config, view);
	const ctx = { hideDefaultHeadings, entityIds: new Set(), charts: [], skipped: [] };

	let rawSections;
	if (selected.type === "sections") {
		rawSections = (selected.sections || []).map((s) => ({ span: s.column_span || 1, cards: s.cards || [] }));
	} else if (selected.type === "panel") {
		rawSections = [{ span: 1, cards: (selected.cards || []).slice(0, 1) }];
	} else {
		// Masonry/sidebar views: every top-level card flows like its own section.
		rawSections = (selected.cards || []).map((card) => ({ span: 1, cards: [card] }));
	}

	const sections = rawSections
		.map((s) => ({ span: s.span, cards: flattenCards(s.cards).map((c) => normalizeCard(c, ctx)).filter(Boolean) }))
		.filter((s) => s.cards.length > 0);

	return { sections, entityIds: [...ctx.entityIds], charts: ctx.charts, skipped: ctx.skipped };
}

function pickView (config, view) {
	const views = config?.views || [];
	const index = typeof view === "number" ? view : (/^\d+$/.test(String(view)) ? Number(view) : -1);
	const found = index >= 0 ? views[index] : views.find((v) => v.path === view);
	if (!found) {
		throw new Error(`View "${view}" not found (dashboard has ${views.length} view${views.length === 1 ? "" : "s"}).`);
	}
	return found;
}

function flattenCards (cards) {
	const out = [];
	for (const card of cards || []) {
		if (!card || typeof card !== "object") continue;
		if (STACK_TYPES.has(card.type)) {
			out.push(...flattenCards(card.cards));
		} else if (card.type === "conditional" && card.card) {
			out.push(...flattenCards([card.card]));
		} else {
			out.push(card);
		}
	}
	return out;
}

function gridColumns (card, kind) {
	const columns = card.grid_options?.columns;
	if (columns === "full") return null;
	if (typeof columns === "number") return columns;
	return DEFAULT_COLUMNS[kind];
}

function addEntity (ctx, id) {
	if (typeof id === "string" && ENTITY_ID.test(id)) ctx.entityIds.add(id);
}

/** A gauge bound may be a number or an entity whose state is the bound. */
function bound (value, fallback, ctx) {
	if (typeof value === "number") return value;
	if (typeof value === "string" && ENTITY_ID.test(value)) {
		addEntity(ctx, value);
		return value;
	}
	if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
	return fallback;
}

function normalizeCard (card, ctx) {
	if (card.type === "heading") {
		const text = card.heading ?? "";
		if (ctx.hideDefaultHeadings && (text === DEFAULT_HEADING || text === "")) return null;
		return { type: "heading", text, columns: gridColumns(card, "heading") };
	}

	if (GAUGE_TYPES.has(card.type) && card.entity) return gauge(card, ctx);

	if (ENTITY_TYPES[card.type] && card.entity) {
		addEntity(ctx, card.entity);
		return {
			type: "entity",
			variant: ENTITY_TYPES[card.type],
			entity: card.entity,
			name: card.name ?? null,
			icon: card.icon ?? null,
			attribute: card.attribute ?? null,
			unit: card.unit ?? null,
			columns: gridColumns(card, "entity")
		};
	}

	if (card.type === "statistics-graph" && Array.isArray(card.entities)) return chart(card, ctx);

	const rows = entityRows(card);
	if (rows.length > 0) {
		rows.forEach((r) => addEntity(ctx, r.entity));
		return { type: "entities", title: card.title ?? null, rows, columns: gridColumns(card, "entities") };
	}

	ctx.skipped.push(card.type);
	return null;
}

function gauge (card, ctx) {
	addEntity(ctx, card.entity);
	let secondary = null;
	const sec = typeof card.secondary === "string" ? { entity: card.secondary } : card.secondary;
	if (card.type === "custom:modern-circular-gauge" && sec?.entity && ENTITY_ID.test(sec.entity)) {
		addEntity(ctx, sec.entity);
		secondary = {
			entity: sec.entity,
			unit: sec.unit ?? null,
			min: bound(sec.min, 0, ctx),
			max: bound(sec.max, 100, ctx),
			decimals: sec.decimals ?? null,
			color: sec.gauge_foreground_style?.color ?? null,
			showGauge: sec.show_gauge === "inner" || sec.show_gauge === "outer"
		};
	}
	return {
		type: "gauge",
		entity: card.entity,
		name: card.name ?? null,
		unit: card.unit ?? null,
		min: bound(card.min, 0, ctx),
		max: bound(card.max, 100, ctx),
		decimals: card.decimals ?? null,
		icon: card.icon ?? null,
		color: card.gauge_foreground_style?.color ?? null,
		needle: card.needle === true,
		severity: card.severity ?? null,
		segments: Array.isArray(card.segments) ? card.segments : null,
		secondary,
		columns: gridColumns(card, "gauge")
	};
}

function defaultPeriod (days) {
	if (days > 90) return "month";
	if (days > 30) return "week";
	if (days > 7) return "day";
	if (days > 2) return "hour";
	return "5minute";
}

function chart (card, ctx) {
	const entities = card.entities.map((e) => (typeof e === "string" ? e : e?.entity)).filter(Boolean);
	entities.forEach((id) => addEntity(ctx, id));
	const daysToShow = card.days_to_show ?? 30;
	const normalized = {
		type: "chart",
		id: `chart-${ctx.charts.length}`,
		title: card.title ?? null,
		chartType: card.chart_type === "bar" ? "bar" : "line",
		entities,
		daysToShow,
		period: card.period ?? defaultPeriod(daysToShow),
		statTypes: Array.isArray(card.stat_types) && card.stat_types.length > 0 ? card.stat_types : ["mean", "sum", "change", "state"],
		columns: gridColumns(card, "chart")
	};
	ctx.charts.push(normalized);
	return normalized;
}

function entityRows (card) {
	const list = ROW_TYPES.has(card.type) ? card.entities : (card.entities ?? (card.entity ? [card.entity] : []));
	if (!Array.isArray(list)) return [];
	return list
		.map((e) => (typeof e === "string" ? { entity: e } : e))
		.filter((e) => typeof e?.entity === "string" && ENTITY_ID.test(e.entity))
		.map((e) => ({ entity: e.entity, name: e.name ?? null, icon: e.icon ?? null }));
}

module.exports = { normalizeDashboard, DEFAULT_HEADING };
