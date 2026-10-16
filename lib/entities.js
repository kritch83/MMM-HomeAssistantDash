/**
 * Applies one `subscribe_entities` event to a map of entity states.
 *
 * HA sends compressed diffs: `a` (added, full state), `c` (changed: `+` holds
 * new values, `-` lists removed attributes) and `r` (removed ids). Short keys:
 * s = state, a = attributes, c = context, lc = last_changed, lu = last_updated
 * (timestamps in seconds). Returns a new map; the input is not modified.
 * @param {object} entities entity_id → {entity_id, state, attributes, last_changed, last_updated}
 * @param {object} event the `event` payload of a subscribe_entities message
 * @returns {object} the updated map
 */
function applyEntityDiff (entities, event) {
	const next = { ...entities };

	for (const [id, s] of Object.entries(event.a || {})) {
		const lastChanged = toIso(s.lc);
		next[id] = {
			entity_id: id,
			state: s.s,
			attributes: s.a || {},
			last_changed: lastChanged,
			last_updated: s.lu ? toIso(s.lu) : lastChanged
		};
	}

	for (const id of event.r || []) {
		delete next[id];
	}

	for (const [id, diff] of Object.entries(event.c || {})) {
		const current = next[id];
		if (!current) continue;
		const updated = { ...current, attributes: { ...current.attributes } };
		const add = diff["+"];
		if (add) {
			if (add.s !== undefined) updated.state = add.s;
			if (add.lc) {
				updated.last_changed = updated.last_updated = toIso(add.lc);
			} else if (add.lu) {
				updated.last_updated = toIso(add.lu);
			}
			if (add.a) Object.assign(updated.attributes, add.a);
		}
		for (const key of diff["-"]?.a || []) {
			delete updated.attributes[key];
		}
		next[id] = updated;
	}

	return next;
}

function toIso (seconds) {
	return new Date(seconds * 1000).toISOString();
}

module.exports = { applyEntityDiff };
