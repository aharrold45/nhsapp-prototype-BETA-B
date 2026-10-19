// External dependencies
const express = require('express');

const router = express.Router();

// Add your routes here - above the module.exports line

const fs = require('fs');
const path = require('path');
const postcodeMap = require('./data/postcode-map.json');
const availability = require('../lib/availability');

// Resolve a raw postcode to a key in postcode-map.json, trying progressively
// shorter prefixes and falling back to DEFAULT. Shared by both availability
// routes so the same postcode always seeds the same (matching) times.
function resolvePostcodeKey(rawPostcode) {
	const raw = (rawPostcode || '').toUpperCase().replace(/\s+/g, '');
	for (let len = raw.length; len >= 2; len--) {
		const key = raw.slice(0, len);
		if (postcodeMap[key]) return key;
	}
	return 'DEFAULT';
}

// Read clinics.json fresh each call so edits are reflected without a restart.
// Normalises the shape: supports either an array or an object with a `clinics` map.
function loadClinicsList() {
	let clinicsData = {};
	try {
		clinicsData = JSON.parse(
			fs.readFileSync(path.join(__dirname, 'data', 'clinics.json'), 'utf8')
		);
	} catch (e) {
		clinicsData = {};
	}
	if (Array.isArray(clinicsData)) return clinicsData;
	if (clinicsData && clinicsData.clinics) {
		if (Array.isArray(clinicsData.clinics)) return clinicsData.clinics;
		if (typeof clinicsData.clinics === 'object') return Object.values(clinicsData.clinics);
	}
	return [];
}

// Builds a URL with query params, appending repeated keys for arrays.
function buildUrl(base, obj) {
	const parts = [];
	Object.entries(obj).forEach(([k, v]) => {
		[].concat(v).filter(x => x !== '' && x !== undefined).forEach(val => {
			parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(val));
		});
	});
	return base + (parts.length ? '?' + parts.join('&') : '');
}

function parseSlotHour(slot) {
	const s = (slot || '').toLowerCase().trim();
	if (s === 'midnight') return 0;
	if (s === 'midday') return 12;
	const m = s.match(/^(\d{1,2})(?::\d{2})?\s*(am|pm)$/);
	if (!m) return 0;
	let h = parseInt(m[1]);
	const p = m[2];
	if (p === 'pm' && h !== 12) h += 12;
	if (p === 'am' && h === 12) h = 0;
	return h;
}

// Minutes after midnight for a slot label such as "9:30am", "midday"
function slotMinutes(slot) {
	const s = (slot || '').toLowerCase().trim();
	if (s === 'midnight') return 0;
	if (s === 'midday') return 720;
	const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
	if (!m) return 0;
	return parseSlotHour(s) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
}

function slotMatchesTimeFilter(slot, filterTimes) {
	if (!filterTimes.length) return true;
	const h = parseSlotHour(slot);
	return filterTimes.some(f => {
		if (f === 'before9') return h < 9;
		if (f === 'morning') return h >= 9 && h < 12;
		if (f === 'early-afternoon') return h >= 12 && h < 14;
		if (f === 'late-afternoon') return h >= 14 && h < 17;
		if (f === 'evening') return h >= 17;
		return false;
	});
}

// Server-side copy of daytimeCount() in clinic-availability.html: how many
// morning/afternoon slots are shown for a day (must stay in sync).
function daytimeSlotCount(day) {
	let h = 0;
	const iso = day.iso || '';
	for (let i = 0; i < iso.length; i++) {
		h = (Math.imul(31, h) + iso.charCodeAt(i)) >>> 0;
	}
	const rng = (h % 10000) / 10000;
	const daytime = (day.morning || []).length + (day.afternoon || []).length;
	const idx = typeof day.index !== 'undefined' ? day.index : 7;
	let min, max;
	if (idx <= 2) { min = 1; max = 3; }
	else if (idx <= 5) { min = 2; max = 5; }
	else if (idx <= 14) { min = 3; max = 8; }
	else { min = 4; max = daytime; }
	max = Math.min(max, daytime);
	min = Math.min(min, max);
	return min + Math.floor(rng * (max - min + 1));
}

// Number of slots listed on select-time for a given day, with or without
// time filters (matches what the user sees on that page).
function slotCountForDay(day, filterTimes) {
	const evening = day.evening || [];
	if (filterTimes.length) {
		return [...(day.morning || []), ...(day.afternoon || []), ...evening]
			.filter(sl => slotMatchesTimeFilter(sl.start, filterTimes)).length;
	}
	return daytimeSlotCount(day) + evening.length;
}

