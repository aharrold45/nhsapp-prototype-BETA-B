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
	const key = resolvePostcodeKey(req.query.postcode);
	const clinicIds = postcodeMap[key] || postcodeMap['DEFAULT'] || [];
	const clinicsList = loadClinicsList();

	const clinics = clinicIds.slice(0, 5).map((id, clinicIndex) => {
		const c = clinicsList.find(x => x.id === id) || { id, name: id };
		// If the clinic entry includes its own `times` (from JSON), prefer that.
		const times = (c && c.times) ? c.times : availability.generateTimes(key, id, c.openingHours, clinicIndex);
		return Object.assign({}, c, { times });
	});

	res.render('pages/your-health/view-availability-results', {
		postcode: req.query.postcode || '',
		clinics,
		clinicsJson: JSON.stringify(clinics, null, 2),
		debug: req.query.debug || ''
	});
});

// Full availability for a single clinic (reached from the "See full clinic
// availability" CTA on the results page). Times for the first 5 days match
// the suggested times shown on the results page for the same postcode.
router.get('/pages/your-health/clinic-availability', (req, res) => {
	const key = resolvePostcodeKey(req.query.postcode);
	const clinicId = req.query.clinic;
	const clinicsList = loadClinicsList();
	const clinic = clinicsList.find(x => x.id === clinicId);

	// Unknown clinic - send the user back to the results list rather than
	// rendering an empty page (the path matches a real template, so falling
	// through to auto-routing would render this template with no data).
	if (!clinic) {
		return res.redirect('/pages/your-health/view-availability-results?postcode=' + encodeURIComponent(req.query.postcode || ''));
	}

	const clinicIds = postcodeMap[key] || postcodeMap['DEFAULT'] || [];
	const clinicIndex = clinicIds.indexOf(clinicId);
	const days = availability.generateFullAvailability(key, clinicId, clinic.openingHours, 56, clinicIndex < 0 ? 1 : clinicIndex);

	res.render('pages/your-health/clinic-availability', {
		clinic,
		days,
		daysJson: JSON.stringify(days),
		postcode: req.query.postcode || ''
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
	res.render('pages/your-health/your-appointment', appointmentContext(req));
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
