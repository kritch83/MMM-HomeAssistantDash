/*
 * Browser-side drawing for MMM-HomeAssistantDash. Exposes one global,
 * HADashRenderers.render(), which turns the layout / states / stats sent by
 * the node_helper into DOM. Values from HA always go in via textContent.
 */
(function () {
	const SVG = "http://www.w3.org/2000/svg";
	const GRID = 12; // HA's sections use a 12-column grid per section column

	// HA's named colors (as used by modern-circular-gauge and gauge segments).
	const NAMED_COLORS = {
		red: "#f44336", pink: "#e91e63", purple: "#926bc7", "deep-purple": "#6e41ab", indigo: "#3f51b5",
		blue: "#2196f3", "light-blue": "#03a9f4", cyan: "#00bcd4", teal: "#009688", green: "#4caf50",
		"light-green": "#8bc34a", lime: "#cddc39", yellow: "#ffeb3b", amber: "#ffc107", orange: "#ff9800",
		"deep-orange": "#ff6f22", brown: "#795548", grey: "#9e9e9e", "blue-grey": "#607d8b", white: "#ffffff"
	};
	const STATE_WORDS = { on: "On", off: "Off", open: "Open", closed: "Closed", home: "Home", not_home: "Away", unavailable: "Unavailable", unknown: "Unknown" };
	const DOMAIN_ICONS = { switch: "toggle-switch-variant", light: "lightbulb", sensor: "eye", binary_sensor: "checkbox-blank-circle-outline", number: "ray-vertex", input_number: "ray-vertex", climate: "thermostat", lock: "lock", cover: "window-shutter", person: "account", device_tracker: "account" };

	function el (tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined && text !== null) node.textContent = text;
		return node;
	}

	function svg (tag, attrs) {
		const node = document.createElementNS(SVG, tag);
		for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
		return node;
	}

	function color (name, fallback) {
		if (!name) return fallback;
		return NAMED_COLORS[name] || name;
	}

	/* ---------- state formatting (follows HA's frontend rules) ---------- */

	function numberFormat (locale, decimals) {
		const opts = typeof decimals === "number" ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : { maximumFractionDigits: 3 };
		try {
			return new Intl.NumberFormat(locale, opts);
		} catch {
			return new Intl.NumberFormat(undefined, opts);
		}
	}

	function unitSpacer (unit) {
		return unit === "%" || unit.startsWith("°") ? "" : " ";
	}

	/**
	 * @returns {{value: string, unit: string, numeric: number|null}}
	 */
	function formatState (ctx, entityId, { decimals = null, unit = null, attribute = null } = {}) {
		const s = ctx.states[entityId];
		if (!s) return { value: "—", unit: "", numeric: null };
		const raw = attribute ? s.attributes[attribute] : s.state;
		if (raw === undefined || raw === null) return { value: "—", unit: "", numeric: null };
		const displayUnit = unit ?? (attribute ? "" : s.attributes.unit_of_measurement ?? "");
		const num = typeof raw === "number" ? raw : (String(raw).trim() !== "" ? Number(raw) : NaN);
		if (!Number.isNaN(num) && (displayUnit || s.attributes.state_class || typeof raw === "number" || decimals !== null || ctx.precision[entityId] !== undefined)) {
			const dp = decimals ?? ctx.precision[entityId] ?? null;
			return { value: numberFormat(ctx.locale, dp).format(num), unit: displayUnit, numeric: num };
		}
		const text = String(raw);
		const word = STATE_WORDS[text] ?? (text.charAt(0).toUpperCase() + text.slice(1));
		return { value: word, unit: "", numeric: null };
	}

	function stateText (formatted) {
		return formatted.unit ? `${formatted.value}${unitSpacer(formatted.unit)}${formatted.unit}` : formatted.value;
	}

	function friendlyName (ctx, entityId) {
		return ctx.states[entityId]?.attributes.friendly_name ?? entityId;
	}

	function icon (ctx, entityId, override) {
		const name = override || ctx.states[entityId]?.attributes.icon || `mdi:${DOMAIN_ICONS[entityId.split(".")[0]] || "bookmark"}`;
		return el("span", `had-icon mdi mdi-${name.replace(/^mdi:/, "")}`);
	}

	function isActive (ctx, entityId) {
		return ["on", "open", "home", "playing"].includes(ctx.states[entityId]?.state);
	}

	/* ---------- cards ---------- */

	function headingCard (ctx, card) {
		return el("div", "had-heading xsmall", card.text);
	}

	function entityCard (ctx, card) {
		const formatted = formatState(ctx, card.entity, { unit: card.unit, attribute: card.attribute });
		const name = card.name ?? friendlyName(ctx, card.entity);

		if (card.variant === "tile") {
			const node = el("div", "had-tile");
			const badge = el("div", `had-tile-icon${isActive(ctx, card.entity) ? " had-active" : ""}`);
			badge.append(icon(ctx, card.entity, card.icon));
			const text = el("div", "had-tile-text");
			text.append(el("div", "had-name small normal", name), el("div", "had-state small bright", stateText(formatted)));
			node.append(badge, text);
			return node;
		}

		const node = el("div", "had-entity");
		const head = el("div", "had-entity-head");
		head.append(el("span", "had-name small normal", name), icon(ctx, card.entity, card.icon));
		const value = el("div", "had-entity-value bright");
		value.append(el("span", "had-big light", formatted.value));
		if (formatted.unit) value.append(el("span", "had-unit small normal", formatted.unit));
		node.append(head, value);
		return node;
	}

	function entitiesCard (ctx, card) {
		const node = el("div", "had-entities");
		if (card.title) node.append(el("div", "had-heading xsmall", card.title));
		for (const row of card.rows) {
			const line = el("div", "had-row small");
			line.append(icon(ctx, row.entity, row.icon), el("span", "had-row-name normal", row.name ?? friendlyName(ctx, row.entity)), el("span", "had-row-state bright", stateText(formatState(ctx, row.entity))));
			node.append(line);
		}
		return node;
	}

	/* ---------- gauge ---------- */

	const START_ANGLE = 135; // degrees, clockwise from +x; 270° sweep leaves a gap at the bottom
	const SWEEP = 270;

	function polar (cx, cy, r, deg) {
		const rad = (deg * Math.PI) / 180;
		return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
	}

	function arcPath (r, fraction) {
		const end = START_ANGLE + SWEEP * fraction;
		const [x1, y1] = polar(100, 100, r, START_ANGLE);
		const [x2, y2] = polar(100, 100, r, end);
		return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${SWEEP * fraction > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
	}

	function resolveBound (ctx, value) {
		if (typeof value === "number") return value;
		const n = Number(ctx.states[value]?.state);
		return Number.isNaN(n) ? null : n;
	}

	function fractionOf (ctx, value, min, max) {
		const lo = resolveBound(ctx, min) ?? 0;
		const hi = resolveBound(ctx, max) ?? 100;
		if (value === null || hi <= lo) return 0;
		return Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
	}

	function severityColor (card, value) {
		if (value === null) return null;
		if (card.segments) {
			const hit = [...card.segments].sort((a, b) => a.from - b.from).filter((s) => value >= s.from).pop();
			return hit ? color(hit.color) : null;
		}
		const s = card.severity;
		if (!s) return null;
		if (s.red !== undefined && value >= s.red) return NAMED_COLORS.red;
		if (s.yellow !== undefined && value >= s.yellow) return NAMED_COLORS.amber;
		if (s.green !== undefined && value >= s.green) return NAMED_COLORS.green;
		return null;
	}

	function ring (r, fraction, stroke, width) {
		const group = svg("g");
		group.append(svg("path", { d: arcPath(r, 1), class: "had-ring-bg", "stroke-width": width }));
		if (fraction > 0) group.append(svg("path", { d: arcPath(r, fraction), class: "had-ring-fg", stroke, "stroke-width": width }));
		return group;
	}

	function gaugeCard (ctx, card) {
		const primary = formatState(ctx, card.entity, { decimals: card.decimals, unit: card.unit });
		const node = el("div", "had-gauge");
		const dial = el("div", "had-gauge-dial");
		const drawing = svg("svg", { viewBox: "0 0 200 200", class: "had-gauge-svg" });
		const mainColor = severityColor(card, primary.numeric) || color(card.color, "var(--had-gauge-color)");
		drawing.append(ring(88, fractionOf(ctx, primary.numeric, card.min, card.max), mainColor, 8));

		let secondary = null;
		if (card.secondary) {
			secondary = formatState(ctx, card.secondary.entity, { decimals: card.secondary.decimals, unit: card.secondary.unit });
			if (card.secondary.showGauge) {
				drawing.append(ring(74, fractionOf(ctx, secondary.numeric, card.secondary.min, card.secondary.max), color(card.secondary.color, "var(--had-gauge-color)"), 5));
			}
		}

		const center = el("div", "had-gauge-center");
		const main = el("div", "had-gauge-value bright");
		main.append(el("span", "had-gauge-number light", primary.value));
		if (primary.unit) main.append(el("sup", "had-gauge-unit normal", primary.unit));
		center.append(main);
		if (secondary) {
			const sec = el("div", "had-gauge-secondary normal");
			sec.append(el("span", "light", secondary.value));
			if (secondary.unit) sec.append(el("sup", "had-gauge-unit", secondary.unit));
			center.append(sec);
		}
		const glyph = icon(ctx, card.entity, card.icon);
		glyph.classList.add("had-gauge-icon");
		center.append(glyph);

		dial.append(drawing, center);
		node.append(dial, el("div", "had-gauge-name small normal", card.name ?? friendlyName(ctx, card.entity)));
		return node;
	}

	/* ---------- statistics chart ---------- */

	const CHART_W = 300;
	const CHART_H = 110;

	function niceCeil (value) {
		if (value <= 0) return 1;
		const magnitude = 10 ** Math.floor(Math.log10(value));
		return [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((v) => v >= value);
	}

	function timeLabel (ctx, ms, period) {
		const date = new Date(ms);
		try {
			if (period === "month") return date.toLocaleDateString(ctx.locale, { month: "short" });
			if (period === "day" || period === "week") return date.toLocaleDateString(ctx.locale, { month: "short", day: "numeric" });
			return date.toLocaleTimeString(ctx.locale, { hour: "numeric", minute: "2-digit" });
		} catch {
			return date.toISOString().slice(11, 16);
		}
	}

	function chartCard (ctx, card) {
		const node = el("div", "had-chart");
		const seriesList = (ctx.stats[card.id] || []).filter((s) => s.points.some((p) => p.value !== null));
		if (card.title) node.append(el("div", "had-heading xsmall", card.title));
		if (seriesList.length === 0) {
			node.append(el("div", "had-chart-empty xsmall dimmed", ctx.stats[card.id] ? "No statistics yet" : "Loading…"));
			return node;
		}

		const values = seriesList.flatMap((s) => s.points.map((p) => p.value).filter((v) => v !== null));
		let lo = card.chartType === "bar" ? Math.min(0, ...values) : Math.min(...values);
		let hi = Math.max(...values);
		if (card.chartType === "bar") {
			hi = niceCeil(hi);
		} else {
			const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1;
			// Padding never pushes an all-positive series below zero.
			lo = lo >= 0 ? Math.max(0, lo - pad) : lo - pad;
			hi += pad;
		}
		const y = (v) => CHART_H - ((v - lo) / (hi - lo)) * CHART_H;
		const unit = ctx.states[seriesList[0].entity]?.attributes.unit_of_measurement ?? "";
		const range = hi - lo;
		const decimals = range >= 10 ? 0 : range >= 1 ? 1 : range >= 0.1 ? 2 : 3;

		const plot = el("div", "had-chart-plot");
		const drawing = svg("svg", { viewBox: `0 0 ${CHART_W} ${CHART_H}`, preserveAspectRatio: "none", class: "had-chart-svg" });
		for (const fraction of [0.5, 1]) {
			drawing.append(svg("line", { x1: 0, x2: CHART_W, y1: CHART_H * (1 - fraction), y2: CHART_H * (1 - fraction), class: "had-gridline" }));
		}

		seriesList.forEach((series, i) => {
			const n = series.points.length;
			const cls = `had-series had-series-${i % 4}`;
			if (card.chartType === "bar") {
				const slot = CHART_W / n;
				const width = (slot * 0.7) / seriesList.length;
				series.points.forEach((p, j) => {
					if (p.value === null) return;
					const top = y(Math.max(p.value, 0));
					const height = Math.abs(y(p.value) - y(0));
					drawing.append(svg("rect", { x: (j * slot + slot * 0.15 + i * width).toFixed(2), y: top.toFixed(2), width: width.toFixed(2), height: Math.max(height, 0.5).toFixed(2), class: cls }));
				});
			} else {
				const x = (j) => (n === 1 ? CHART_W / 2 : (j / (n - 1)) * CHART_W);
				const pts = series.points.map((p, j) => (p.value === null ? null : `${x(j).toFixed(2)},${y(p.value).toFixed(2)}`)).filter(Boolean);
				drawing.append(svg("polyline", { points: pts.join(" "), class: `${cls} had-line`, "vector-effect": "non-scaling-stroke" }));
			}
		});

		const axis = el("div", "had-chart-axis xsmall dimmed");
		axis.append(el("span", null, `${numberFormat(ctx.locale, decimals).format(hi)}${unit ? ` ${unit}` : ""}`), el("span", null, numberFormat(ctx.locale, decimals).format(lo)));
		const points = seriesList[0].points;
		const times = el("div", "had-chart-times xsmall dimmed");
		times.append(el("span", null, timeLabel(ctx, points[0].start, card.period)), el("span", null, timeLabel(ctx, points[points.length - 1].start, card.period)));
		plot.append(axis, drawing, times);

		const legend = el("div", "had-chart-legend xsmall normal");
		seriesList.forEach((series, i) => {
			const item = el("span", "had-legend-item");
			item.append(el("span", `had-swatch had-series-${i % 4}`), document.createTextNode(friendlyName(ctx, series.entity)));
			legend.append(item);
		});

		node.append(plot, legend);
		return node;
	}

	/* ---------- layout ---------- */

	const RENDERERS = { heading: headingCard, entity: entityCard, entities: entitiesCard, gauge: gaugeCard, chart: chartCard };

	function statusText (status) {
		if (status.message) return status.message;
		return status.status === "connecting" ? "Connecting to Home Assistant…" : "Waiting for Home Assistant…";
	}

	/**
	 * @param {object} input
	 * @param {object|null} input.layout {sections, precision}
	 * @param {object} input.states entity_id → state
	 * @param {object} input.stats chart id → series[]
	 * @param {object} input.status {status, message}
	 * @param {number} input.columns sections per row
	 * @param {string|null} input.width CSS width
	 * @param {string} [input.locale]
	 * @returns {HTMLElement}
	 */
	function render ({ layout, states, stats, status, columns, width, locale }) {
		const root = el("div", "had");
		if (width) root.style.width = width;

		if (!layout) {
			root.append(el("div", `had-status small ${status.status === "connecting" ? "dimmed" : "normal"}`, statusText(status)));
			return root;
		}

		const ctx = { states, stats, precision: layout.precision || {}, locale };
		const grid = el("div", "had-grid");
		grid.style.setProperty("--had-columns", columns);
		if (status.status !== "connected") root.classList.add("had-stale");

		for (const section of layout.sections) {
			const span = Math.min(section.span, columns);
			const cols = GRID * span;
			const sectionNode = el("div", "had-section");
			sectionNode.style.gridColumn = `span ${span}`;
			sectionNode.style.setProperty("--had-grid", cols);
			for (const card of section.cards) {
				const draw = RENDERERS[card.type];
				if (!draw) continue;
				const cell = el("div", `had-card had-card-${card.type}`);
				cell.style.gridColumn = `span ${Math.min(card.columns ?? cols, cols)}`;
				cell.append(draw(ctx, card));
				sectionNode.append(cell);
			}
			grid.append(sectionNode);
		}
		root.append(grid);

		if (status.status !== "connected") root.append(el("div", "had-status xsmall dimmed", statusText(status)));
		return root;
	}

	window.HADashRenderers = { render, formatState };
}());
