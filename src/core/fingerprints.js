/**
 * Website signatures used to fingerprint a prospect's platform, booking widget,
 * chatbot, socials and mobile-readiness from raw HTML text. No DOM: DOMParser and
 * document are both unavailable in a service worker, and every signal here is a
 * substring of the raw markup anyway (a script src, a meta tag, an href), which is
 * what tech-detection tools match on too.
 */
export const FINGERPRINTS = Object.freeze({
  tech: Object.freeze({
    wordpress: ['/wp-content/', '/wp-includes/', 'name="generator" content="WordPress'],
    wix: ['static.parastorage.com', 'wix.com/website-builder'],
    squarespace: ['squarespace.com', 'static1.squarespace.com'],
    godaddy: ['godaddysites.com', 'img1.wsimg.com'],
    weebly: ['weebly.com', 'editmysite.com'],
    shopify: ['cdn.shopify.com', 'shopify.com/s/files'],
    webflow: ['assets.website-files.com', 'webflow.io'],
    next: ['/_next/static/', '__NEXT_DATA__'],
    react: ['react-dom', 'data-reactroot'],
  }),
  chatbot: Object.freeze(['widget.intercom.io', 'js.driftt.com', 'embed.tawk.to',
    'client.crisp.chat', 'code.tidio.co', 'js.hs-scripts.com', 'cdn.livechatinc.com']),
  booking: Object.freeze(['assets.calendly.com', 'acuityscheduling.com', 'squareup.com/appointments',
    'setmore.com', 'simplybook.me', 'booksy.com', 'fresha.com', 'opentable.com', 'resy.com']),
  socials: Object.freeze({
    facebook: 'facebook.com/', instagram: 'instagram.com/', linkedin: 'linkedin.com/',
    x: 'twitter.com/', tiktok: 'tiktok.com/', youtube: 'youtube.com/',
  }),
  // Paths that mean "share this page", not "our profile". A share/like button links
  // the platform's own domain too, so a bare substring match on the domain would
  // report almost every site as having a profile there.
  socialNoise: Object.freeze(['/sharer', '/share?', '/intent/', 'plugins/like']),
});

/**
 * Order is deliberate: specific site-builder signatures are checked before the
 * generic framework signatures ('next', 'react') that a builder site can also
 * embed. A Wix site ships React under the hood and a Shopify theme commonly does
 * too, so checking 'react' before 'wix' or 'shopify' would misidentify both as a
 * bespoke React build. wordpress/wix/squarespace/godaddy/weebly/shopify/webflow are
 * mutually exclusive hosting platforms, safe to check in any order relative to each
 * other; 'next' and 'react' go last because they describe a framework, not a host,
 * and any of the platforms above could contain one.
 */
export function detectTech(html) {
  for (const [key, patterns] of Object.entries(FINGERPRINTS.tech)) {
    if (patterns.some((pattern) => html.includes(pattern))) return key;
  }
  return 'unknown';
}

export function detectChatbot(html) {
  return FINGERPRINTS.chatbot.some((pattern) => html.includes(pattern));
}

export function detectBooking(html) {
  return FINGERPRINTS.booking.some((pattern) => html.includes(pattern));
}

/**
 * Returns each social platform linked, deduplicated. A bare substring match on the
 * platform domain would count share/like buttons as a profile, since those link the
 * same domain, so each hit is widened to the full URL (up to the next quote or
 * whitespace) and rejected if that URL contains a socialNoise path.
 */
export function detectSocials(html) {
  const found = new Set();
  for (const [name, domain] of Object.entries(FINGERPRINTS.socials)) {
    const urlPattern = new RegExp(domain.replace(/\./g, '\\.') + '[^"\'\\s)<>]*', 'g');
    let match;
    while ((match = urlPattern.exec(html))) {
      if (!FINGERPRINTS.socialNoise.some((noise) => match[0].includes(noise))) {
        found.add(name);
        break;
      }
    }
  }
  return [...found];
}

/**
 * Three-valued: `true` means a responsive viewport tag is present, `false` means
 * there is no viewport meta at all, `'partial'` means one exists but pins a fixed
 * width. Collapsing 'partial' into false would make a site that tried and got it
 * wrong look identical to a site that never considered mobile at all.
 */
export function detectMobileFriendly(html) {
  const meta = html.match(/<meta\b[^>]*\bname=["']viewport["'][^>]*>/i);
  if (!meta) return false;
  const content = meta[0].match(/\bcontent=["']([^"']*)["']/i);
  return /width\s*=\s*device-width/i.test(content ? content[1] : '') ? true : 'partial';
}