// "dd/mm/yyyy" (also d/m/yyyy, - or . separators) -> "yyyy-mm-dd", or '' if invalid
function parseFilterDate(str) {
	const m = (str || '').trim().match(/^(\d{1,2})[\/.\-\s](\d{1,2})[\/.\-\s](\d{4})$/);
	if (!m) return '';
	const [d, mo, y] = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
	const dt = new Date(y, mo - 1, d);
	if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
	return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// Validates the Day / Month / Year boxes on the filter page. Returns an error
// message and the boxes to highlight, or null when the date is valid (or blank).
function validateFilterDate(day, month, year) {
	const d = (day || '').trim(), m = (month || '').trim(), y = (year || '').trim();
	if (!d && !m && !y) return null; // blank is allowed: no date filter
	const missing = [['day', d], ['month', m], ['year', y]].filter(f => !f[1]).map(f => f[0]);
	if (missing.length) {
		return { message: 'Date must include a ' + missing.join(' and a '), fields: missing };
	}
	if (!/^\d+$/.test(d) || +d < 1 || +d > 31) return { message: 'Day must be between 1 and 31', fields: ['day'] };
	if (!/^\d+$/.test(m) || +m < 1 || +m > 12) return { message: 'Month must be between 1 and 12', fields: ['month'] };
	const thisYear = new Date().getFullYear();
	if (!/^\d{4}$/.test(y) || +y < thisYear || +y > thisYear + 1) {
		return { message: 'Year must be ' + thisYear + ' or ' + (thisYear + 1), fields: ['year'] };
	}
	const daysInMonth = new Date(+y, +m, 0).getDate();
	if (+d > daysInMonth) {
		const monthName = ['January','February','March','April','May','June','July','August','September','October','November','December'][+m - 1];
		return { message: 'Day must be between 1 and ' + daysInMonth + ' for ' + monthName + ' ' + y, fields: ['day'] };
	}
	return null;
}

function isoToFilterDate(iso) {
	const m = (iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
	return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
}

// The shared Day-tab filter state kept in the session
function getDayFilters(req) {
	const f = req.session.dayFilters || {};
	return { days: f.days || [], times: f.times || [], date: f.date || '', day: f.day || '', month: f.month || '' };
}

// Specific day tab: validates the Day / Month boxes. The year is implied: the
// next time that day and month come round (this year or next). Returns
// { error: {message, fields} } or { iso } (blank gives { iso: '' }).
function resolveSpecificDate(day, month) {
	const d = (day || '').trim(), m = (month || '').trim();
	if (!d && !m) return { iso: '' };
	const missing = [['day', d], ['month', m]].filter(f => !f[1]).map(f => f[0]);
	if (missing.length) return { error: { message: 'Date must include a ' + missing[0], fields: missing } };
	if (!/^\d+$/.test(d) || +d < 1 || +d > 31) return { error: { message: 'Day must be between 1 and 31', fields: ['day'] } };
	if (!/^\d+$/.test(m) || +m < 1 || +m > 12) return { error: { message: 'Month must be between 1 and 12', fields: ['month'] } };
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	let year = today.getFullYear();
	if (new Date(year, +m - 1, Math.min(+d, new Date(year, +m, 0).getDate())) < today) year += 1;
	const daysInMonth = new Date(year, +m, 0).getDate();
	if (+d > daysInMonth) {
		const monthName = ['January','February','March','April','May','June','July','August','September','October','November','December'][+m - 1];
		return { error: { message: 'Day must be between 1 and ' + daysInMonth + ' for ' + monthName, fields: ['day'] } };
	}
	return { iso: year + '-' + String(+m).padStart(2, '0') + '-' + String(+d).padStart(2, '0') };
}

// View-model for the Specific day search form (shared by results + clinic pages).
// An error from the last submit is flashed through the session.
function specificDayForm(req, filters) {
	const flash = req.session.specificDayError;
	delete req.session.specificDayError;
	return {
		days: flash ? [] : filters.days,
		day: flash ? flash.values.day : filters.day,
		month: flash ? flash.values.month : filters.month,
		error: flash ? flash.error : null,
		dateChecked: flash ? true : !!filters.date,
		// Applied search: shown as a summary with "Edit day" instead of the form
		hasSearch: !!(filters.date || filters.days.length),
		hasDate: !!filters.date,
		summary: describeSpecificDay(filters)
	};
}

// "Wednesday 5th August" for a date, or "Monday, Wednesday and Friday" for days
function describeSpecificDay(filters) {
	if (filters.date) {
		const [y, m, d] = filters.date.split('-').map(Number);
		const dt = new Date(y, m - 1, d);
		const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
		const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
		const v = d % 100;
		const ord = d + (['th','st','nd','rd'][(v - 20) % 10] || ['th','st','nd','rd'][v] || 'th');
		return dayNames[dt.getDay()] + ' ' + ord + ' ' + months[m - 1];
	}
	const days = filters.days;
	return days.length > 1 ? days.slice(0, -1).join(', ') + ' and ' + days[days.length - 1] : (days[0] || '');
}

// When filters are active: pulls from full 56-day availability and returns
// the first 5 matching slots as {dateLabel, slots[]} pages.
function filteredSlotsFromFull(days, filterDays, filterTimes, filterDate) {
	const result = [];
	let total = 0;
	for (const day of days) {
		if (total >= 5) break;
		if (!day.hasSlots) continue;
		if (filterDate && day.iso !== filterDate) continue;
		if (filterDays.length && !filterDays.includes(day.dateLabel.split(' ')[0])) continue;
		const allSlots = [...day.morning, ...day.afternoon, ...day.evening].map(s => s.start);
		const matched = allSlots.filter(s => slotMatchesTimeFilter(s, filterTimes));
		if (!matched.length) continue;
		const take = matched.slice(0, 5 - total);
		result.push({ dateLabel: day.dateLabel, slots: take });
		total += take.length;
	}
	return result;
}

// Render the P9 home page at the site root
router.get('/', (req, res) => {
	res.render('pages/home-p9');
});

// Appointment invitations — pass expiry date 3 weeks from today
router.get('/pages/your-health/appointment-invitations', (_req, res) => {
	const expiry = new Date();
	expiry.setDate(expiry.getDate() + 21);
	const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
	const expiryDate = `${expiry.getDate()} ${months[expiry.getMonth()]} ${expiry.getFullYear()}`;
	res.render('pages/your-health/appointment-invitations', { expiryDate });
});

// Arrange test — redirect Start button based on chosen test type
router.post('/pages/your-health/arrange-test', (req, res) => {
	if (req.body['test-type'] === 'clinic') {
		res.redirect('/pages/your-health/view-availability');
	} else {
		res.redirect('/pages/your-health/home-test/start');
	}
});

// Home test — comfortable-answer branch: yes → mobile-phone, no → back to arrange-test
router.post('/pages/your-health/home-test/comfortable-answer', (req, res) => {
	if (req.body.comfortable === 'Yes') {
		res.redirect('/pages/your-health/home-test/mobile-phone');
	} else {
		res.redirect('/pages/your-health/arrange-test');
	}
});

// Home test confirmation — store order in session so book-an-appointment card updates
router.post('/pages/your-health/home-test/confirmation', (req, res) => {
	if (req.session && req.session.data) {
		req.session.data.homeTestOrdered = true;
	}
	res.redirect('/pages/your-health/home-test/confirmation');
});

// View availability search results
router.get('/pages/your-health/view-availability-results', (req, res) => {
	const postcode = req.query.postcode || '';
	const key = resolvePostcodeKey(postcode);
	const clinicIds = postcodeMap[key] || postcodeMap['DEFAULT'] || [];
	const clinicsList = loadClinicsList();
	// Day filters (set on the filter page) apply to both tabs. They are kept in
	// the session so they stay until the user removes them.
	const view = req.query.view === 'earliest' ? 'earliest' : 'closest';
	if (req.query.clearFilters) delete req.session.dayFilters;
	const dayFilters = getDayFilters(req);
	const filterDays = dayFilters.days;
	const filterTimes = dayFilters.times;
	const filterDate = dayFilters.date;
	const filterCount = filterDays.length + filterTimes.length + (filterDate ? 1 : 0);

	const clinics = clinicIds.slice(0, 5).map((id, clinicIndex) => {
		const c = clinicsList.find(x => x.id === id) || { id, name: id };
		const fullDays = availability.generateFullAvailability(key, id, c.openingHours, 56, clinicIndex);
		const times = filteredSlotsFromFull(fullDays, filterDays, filterTimes, filterDate);
		const clinicUrl = buildUrl('/pages/your-health/clinic-availability', {
			clinic: id, postcode, view: view === 'closest' ? '' : view
		});
		const firstDay = times.length ? fullDays.find(d => d.dateLabel === times[0].dateLabel) : null;
		const firstDaySlots = firstDay ? slotCountForDay(firstDay, filterTimes) : 0;
		// Sort key for the "Earliest time" tab: first date, then earliest slot that day
		let earliestKey = Infinity;
		if (firstDay) {
			const mins = [...firstDay.morning, ...firstDay.afternoon, ...firstDay.evening]
				.filter(sl => slotMatchesTimeFilter(sl.start, filterTimes))
				.map(sl => slotMinutes(sl.start));
			earliestKey = new Date(firstDay.iso).getTime() / 60000 + (mins.length ? Math.min(...mins) : 0);
		}
		return Object.assign({}, c, { times, clinicUrl, firstDaySlots, earliestKey });
	}).filter(c => filterCount === 0 || c.times.length > 0);

	// Tabs: closest (default, current order) and earliest appointment
	if (view === 'earliest') {
		clinics.sort((a, b) => a.earliestKey - b.earliestKey);
	}
	const tabUrl = v => buildUrl('/pages/your-health/view-availability-results', {
		postcode, view: v === 'closest' ? '' : v
	});
	const tabs = [
		{ id: 'closest', label: 'Closest clinic' },
		{ id: 'earliest', label: 'Earliest appointment' }
	].map(t => Object.assign(t, { url: tabUrl(t.id), active: t.id === view }));
	const filterUrl = buildUrl('/pages/your-health/clinic-availability-filter', {
		postcode, returnTo: 'results', view: view === 'closest' ? '' : view
	});

	res.render('pages/your-health/view-availability-results', {
		postcode,
		clinics,
		view,
		viewTabs: tabs,
		filterUrl,
		filterDays,
		clearFiltersUrl: buildUrl('/pages/your-health/view-availability-results', {
			postcode, view: view === 'closest' ? '' : view, clearFilters: 1
		}),
		clinicsJson: JSON.stringify(clinics, null, 2),
		debug: req.query.debug || '',
		filterCount
	});
});

// Specific day tab search (results + clinic pages). Saves the search in the
// session (shared by both pages) and goes back to the page it came from.
router.post('/pages/your-health/specific-day', (req, res) => {
	const returnTo = req.body.returnTo === 'clinic' ? 'clinic' : 'results';
	const postcode = req.body.postcode || '';
	const clinicId = req.body.clinic || '';
	const view = ['earliest', 'day'].includes(req.body.view) ? req.body.view : '';
	const days = [].concat(req.body['filter-days'] || []).filter(v => v !== '_unchecked');
	const back = () => returnTo === 'clinic'
		? buildUrl('/pages/your-health/clinic-availability', { clinic: clinicId, postcode, view })
		: buildUrl('/pages/your-health/view-availability-results', { postcode, view: 'day' });

	let iso = '';
	let dayVal = '', monthVal = '';
	if (req.body['filter-date-toggle']) {
		dayVal = (req.body['sd-day'] || '').trim();
		monthVal = (req.body['sd-month'] || '').trim();
		const result = resolveSpecificDate(dayVal, monthVal);
		if (result.error) {
			req.session.specificDayError = { error: result.error, values: { day: dayVal, month: monthVal } };
			return res.redirect(back());
		}
		iso = result.iso;
	}
	if (iso) {
		req.session.dayFilters = { days: [], times: [], date: iso, day: dayVal, month: monthVal };
	} else if (days.length) {
		req.session.dayFilters = { days, times: [], date: '', day: '', month: '' };
	} else {
		delete req.session.dayFilters;
	}
	res.redirect(back());
});

// Filter page — GET renders the form, POST applies filters and redirects.
router.get('/pages/your-health/clinic-availability-filter', (req, res) => {
	const clinicId = req.query.clinic || '';
	const postcode = req.query.postcode || '';
	const returnTo = req.query.returnTo || '';
	const saved = getDayFilters(req);
	const filterDays = returnTo === 'results' ? saved.days : [].concat(req.query['filter-days'] || []).filter(v => v !== '_unchecked');
	const filterTimes = [].concat(req.query['filter-times'] || []).filter(v => v !== '_unchecked');
	const filterDate = '';
	res.render('pages/your-health/clinic-availability-filter', {
		clinic: clinicId, postcode, filterDays, filterTimes, filterDate,
		backUrl: filterBackUrl(returnTo, clinicId, postcode, req.query.view, filterDays, filterTimes),
		returnTo, view: req.query.view || ''
	});
});

function filterBackUrl(returnTo, clinicId, postcode, view, filterDays, filterTimes) {
	return returnTo === 'clinic'
		? buildUrl('/pages/your-health/clinic-availability', { clinic: clinicId, postcode, view })
		: buildUrl('/pages/your-health/view-availability-results', { postcode, view: returnTo === 'results' ? view : '' });
}

router.post('/pages/your-health/clinic-availability-filter', (req, res) => {
	const clinicId = req.body.clinic || '';
	const postcode = req.body.postcode || '';
	const returnTo = req.body.returnTo || '';
	const filterDays = [].concat(req.body['filter-days'] || []).filter(v => v !== '_unchecked');
	const filterTimes = [].concat(req.body['filter-times'] || []).filter(v => v !== '_unchecked');
	const filterDate = '';
	// Day-tab filters are shared between the results page and clinic page
	if (returnTo === 'clinic' || returnTo === 'results') {
		if (filterDate) {
			req.session.dayFilters = { days: [], times: [], date: filterDate };
		} else if (filterDays.length || filterTimes.length) {
			req.session.dayFilters = { days: filterDays, times: filterTimes, date: '' };
		} else {
			delete req.session.dayFilters;
		}
	}
	if (returnTo === 'clinic') {
		res.redirect(buildUrl('/pages/your-health/clinic-availability', {
			clinic: clinicId, postcode, view: req.body.view
		}));
	} else if (returnTo === 'results') {
		res.redirect(buildUrl('/pages/your-health/view-availability-results', { postcode, view: req.body.view }));
	} else {
		res.redirect(buildUrl('/pages/your-health/view-availability-results', {
			postcode, 'filter-days': filterDays, 'filter-times': filterTimes
		}));
	}
});

// Full availability for a single clinic (reached from the "See full clinic
// availability" CTA on the results page). Times for the first 5 days match
// the suggested times shown on the results page for the same postcode.
router.get('/pages/your-health/clinic-availability', (req, res) => {
	const postcode = req.query.postcode || '';
	const key = resolvePostcodeKey(postcode);
	const clinicId = req.query.clinic;
	const clinicsList = loadClinicsList();
	const clinic = clinicsList.find(x => x.id === clinicId);

	// Unknown clinic - send the user back to the results list rather than
	// rendering an empty page (the path matches a real template, so falling
	// through to auto-routing would render this template with no data).
	if (!clinic) {
		return res.redirect('/pages/your-health/view-availability-results?postcode=' + encodeURIComponent(postcode));
	}

	const clinicIds = postcodeMap[key] || postcodeMap['DEFAULT'] || [];
	const clinicIndex = clinicIds.indexOf(clinicId);
	const days = availability.generateFullAvailability(key, clinicId, clinic.openingHours, 56, clinicIndex < 0 ? 1 : clinicIndex);

	// Filters are the Day-tab filters shared with the results page (session)
	if (req.query.clearFilters) delete req.session.dayFilters;
	const dayFilters = getDayFilters(req);
	const filterDays = dayFilters.days;
	const filterTimes = dayFilters.times;
	const filterDate = dayFilters.date;
	const filterCount = filterDays.length + filterTimes.length + (filterDate ? 1 : 0);
	const view = req.query.view === 'earliest' ? 'earliest' : '';
	const filterUrl = buildUrl('/pages/your-health/clinic-availability-filter', { clinic: clinicId, postcode, returnTo: 'clinic', view });
	const clearFiltersUrl = buildUrl('/pages/your-health/clinic-availability', { clinic: clinicId, postcode, view, clearFilters: 1 });
	const backUrl = buildUrl('/pages/your-health/view-availability-results', { postcode, view });

	res.render('pages/your-health/clinic-availability', {
		clinic,
		days,
		daysJson: JSON.stringify(days),
		postcode,
		filterCount,
		backUrl,
		view,
		filterDays,
		filterUrl,
		clearFiltersUrl,
		activeFiltersJson: JSON.stringify({ days: filterDays, times: filterTimes, date: filterDate })
	});
});

// Time slot selection for a specific day at a clinic (reached from a date
// card on the clinic-availability page).
router.get('/pages/your-health/select-time', (req, res) => {
	const key = resolvePostcodeKey(req.query.postcode);
	const clinicId = req.query.clinic;
	const iso = req.query.iso;
	const clinicsList = loadClinicsList();
	const clinic = clinicsList.find(x => x.id === clinicId);

	if (!clinic) {
		return res.redirect('/pages/your-health/view-availability-results?postcode=' + encodeURIComponent(req.query.postcode || ''));
	}

	const clinicIds = postcodeMap[key] || postcodeMap['DEFAULT'] || [];
	const clinicIndex = clinicIds.indexOf(clinicId);
	const days = availability.generateFullAvailability(key, clinicId, clinic.openingHours, 56, clinicIndex < 0 ? 1 : clinicIndex);
	const day = days.find(d => d.iso === iso);

	if (!day || !day.hasSlots) {
		return res.redirect('/pages/your-health/clinic-availability?clinic=' + encodeURIComponent(clinicId) + '&postcode=' + encodeURIComponent(req.query.postcode || ''));
	}

	const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
	const d = new Date(day.iso);
	const n = d.getDate();
	const ordSuffixes = ['th','st','nd','rd'];
	const v = n % 100;
	const ord = n + (ordSuffixes[(v - 20) % 10] || ordSuffixes[v] || ordSuffixes[0]);
	const dateHeading = dayNames[d.getDay()] + ' ' + ord + ' ' + day.month;

	const filterTimes = [].concat(req.query['filter-times'] || []).filter(v => v !== '_unchecked');
	const daytime = [...(day.morning || []), ...(day.afternoon || [])];
	const dtCount = parseInt(req.query.count, 10);
	let slots = [
		...(dtCount > 0 ? daytime.slice(0, dtCount) : daytime),
		...(day.evening || [])
	];
	if (filterTimes.length) {
		slots = slots.filter(s => slotMatchesTimeFilter(s.start, filterTimes));
	}

	res.render('pages/your-health/select-time', {
		clinic,
		day,
		slots,
		dateHeading,
		postcode: req.query.postcode || ''
	});
});

// Build the shared appointment context (clinic record plus the chosen
// date/time) from the request query. Used by the check, confirm and
// appointment pages so they all show the same values.
function appointmentContext(req) {
	const clinicsList = loadClinicsList();
	return {
		clinic: clinicsList.find(x => x.id === req.query.clinic) || {},
		postcode: req.query.postcode || '',
		date: req.query.date || '',
		time: req.query.time || ''
	};
}

// Flatten an appointment context into the record stored in the session and
// rendered on the appointments lists.
function appointmentRecord(ctx) {
	return {
		clinicId: ctx.clinic.id,
		clinicName: ctx.clinic.name,
		address: ctx.clinic.address,
		postcode: ctx.postcode,
		date: ctx.date,
		time: ctx.time,
		walkIn: ctx.clinic.type === 'walk-in'
	};
}

// Generic reset — clears prototype session state and returns to the referring page.
// Triggered by the "App help" button on any page after a booking is confirmed.
router.get('/reset', (req, res) => {
	if (req.session && req.session.data) {
		delete req.session.data.bookedAppointment;
		delete req.session.data.cancelledAppointment;
		delete req.session.data.reschedulingFrom;
		delete req.session.data.homeTestOrdered;
	}
	// Specific day search (shared by the results and clinic pages)
	delete req.session.dayFilters;
	delete req.session.specificDayError;
	let returnTo = req.headers.referer || '/';
	// Back to the default tab on the clinic results / clinic availability pages
	try {
		const url = new URL(returnTo);
		if (url.pathname === '/pages/your-health/view-availability-results' || url.pathname === '/pages/your-health/clinic-availability') {
			url.searchParams.delete('view');
			url.searchParams.delete('show');
			returnTo = url.pathname + url.search;
		}
	} catch (e) { /* not a full URL - use it as is */ }
	res.redirect(returnTo);
});

// Resets dynamically booked/cancelled appointment session data and returns to
// the hospital appointments list — triggered by "App help" on that page.
router.get('/pages/hospital-and-specialist-appointments/reset', (req, res) => {
	if (req.session && req.session.data) {
		delete req.session.data.bookedAppointment;
		delete req.session.data.cancelledAppointment;
		delete req.session.data.reschedulingFrom;
	}
	res.redirect('/pages/hospital-and-specialist-appointments');
});

// Check your answers page for a chosen appointment slot. The clinic name and
// address are looked up from clinics.json; the date and time come from the
// slot button the user selected on the availability page.
router.get('/pages/your-health/check', (req, res) => {
	res.render('pages/your-health/check', appointmentContext(req));
});

// Interstitial "confirming" page shown for 4 seconds between the check page
// and the confirmation page, to simulate a real booking request in flight.
router.get('/pages/your-health/confirming', (req, res) => {
	res.render('pages/your-health/confirming', appointmentContext(req));
});

// Appointment confirmation page, reached from the check page's
// "Confirm appointment" button. Shows the booked details and persists the
// booking in the session so it appears under upcoming appointments.
router.get('/pages/your-health/confirm', (req, res) => {
	const ctx = appointmentContext(req);

	if (req.session && req.session.data && ctx.clinic && ctx.clinic.id) {
		// If this confirmation completes a reschedule, move the original
		// appointment to past (cancelled) before recording the new booking.
		if (req.session.data.reschedulingFrom) {
			req.session.data.cancelledAppointment = req.session.data.reschedulingFrom;
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete req.session.data.reschedulingFrom;
		}
		req.session.data.bookedAppointment = appointmentRecord(ctx);
	}

	const expiry = new Date();
	expiry.setDate(expiry.getDate() + 21);
	const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
	ctx.expiryDate = `${expiry.getDate()} ${months[expiry.getMonth()]} ${expiry.getFullYear()}`;

	res.render('pages/your-health/confirm', ctx);
});

// Appointment detail page, reached from the "View appointment" button on the
// confirmation page. Shows the same details plus tasks and other actions.
router.get('/pages/your-health/your-appointment', (req, res) => {
	const ctx = appointmentContext(req);
	if (!ctx.clinic || !ctx.clinic.id) {
		return res.redirect('/pages/hospital-and-specialist-appointments');
	}
	const expiry = new Date();
	expiry.setDate(expiry.getDate() + 21);
	const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
	ctx.expiryDate = `${expiry.getDate()} ${months[expiry.getMonth()]} ${expiry.getFullYear()}`;
	res.render('pages/your-health/your-appointment', ctx);
});

// Edit appointment page, reached from "Ask to reschedule appointment". The
// clinic is retained (used by the "rebook with same clinic" link) but not
// displayed.
router.get('/pages/your-health/edit-appointment', (req, res) => {
	const ctx = appointmentContext(req);

	// Remember the appointment being rescheduled so it can be moved to past
	// (cancelled) once the new appointment is confirmed.
	if (req.session && req.session.data && ctx.clinic && ctx.clinic.id) {
		req.session.data.reschedulingFrom = appointmentRecord(ctx);
	}

	res.render('pages/your-health/edit-appointment', ctx);
});

// Cancel appointment page, reached from "Ask to cancel appointment". Shows the
// current appointment details and a reason form.
router.get('/pages/your-health/cancel-appointment', (req, res) => {
	res.render('pages/your-health/cancel-appointment', appointmentContext(req));
});

// Sensitive information interstitial shown before test results. The "Continue"
// destination is passed in via ?next= so the same page can lead to a single
// result or the full tests-and-results list depending on entry point.
router.get('/pages/your-health/result-sensitive-information', (req, res) => {
	res.render('pages/your-health/result-sensitive-information', {
		next: req.query.next || '/pages/your-health/test-result'
	});
});

// Cancellation confirmation, reached from the "Cancel appointment" button.
// Records the cancellation in the session (so it moves from upcoming to past
// appointments) and removes the upcoming booking.
router.get('/pages/your-health/appointment-cancelled', (req, res) => {
	const ctx = appointmentContext(req);

	if (req.session && req.session.data && ctx.clinic && ctx.clinic.id) {
		req.session.data.cancelledAppointment = appointmentRecord(ctx);
		// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
		delete req.session.data.bookedAppointment;
		// A direct cancellation is not a reschedule.
		// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
		delete req.session.data.reschedulingFrom;
	}

	res.render('pages/your-health/appointment-cancelled', ctx);
});

module.exports = router;
