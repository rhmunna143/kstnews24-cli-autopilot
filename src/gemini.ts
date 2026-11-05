import { GoogleGenAI, Type } from '@google/genai';
import { logger } from './logger.js';

export interface GeminiResult {
  verdict: 'publish' | 'reject';
  rejectReason?: string;
  title?: string;
  dateline?: string;
  bodyHtml?: string;
  slug?: string;
  excerpt?: string;
  category?: string;
  tags?: string[];
  imageAltText?: string;
  bannerHeadline?: string;
}

export interface GenerateArticleInput {
  text: string;
  mediaKind: 'photo' | 'video' | 'album' | 'none';
  dateStr: string;
  existingCategories?: string[];
}

/**
 * Strips HTML tags and counts words.
 */
export function countWords(html: string): number {
  const plainText = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plainText) return 0;
  return plainText.split(/\s+/).filter(Boolean).length;
}

/**
 * Sanitizes HTML to allow only <p>, <h2>, <strong>, <em>, <ul>, <li>, <a> tags.
 * Strips scripts, styles, iframes, inline event handlers, and dangerous attributes.
 */
export function sanitizeHtml(rawHtml: string): string {
  if (!rawHtml) return '';

  let sanitized = rawHtml
    // Strip script and style blocks entirely
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    // Strip on* event handlers
    .replace(/\s+on\w+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, '')
    // Strip javascript: in href
    .replace(/href\s*=\s*['"]?javascript:[^'">]*['"]?/gi, 'href="#"');

  // Replace disallowed tags (keep inner text) or preserve allowed tags
  // Allowed tags: p, h2, strong, em, b, i, ul, li, a
  sanitized = sanitized.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/gi, (match, tag, attrs) => {
    const t = tag.toLowerCase();
    if (['p', 'h2', 'strong', 'em', 'ul', 'li'].includes(t)) {
      return match.startsWith('</') ? `</${t}>` : `<${t}>`;
    }
    if (t === 'b') return match.startsWith('</') ? '</strong>' : '<strong>';
    if (t === 'i') return match.startsWith('</') ? '</em>' : '<em>';
    if (t === 'a') {
      if (match.startsWith('</')) return '</a>';
      const hrefMatch = attrs.match(/href\s*=\s*['"]([^'"]+)['"]/i);
      const href = hrefMatch ? hrefMatch[1] : '#';
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">`;
    }
    // Disallow other tags (strip tag itself, keep content)
    return '';
  });

  return sanitized.trim();
}

/**
 * Normalizes English slug: lowercase, a-z0-9 and hyphens only, max 60 chars.
 */
export function sanitizeSlug(rawSlug?: string): string {
  if (!rawSlug) return 'news-report';
  let slug = rawSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) slug = 'news-update';
  return slug.slice(0, 60).replace(/-+$/, '');
}

