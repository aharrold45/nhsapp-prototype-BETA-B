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
	const m = (slot || '').match(/(\d+):(\d+)\s*(am|pm)/i);
	if (!m) return 0;
	let h = parseInt(m[1]);
	const p = m[3].toLowerCase();
	if (p === 'pm' && h !== 12) h += 12;
	if (p === 'am' && h === 12) h = 0;
	return h;
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

// When filters are active: pulls from full 56-day availability and returns
// the first 5 matching slots as {dateLabel, slots[]} pages.
function filteredSlotsFromFull(days, filterDays, filterTimes) {
	const result = [];
	let total = 0;
	for (const day of days) {
		if (total >= 5) break;
		if (!day.hasSlots) continue;
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

// Arrange test — redirect Start button based on chosen test type
router.post('/pages/your-health/arrange-test', (req, res) => {
	if (req.body['test-type'] === 'clinic') {
		res.redirect('/pages/your-health/view-availability');
	} else {
		res.redirect('/pages/your-health/arrange-test');
	}
});

// View availability search results
router.get('/pages/your-health/view-availability-results', (req, res) => {
	const postcode = req.query.postcode || '';
	const key = resolvePostcodeKey(postcode);
	const clinicIds = postcodeMap[key] || postcodeMap['DEFAULT'] || [];
	const clinicsList = loadClinicsList();
	const filterDays = [].concat(req.query['filter-days'] || []).filter(v => v !== '_unchecked');
	const filterTimes = [].concat(req.query['filter-times'] || []).filter(v => v !== '_unchecked');
	const filterCount = filterDays.length + filterTimes.length;

	const clinics = clinicIds.slice(0, 5).map((id, clinicIndex) => {
		const c = clinicsList.find(x => x.id === id) || { id, name: id };
		let times;
		if (filterCount > 0) {
			const fullDays = availability.generateFullAvailability(key, id, c.openingHours, 56, clinicIndex);
			times = filteredSlotsFromFull(fullDays, filterDays, filterTimes);
		} else {
			times = (c && c.times) ? c.times : availability.generateTimes(key, id, c.openingHours, clinicIndex);
		}
		const clinicUrl = buildUrl('/pages/your-health/clinic-availability', {
			clinic: id, postcode, 'filter-days': filterDays, 'filter-times': filterTimes
		});
		return Object.assign({}, c, { times, clinicUrl });
	});

	const filterPageUrl = buildUrl('/pages/your-health/clinic-availability-filter', {
		postcode, 'filter-days': filterDays, 'filter-times': filterTimes, returnTo: 'results'
	});
	const clearFiltersUrl = buildUrl('/pages/your-health/view-availability-results', { postcode });

	res.render('pages/your-health/view-availability-results', {
		postcode,
		clinics,
		clinicsJson: JSON.stringify(clinics, null, 2),
		debug: req.query.debug || '',
		filterCount,
		filterPageUrl,
		clearFiltersUrl
	});
});

// Filter page — GET renders the form, POST applies filters and redirects.
router.get('/pages/your-health/clinic-availability-filter', (req, res) => {
	const clinicId = req.query.clinic || '';
	const postcode = req.query.postcode || '';
	const filterDays = [].concat(req.query['filter-days'] || []).filter(v => v !== '_unchecked');
	const filterTimes = [].concat(req.query['filter-times'] || []).filter(v => v !== '_unchecked');
	const returnTo = req.query.returnTo || '';
	const backUrl = returnTo === 'clinic'
		? buildUrl('/pages/your-health/clinic-availability', { clinic: clinicId, postcode, 'filter-days': filterDays, 'filter-times': filterTimes })
		: buildUrl('/pages/your-health/view-availability-results', { postcode, 'filter-days': filterDays, 'filter-times': filterTimes });
	res.render('pages/your-health/clinic-availability-filter', {
		clinic: clinicId, postcode, filterDays, filterTimes, backUrl, returnTo
	});
});

router.post('/pages/your-health/clinic-availability-filter', (req, res) => {
	const clinicId = req.body.clinic || '';
	const postcode = req.body.postcode || '';
	const returnTo = req.body.returnTo || '';
	const filterDays = [].concat(req.body['filter-days'] || []).filter(v => v !== '_unchecked');
	const filterTimes = [].concat(req.body['filter-times'] || []).filter(v => v !== '_unchecked');
	if (returnTo === 'clinic') {
		res.redirect(buildUrl('/pages/your-health/clinic-availability', {
			clinic: clinicId, postcode, 'filter-days': filterDays, 'filter-times': filterTimes
		}));
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

	const filterDays = [].concat(req.query['filter-days'] || []).filter(v => v !== '_unchecked');
	const filterTimes = [].concat(req.query['filter-times'] || []).filter(v => v !== '_unchecked');
	const filterCount = filterDays.length + filterTimes.length;

	const filterPageUrl = buildUrl('/pages/your-health/clinic-availability-filter', {
		clinic: clinicId, postcode, 'filter-days': filterDays, 'filter-times': filterTimes, returnTo: 'clinic'
	});
	const clearFiltersUrl = buildUrl('/pages/your-health/clinic-availability', { clinic: clinicId, postcode });
	const backUrl = buildUrl('/pages/your-health/view-availability-results', {
		postcode, 'filter-days': filterDays, 'filter-times': filterTimes
	});

	res.render('pages/your-health/clinic-availability', {
		clinic,
		days,
		daysJson: JSON.stringify(days),
		postcode,
		filterCount,
		filterPageUrl,
		clearFiltersUrl,
		backUrl,
		activeFiltersJson: JSON.stringify({ days: filterDays, times: filterTimes })
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

	const daytime = [...(day.morning || []), ...(day.afternoon || [])];
	const dtCount = parseInt(req.query.count, 10);
	const slots = [
		...(dtCount > 0 ? daytime.slice(0, dtCount) : daytime),
		...(day.evening || [])
	];

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
	}
	const returnTo = req.headers.referer || '/';
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

	res.render('pages/your-health/confirm', ctx);
});

// Appointment detail page, reached from the "View appointment" button on the
// confirmation page. Shows the same details plus tasks and other actions.
router.get('/pages/your-health/your-appointment', (req, res) => {
	const ctx = appointmentContext(req);
	if (!ctx.clinic || !ctx.clinic.id) {
		return res.redirect('/pages/hospital-and-specialist-appointments');
	}
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
