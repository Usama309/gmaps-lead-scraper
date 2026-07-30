/**
 * Every scoring weight. Tune here and nowhere else.
 *
 * The operator sells website design and online booking systems, so a good lead
 * is a real, reachable, solvent business with a weak or absent web presence.
 *
 * Components are independent by design: each answers a different question and no
 * signal may feed two of them. Scoring both "Wix" and "old Wix" would count one
 * weakness twice, so platform age is deliberately not scored at all.
 */
export const SCORING = Object.freeze({
  websiteGap: Object.freeze({
    none: 40,
    facebook: 38,
    dead: 35,
    builder: 30,
    wordpress: 20,
    unknown: 12,
    modern: 5,
  }),

  /** websiteTech value to its scoring band. */
  techBand: Object.freeze({
    none: 'none',
    facebook: 'facebook',
    dead: 'dead',
    wix: 'builder',
    weebly: 'builder',
    godaddy: 'builder',
    squarespace: 'builder',
    wordpress: 'wordpress',
    next: 'modern',
    react: 'modern',
    webflow: 'modern',
    shopify: 'modern',
    unknown: 'unknown',
  }),

  mobileGap: Object.freeze({
    noViewport: 20,
    fixedWidth: 12,
    responsive: 0,
  }),

  bookingGap: Object.freeze({
    appointmentMissing: 20,
    appointmentPresent: 0,
    nonAppointment: 6,
  }),

  viability: Object.freeze({
    // [minReviews, maxReviews, points]
    bands: Object.freeze([
      Object.freeze([10, 300, 20]),
      Object.freeze([301, 1000, 12]),
      Object.freeze([1001, Infinity, 4]),
      Object.freeze([0, 9, 8]),
    ]),
    unknown: 12,
  }),

  modifiers: Object.freeze({
    unreachable: 0.6,
    dormant: 0.7,
    dormantAfterDays: 365,
  }),

  /** Categories where an online booking gap is a real sales opening. */
  appointmentCategories: Object.freeze([
    'dentist', 'orthodontist', 'dermatologist', 'medical clinic', 'clinic',
    'physiotherapist', 'chiropractor', 'veterinarian', 'eye care centre',
    'beauty salon', 'hair salon', 'nail salon', 'barber shop', 'spa',
    'massage therapist', 'tattoo shop', 'gym', 'fitness centre', 'yoga studio',
    'photographer', 'auto repair shop', 'driving school', 'tutoring service',
    'dance school', 'pet groomer', 'nutritionist', 'therapist',
  ]),
});
