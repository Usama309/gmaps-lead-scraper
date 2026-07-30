import { SCORING } from '../core/scoring-config.js';

function isAppointmentCategory(categories) {
  return categories.some((c) => {
    const norm = String(c).toLowerCase().trim();
    return SCORING.appointmentCategories.some((a) => norm.includes(a) || a.includes(norm));
  });
}

function websiteGap(lead, reasons) {
  const tech = lead.websiteTech ?? 'unknown';
  const band = SCORING.techBand[tech] ?? 'unknown';
  const points = SCORING.websiteGap[band];

  const label = {
    none: 'No website',
    facebook: 'Facebook page as website',
    dead: 'Website URL is dead',
    builder: `${tech} builder site`,
    wordpress: 'WordPress site',
    unknown: 'website platform unrecognised',
    modern: 'modern custom build',
  }[band];

  if (label) reasons.push(label);
  return points;
}

function mobileGap(lead, reasons) {
  // A business with no website has no mobile problem to sell against; the
  // absence is already fully priced by websiteGap.
  if (!lead.hasRealWebsite) return 0;

  if (lead.mobileFriendly === false) {
    reasons.push('fails mobile');
    return SCORING.mobileGap.noViewport;
  }
  if (lead.mobileFriendly === 'partial') {
    reasons.push('partly mobile friendly');
    return SCORING.mobileGap.fixedWidth;
  }
  return SCORING.mobileGap.responsive;
}

function bookingGap(lead, reasons) {
  const appointment = isAppointmentCategory(lead.categories);
  const primary = (lead.categories[0] ?? 'business').toLowerCase();

  if (!appointment) return SCORING.bookingGap.nonAppointment;

  if (lead.hasBooking === true) return SCORING.bookingGap.appointmentPresent;

  reasons.push(`${primary}, no online booking`);
  return SCORING.bookingGap.appointmentMissing;
}

function viability(lead, reasons) {
  const count = lead.reviewCount;
  if (count === null) {
    reasons.push(SCORING.viability.unknownReason);
    return SCORING.viability.unknown;
  }
  for (const band of SCORING.viability.bands) {
    if (count >= band.min && count <= band.max) {
      reasons.push(band.reason.replace('{count}', count));
      return band.points;
    }
  }
  reasons.push(SCORING.viability.unknownReason);
  return SCORING.viability.unknown;
}

/**
 * Score a lead as a sales opportunity.
 *
 * Returns `provisional: true` when the lead has not been enriched yet, because
 * the mobile and booking components cannot be answered without fetching the
 * business's website. A provisional score is a floor, not an estimate.
 */
export function scoreLead(lead) {
  if (lead.permanentlyClosed) {
    return { score: 0, reasons: ['permanently closed'], provisional: false };
  }

  const reasons = [];
  let score = websiteGap(lead, reasons) + viability(lead, reasons);

  if (lead.enriched) {
    score += mobileGap(lead, reasons) + bookingGap(lead, reasons);
  }

  if (!lead.phone && !lead.email) {
    score *= SCORING.modifiers.unreachable;
    reasons.push('no phone or email, unreachable');
  }

  if (lead.lastReviewDays !== null && lead.lastReviewDays > SCORING.modifiers.dormantAfterDays) {
    score *= SCORING.modifiers.dormant;
    reasons.push('no review in over a year');
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
    provisional: !lead.enriched,
  };
}