export class GeminiService {
  private ai: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model = 'gemini-2.5-flash') {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  private buildSystemInstruction(): string {
    return `You are a senior, highly experienced Bengali news editor for KSTNews24 (kstnews24.com).
Your job is to gate incoming news posts for editorial quality and Google AdSense compliance, and rewrite acceptable news into an original, professional, SEO-optimized Bengali news article.

Strict Editorial & AdSense Guidelines:
1. Verdict:
   - "reject" if the post contains: advertisements, affiliate links, betting/gambling promotions (1xbet, casino, etc.), adult/sexually explicit content, graphic violence, graphic descriptions of blood/corpses/gore, hate speech, or unverifiable rumor without news value.
   - "reject" if the post has no real news value (e.g. personal chat, greeting, incoherent text, meme).
   - "publish" only if it is a genuine news report suitable for a mainstream public news portal.
2. In case of "reject", you MUST provide a rejectReason (e.g. "graphic_violence", "advertisement", "betting_promo", "adult_content", "not_news", "unverified_rumor").
3. In case of "publish":
   - Title: Engaging, objective Bengali headline, maximum 70 characters. No clickbait, no emoji.
   - Dateline: Must begin with location and date in Bengali numerals, e.g. "ঢাকা, ৫ নভেম্বর: " or "চট্টগ্রাম, ১২ মার্চ: ". If location is completely unknown, do not guess; provide only the Bengali date or omit location.
   - Body: 300 to 400 words in standard modern Bengali.
     * Structure: Start with dateline sentence, followed by an introductory lead paragraph.
     * Use 2 to 3 <h2> subheadings to divide sections logically.
     * Use short, readable paragraphs (<p>).
     * Do NOT invent quotes, facts, casualty numbers, or dates not present in the source.
     * Write an ORIGINAL rewritten news report. Do NOT copy the source text verbatim.
     * Do NOT mention Telegram, channel names, or "basherkella".
     * Allowed HTML tags in bodyHtml: <p>, <h2>, <strong>, <em>, <ul>, <li>. No inline styles, scripts, or images.
   - Slug: English URL slug, 3 to 8 words, lowercase, words separated by hyphens (e.g. "bangladesh-railway-new-schedule-announced"). Max 60 characters.
   - Excerpt: Meta description in Bengali, concise summary of the article, maximum 155 characters.
   - Category: Select the best matching Bengali category from the existing list provided in the prompt. If none fit well, propose a short appropriate Bengali category name (e.g. "জাতীয়", "রাজনীতি", "আন্তর্জাতিক", "অর্থনীতি", "খেলা", "বিনোদন", "প্রযুক্তি").
   - Tags: 3 to 6 relevant Bengali keyword tags.
   - Image Alt Text: Descriptive Bengali alt text for the featured news image.
   - Banner Headline: A concise Bengali headline (maximum 60 characters) suitable for a breaking news text banner.

Output ONLY valid JSON matching the requested schema.`;
  }

  async processPost(
    input: GenerateArticleInput,
    attempt = 1,
    retryNote?: string
  ): Promise<GeminiResult> {
    const categoriesPrompt =
      input.existingCategories && input.existingCategories.length > 0
        ? `Existing site categories to choose from: ${input.existingCategories.join(', ')}.`
        : 'Choose a standard news category (e.g. জাতীয়, রাজনীতি, আন্তর্জাতিক, অর্থনীতি, খেলা).';

    let userPrompt = `Source Post Information:
Current Date: ${input.dateStr}
Media Attached: ${input.mediaKind}
${categoriesPrompt}

Original Telegram Post Text:
"""
${input.text}
"""`;

    if (retryNote) {
      userPrompt += `\n\nNote from previous attempt: ${retryNote}`;
    }

    try {
      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: userPrompt,
        config: {
          systemInstruction: this.buildSystemInstruction(),
          temperature: 0.4,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              verdict: {
                type: Type.STRING,
                enum: ['publish', 'reject'],
              },
              rejectReason: {
                type: Type.STRING,
              },
              title: {
                type: Type.STRING,
              },
              dateline: {
                type: Type.STRING,
              },
              bodyHtml: {
                type: Type.STRING,
              },
              slug: {
                type: Type.STRING,
              },
              excerpt: {
                type: Type.STRING,
              },
              category: {
                type: Type.STRING,
              },
              tags: {
                type: Type.ARRAY,
                items: {
                  type: Type.STRING,
                },
              },
              imageAltText: {
                type: Type.STRING,
              },
              bannerHeadline: {
                type: Type.STRING,
              },
            },
            required: ['verdict'],
          },
        },
      });

      const rawText = response.text?.trim() || '';
      let parsed: GeminiResult;
      try {
        parsed = JSON.parse(rawText) as GeminiResult;
      } catch (err) {
        if (attempt <= 2) {
          logger.warn(`Gemini returned invalid JSON (attempt ${attempt}). Retrying...`);
          await this.delay(1500 * attempt);
          return this.processPost(input, attempt + 1, 'Return strictly valid JSON.');
        }
        throw new Error(`Failed to parse Gemini JSON output: ${rawText}`);
      }

      if (parsed.verdict === 'reject') {
        return {
          verdict: 'reject',
          rejectReason: parsed.rejectReason || 'rejected by editorial gate',
        };
      }

      // Validate required fields for 'publish'
      if (!parsed.title || !parsed.bodyHtml) {
        if (attempt <= 2) {
          logger.warn(`Gemini response missing title or bodyHtml (attempt ${attempt}). Retrying...`);
          await this.delay(1500 * attempt);
          return this.processPost(
            input,
            attempt + 1,
            'Missing title or bodyHtml for publish verdict.'
          );
        }
        throw new Error('Gemini publish verdict missing title or bodyHtml.');
      }

      // Sanitize fields
      parsed.bodyHtml = sanitizeHtml(parsed.bodyHtml);
      parsed.slug = sanitizeSlug(parsed.slug);
      parsed.title = parsed.title.slice(0, 80).trim();
      parsed.excerpt = (parsed.excerpt || parsed.title).slice(0, 160).trim();
      parsed.bannerHeadline = (parsed.bannerHeadline || parsed.title).slice(0, 65).trim();

      // Word count check on bodyHtml
      const words = countWords(parsed.bodyHtml);
      if ((words < 250 || words > 480) && attempt === 1) {
        logger.warn(
          `Body word count (${words}) outside target 250-480 words. Requesting adjustment...`
        );
        return this.processPost(
          input,
          attempt + 1,
          `The bodyHtml had ${words} words. Please rewrite to strictly be between 300 and 400 words.`
        );
      } else if (words < 250 || words > 480) {
        logger.warn(
          `Body word count (${words}) still outside ideal 250-480 words after retry; accepting.`
        );
      }

      return parsed;
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const isRateOrServer =
        errMsg.includes('429') ||
        errMsg.includes('500') ||
        errMsg.includes('503') ||
        errMsg.includes('ResourceExhausted');

      if (isRateOrServer && attempt <= 3) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        logger.warn(`Gemini API rate limit or server error. Backing off ${backoffMs}ms...`);
        await this.delay(backoffMs);
        return this.processPost(input, attempt + 1, retryNote);
      }

      throw err;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
