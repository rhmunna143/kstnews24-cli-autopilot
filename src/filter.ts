/**
 * Layer 1 Filter: Local, synchronous, rule-based filtering for ads, betting,
 * unsupported media, and spam.
 */

export const AD_KEYWORDS_BN = [
  'বেটিং',
  'জুয়া',
  'ক্যাসিনো',
  'বোনাস',
  'প্রমো কোড',
  'প্রমোকোড',
  'বিজ্ঞাপন',
  'স্পনসর',
  'স্পন্সর',
  'বাজি ধরুন',
  'ফ্রি স্পিন',
  'ডিপোজিট বোনাস',
  'লটারি',
  'রেফারেল',
];

export const AD_KEYWORDS_EN = [
  'sponsored',
  'promo',
  'promotion',
  'casino',
  '1xbet',
  'betting',
  'bet365',
  'melbet',
  'parimatch',
  'babu88',
  'megapari',
  'jackpot',
  'referral',
  'join now',
  'deposit bonus',
  'promo code',
  't.me/\\+',
];

export interface PostUnitMeta {
  text: string;
  hasPhoto: boolean;
  hasVideo: boolean;
  hasUnsupportedMedia?: boolean;
  hasInlineButtons?: boolean;
  forwardedFromTitle?: string;
  forwardedFromUsername?: string;
}

export interface FilterResult {
  pass: boolean;
  reason?: string;
}

/**
 * Removes URLs, hashtags, emojis, and normalizes whitespace.
 */
export function cleanTextForLengthCheck(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/https?:\/\/[^\s]+/gi, '') // URLs
    .replace(/t\.me\/[^\s]+/gi, '') // Telegram links
    .replace(/#[^\s]+/g, '') // Hashtags
    .replace(/@([a-zA-Z0-9_]+)/g, '') // Mentions
    // Strip emojis and symbols
    .replace(/[\p{Extended_Pictographic}\u2600-\u27BF]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks whether text matches Bengali ad keywords (substring match)
 * or English keywords (word-boundary match).
 */
export function matchesAdKeywords(rawText: string): { matches: boolean; keyword?: string } {
  if (!rawText) return { matches: false };
  const normalized = rawText.normalize('NFC').toLowerCase();

  // Bengali substring match
  for (const kw of AD_KEYWORDS_BN) {
    const kwNorm = kw.normalize('NFC').toLowerCase();
    if (normalized.includes(kwNorm)) {
      return { matches: true, keyword: kw };
    }
  }

  // English word boundary / pattern match
  for (const kw of AD_KEYWORDS_EN) {
    const kwNorm = kw.toLowerCase();
    if (kwNorm.includes('\\+')) {
      // Regex pattern like t.me/\+
      const reg = new RegExp(kwNorm, 'i');
      if (reg.test(normalized)) {
        return { matches: true, keyword: kw };
      }
    } else {
      const escaped = kwNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reg = new RegExp(`\\b${escaped}\\b`, 'i');
      if (reg.test(normalized)) {
        return { matches: true, keyword: kw };
      }
    }
  }

  return { matches: false };
}

/**
 * Evaluates a post unit against Layer 1 rules.
 */
export function evaluateLayer1(meta: PostUnitMeta): FilterResult {
  // 1. Check for inline buttons
  if (meta.hasInlineButtons) {
    return { pass: false, reason: 'layer1: message contains inline buttons' };
  }

  // 2. Check for unsupported media (sticker, poll, etc.) without supported media
  if (meta.hasUnsupportedMedia && !meta.hasPhoto && !meta.hasVideo) {
    return { pass: false, reason: 'layer1: unsupported media (sticker/poll/audio/etc)' };
  }

  // 3. Check for ad/betting keywords in text
  const adCheck = matchesAdKeywords(meta.text);
  if (adCheck.matches) {
    return { pass: false, reason: `layer1: ad/betting keyword detected ("${adCheck.keyword}")` };
  }

  // 4. Check for promotional forwarded channel
  if (meta.forwardedFromTitle || meta.forwardedFromUsername) {
    const fwdSource = `${meta.forwardedFromTitle || ''} ${meta.forwardedFromUsername || ''}`;
    const fwdAdCheck = matchesAdKeywords(fwdSource);
    if (fwdAdCheck.matches) {
      return {
        pass: false,
        reason: `layer1: forwarded from promotional source ("${fwdAdCheck.keyword}")`,
      };
    }
  }

  // 5. Clean text for length and content check
  const cleaned = cleanTextForLengthCheck(meta.text);
  const hasMedia = meta.hasPhoto || meta.hasVideo;

  // Text contains only URLs or empty text
  if (meta.text.trim().length > 0 && cleaned.length === 0 && !hasMedia) {
    return { pass: false, reason: 'layer1: text contains only URLs/hashtags with no media' };
  }

  // Text too short without media (< 40 chars)
  if (!hasMedia && cleaned.length < 40) {
    return {
      pass: false,
      reason: `layer1: text too short to be news (${cleaned.length} chars) with no media`,
    };
  }

  // If text is totally empty and has no media
  if (!meta.text.trim() && !hasMedia) {
    return { pass: false, reason: 'layer1: empty post' };
  }

  return { pass: true };
}
