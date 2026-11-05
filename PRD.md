# PRD: KSTNews24 Manual CLI AutoPilot

**Version:** 1.0
**Owner:** KSTNews24
**Implementer:** AI IDE agent (agent should follow this document top to bottom)
**Status:** Ready for implementation

---

## 1. Overview

KSTNews24 AutoPilot is a local Node.js + TypeScript command-line tool. When the operator runs it manually, it:

1. Connects to Telegram as a user account (MTProto) and reads new posts from one target channel (`basherkella`).
2. Filters out advertisements and AdSense-unsafe content.
3. Rewrites valid posts into original, SEO-optimized Bengali news articles with Gemini 2.5 Flash.
4. Builds Google Discover-friendly media (1200x630 thumbnails).
5. Publishes to **kstnews24.com** through the WordPress REST API.

There is no database, daemon, or web server. State is one local `state.json` file. The process runs only while the operator's terminal is open.

## 2. Goals and Non-Goals

### Goals
- G1. One command pulls all unread channel posts and publishes them as finished WordPress articles.
- G2. Never publish ads, betting promos, graphic violence, or adult content.
- G3. Every article has: Bengali title, dateline, H2 subheadings, English slug, meta excerpt, category, tags, featured image with Bengali alt text.
- G4. Safe to re-run: no duplicate posts, no lost posts after a crash.
- G5. Operator can preview output as WP drafts before going live.

### Non-Goals
- No scheduler, cron, Docker, or hosted deployment.
- No web UI or dashboard.
- No multi-channel support (single `TG_CHANNEL`).
- No database.
- No auto-translation of languages other than rewriting into Bengali.

## 3. Users and Usage

Single operator (site owner), technical enough to run npm scripts and edit `.env`. Environment: Windows with WSL2 Ubuntu, or Linux/macOS. Node.js 20+.

## 4. Tech Stack

| Component | Package | Notes |
| --- | --- | --- |
| Runtime | Node.js 20+, TypeScript | ESM or CJS, keep consistent; run through `tsx` |
| Telegram | `telegram` (GramJS) | `StringSession`, MTProto |
| AI | `@google/genai` | Model `gemini-2.5-flash`, JSON structured output |
| Images | `sharp` | Resize, crop, blur-canvas, SVG compositing |
| Video | `ffmpeg-static` | Frame extraction via `child_process` |
| Config | `dotenv` | |
| Prompts | `input` | Interactive login |
| Dev | `typescript`, `@types/node`, `tsx` | |

HTTP to WordPress uses Node's built-in `fetch` (Node 20+). No extra HTTP library.

## 5. Project Structure

```text
kstnews-cli/
├── src/
│   ├── config.ts       # Load + validate .env
│   ├── state.ts        # Read/write state.json
│   ├── logger.ts       # Colored terminal output
│   ├── filter.ts       # Layer 1 local filter
│   ├── gemini.ts       # Layer 2 gate + article generation
│   ├── media.ts        # Sharp + FFmpeg
│   ├── wordpress.ts    # REST client
│   ├── telegram.ts     # Fetch, album grouping, live listener
│   ├── pipeline.ts     # Orchestrates one "post unit" end to end (added: keeps cli.ts thin)
│   └── cli.ts          # Entrypoint, arg parsing
├── state.json
├── .env
├── package.json
└── tsconfig.json
```

## 6. CLI Modes

| Script | Command | Behavior |
| --- | --- | --- |
| `npm run sync` | `tsx src/cli.ts --once` | Catch up, publish, exit |
| `npm run watch` | `tsx src/cli.ts --watch` | Catch up, then listen live until Ctrl+C |
| `npm run draft` | `tsx src/cli.ts --once --draft` | Same as sync, but WP status forced to `draft` |
| `npm run reset` | `tsx src/cli.ts --reset` | Clear saved state |

Additional flags (agent should implement):
- `--draft` may also combine with `--watch`.
- `--limit <n>`: process at most n post units this run (default: unlimited for sync, see first-run rule).
- `--dry-run`: run the full pipeline but do not call any WordPress write endpoint; print what would be published.

Exit codes: `0` success, `1` config/auth error, `2` partial failure (some posts failed, others succeeded).

`Ctrl+C` must trigger graceful shutdown: finish or abort the current post cleanly, persist state, disconnect Telegram, exit.

## 7. Configuration (`.env`)

```env
TG_API_ID=
TG_API_HASH=
TG_SESSION=
TG_CHANNEL=basherkella

GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash

WP_URL=https://kstnews24.com
WP_USERNAME=
WP_APP_PASSWORD=
WP_POST_STATUS=publish

THUMB_WIDTH=1200
THUMB_HEIGHT=630
BODY_MAX_WIDTH=1200
MAX_VIDEO_MB=25
FIRST_RUN_LIMIT=10
```

`config.ts` requirements:
- Validate all required keys at startup; print a clear list of missing/invalid keys and exit `1`.
- `TG_SESSION` may be empty (triggers interactive login).
- Strip trailing slash from `WP_URL`.
- Coerce numeric values; reject non-numeric.
- `WP_POST_STATUS` must be one of `publish`, `draft`, `pending`. `--draft` overrides it.
- Never log secrets. Mask the app password in any debug output.

## 8. State (`state.json`)

```json
{
  "channel": "basherkella",
  "lastProcessedId": 0,
  "history": [
    {
      "runAt": "2026-11-05T06:30:00.000Z",
      "mode": "sync",
      "published": 3,
      "skipped": 5,
      "failed": 0
    }
  ],
  "processed": [
    { "messageIds": [101, 102], "wpPostId": 4521, "url": "https://kstnews24.com/...", "status": "publish" }
  ]
}
```

Rules:
- `state.ts` exposes `loadState()`, `saveState()`, `markProcessed()`, `resetState()`.
- Writes must be atomic: write to `state.json.tmp`, then rename.
- `lastProcessedId` advances only after a post unit is **finished** (published, or deliberately skipped by a filter). A failed unit does not advance the pointer past it; it is retried on next run unless it failed 3 times, in which case it is recorded as `failed` and skipped.
- Keep `processed` capped to the last 200 entries and `history` to the last 50.
- If the channel in state differs from `TG_CHANNEL`, warn and require `--reset` or confirmation.
- `--draft` runs **do** advance state by default (operator wants to test real behavior). Add flag `--no-state` to avoid writing state in test runs.
- `--reset` asks for confirmation (`y/N`) before clearing.

## 9. Pipeline

### 9.1 Post unit

A **post unit** is either a single Telegram message or an album (all messages sharing the same `groupedId`). The unit's text is the first non-empty caption/message among its members. Its ID for state purposes is the highest message ID in the unit.

### 9.2 Flow per unit

```
fetch → group albums → Layer 1 filter → Layer 2 Gemini gate → article generation
      → media pipeline → WordPress upload → taxonomy resolve → internal links → create post → save state
```

Units are processed **chronologically (oldest first)**, one at a time (sequential, no concurrency, to respect Gemini and WP rate limits).

### 9.3 First-run rule

If `lastProcessedId == 0`, do not backfill the whole channel. Fetch only the latest `FIRST_RUN_LIMIT` messages (default 10), print a notice, and process them. This prevents accidentally publishing hundreds of old posts.

## 10. Module Specifications

### 10.1 `logger.ts`
- Levels: `info`, `success`, `warn`, `error`, `skip`, `step`.
- Color-coded ANSI output, no extra dependency (hand-roll escape codes).
- Each unit logs a one-line summary: `[#102] ✔ Published → https://...` or `[#103] ⏭ Skipped (layer1: betting keyword)`.
- At end of run print a summary table: published / skipped / failed counts.

### 10.2 `telegram.ts`
- Connect with `TelegramClient` + `StringSession(TG_SESSION)`.
- If session empty: interactive login via `input` (phone, code, optional 2FA password). After success, print the session string with clear instructions to paste into `.env` as `TG_SESSION`.
- Resolve the channel entity from `TG_CHANNEL` (username, with or without `@`).
- `fetchUnread(minId, limit?)`: use `iterMessages` with `minId` and `reverse: true` to get messages newer than `lastProcessedId` in ascending order.
- Group by `groupedId`; singles remain standalone.
- For each message expose: `id`, `date`, `text`, `entities`, `media` kind (`photo` | `video` | `other` | `none`), `replyMarkup` (for inline button detection), `forwardedFrom`, `groupedId`.
- Download media into memory `Buffer`s (`downloadMedia`). For video, check file size before downloading; if larger than `MAX_VIDEO_MB`, skip downloading the video body and use only a thumbnail/frame approach (see 10.4).
- `listen(handler)`: register a `NewMessage` event handler for the channel. Because albums arrive as multiple events, buffer incoming messages by `groupedId` for ~2 seconds before emitting one unit. Process units through a serial queue so only one runs at a time.
- Handle FloodWait errors: sleep for the indicated seconds, then retry.
- Handle disconnects: auto-reconnect in watch mode (GramJS `connectionRetries`), log reconnects.

### 10.3 `filter.ts` (Layer 1, local, no network)
Returns `{ pass: boolean, reason?: string }`. Skip when any of:
- Message has inline buttons (`replyMarkup` with URL/callback buttons).
- Text matches ad/betting keyword lists (Bengali + English), stored as exported arrays at the top of the file so the operator can edit them. Seed examples: `বেটিং`, `জুয়া`, `ক্যাসিনো`, `বোনাস`, `প্রমো কোড`, `বিজ্ঞাপন`, `স্পনসর`, `sponsored`, `promo`, `casino`, `1xbet`, `betting`, `bet365`, `jackpot`, `referral`, `join now`, `t.me/+` invite links in ad context.
- Text is too short to be news (under ~40 characters after stripping URLs/emoji) **and** has no media.
- Text is mostly links/hashtags with no real sentence content.
- Post is a pure forward of a promotional channel (optional heuristic; log it).

Keyword matching: normalize Unicode (NFC), lowercase, match as substrings for Bengali and word-boundary for Latin tokens.

### 10.4 `gemini.ts` (Layer 2 + generation)

Use one Gemini call per post that both **gates** and **generates**, to save quota, returning structured JSON via `responseMimeType: "application/json"` and a `responseSchema`.

**Input:** original post text, whether media exists and its kind, current date.

**Output schema:**

```ts
interface GeminiResult {
  verdict: "publish" | "reject";
  rejectReason?: string;            // required when reject (e.g. "graphic_violence", "adult", "advertisement", "not_news")
  title?: string;                   // Bengali, <= 70 chars
  dateline?: string;                // e.g. "ঢাকা, ৫ নভেম্বর:" (location + date, Bengali numerals)
  bodyHtml?: string;                // Bengali, 300-400 words, <p> and <h2> only
  slug?: string;                    // English, lowercase, hyphenated, 3-8 words
  excerpt?: string;                 // Bengali meta description, <= 155 chars
  category?: string;                // Bengali category name
  tags?: string[];                  // 3-6 Bengali tags
  imageAltText?: string;            // Bengali alt text
  bannerHeadline?: string;          // short Bengali headline (<= 60 chars) for text-only banner
}
```

**Prompt requirements (system instruction):**
- Role: senior Bengali news editor.
- Reject if: advertisement/promotion, betting/gambling, adult content, graphic violence or visible blood/gore descriptions, hate speech, or unverifiable rumor presented as fact; also reject if the post has no real news value.
- Rewrite as an **original** report; do not copy sentences verbatim; do not invent facts, quotes, numbers, names, or locations not present in the source. If a location is unknown, omit the dateline location rather than guessing.
- Structure: dateline sentence first, short intro, 2-3 `<h2>` subheadings, short paragraphs.
- Neutral, factual tone. No clickbait, no all-caps, no emoji.
- Use Bengali numerals consistently with the source.
- Choose a category from the existing site categories passed in the prompt (fetched from WP, see 10.6) when one fits; otherwise propose a new short one.
- Do not mention Telegram, the source channel, or "basherkella" in the body.
- Output **only** JSON matching the schema.

**Implementation requirements:**
- `temperature` about 0.4.
- Validate the response with a runtime check (hand-written validator or zod if allowed). On invalid JSON or schema mismatch: retry up to 2 times, then mark the unit failed.
- Retry with exponential backoff on 429/5xx.
- Word-count check on `bodyHtml` (strip tags). If outside 250-480 words, retry once with a correction note; if still out of range, accept but log a warning.
- Sanitize `bodyHtml`: allow only `p`, `h2`, `strong`, `em`, `ul`, `li`, `a` (internal links added later). Strip scripts, styles, and inline event handlers.
- Slug post-processing: lowercase, `[a-z0-9-]` only, collapse dashes, max 60 chars.

### 10.5 `media.ts`

All functions work on `Buffer`s; no temp files except for FFmpeg (use `os.tmpdir()` and clean up in `finally`).

**Featured thumbnail (1200x630, JPEG quality ~82, progressive):**
- Landscape source (aspect ratio >= ~1.4): `sharp.resize(W, H, { fit: 'cover', position: sharp.strategy.attention })`.
- Vertical or square source: blurred-background canvas. Background = same image resized to cover W×H, blurred (sigma ~30) and slightly darkened; foreground = image resized with `fit: 'inside'` to fit W×H, centered via composite.
- Always `.rotate()` first to honor EXIF orientation.

**Body images:** resize to max width `BODY_MAX_WIDTH` with `withoutEnlargement: true`, JPEG/WebP output, strip metadata.

**Video-only posts:**
- Extract a frame at 1 second via `ffmpeg-static` binary (`-ss 1 -i in.mp4 -frames:v 1 out.jpg`). If the video is shorter than 1 second, fall back to the first frame.
- Feed the frame into the featured-thumbnail routine.
- If the video is <= `MAX_VIDEO_MB`, upload the MP4 to WP and embed it in the body with a `<video controls preload="metadata" poster="...">` tag (or `<figure class="wp-block-video">`). If larger, skip the video, use only the thumbnail, and log a warning.

**Text-only banner (1200x630):**
- Build an SVG: dark branded background, accent bar, "ব্রেকিং নিউজ" label, headline text (from `bannerHeadline`), and site name "KSTNews24" footer.
- Headline must wrap: implement simple word-wrap by character width estimate (Bengali glyph widths are variable, so wrap by approximate max chars per line, ~22-26 at the chosen font size) and cap at 3-4 lines with font size reduction for long headlines.
- Font family in SVG: `'Noto Sans Bengali', 'Noto Serif Bengali', sans-serif`.
- Composite the SVG through `sharp(Buffer.from(svg))` to PNG/JPEG.
- At startup, run a **font sanity check**: render a tiny Bengali SVG and warn if the output looks blank/tofu (heuristic: warn once and print the apt install command from section 12). Do not crash.

### 10.6 `wordpress.ts`

Auth: `Authorization: Basic base64(username:appPassword)` (app password with spaces is fine).

Base: `${WP_URL}/wp-json/wp/v2`.

Functions:
- `verifyAuth()`: `GET /users/me`. Run at startup; fail fast with a clear message on 401/403, and a hint if `/wp-json` is blocked (security plugin, permalinks).
- `uploadMedia(buffer, filename, mimeType, { altText, title })`: `POST /media` with `Content-Disposition: attachment; filename="..."` and raw body. Then `POST /media/{id}` to set `alt_text` (and `title`) if not accepted in the first call. Return `{ id, source_url }`. Filenames must be ASCII (derive from slug + short hash).
- `listCategories()`: paginated `GET /categories?per_page=100`, cache in memory.
- `resolveCategory(name)`: match case-insensitively on name/slug; if missing, `POST /categories`. Fall back to default category (id 1) if creation fails.
- `resolveTags(names[])`: for each, search `GET /tags?search=` exact-name match; else `POST /tags`. Handle `term_exists` error (400) by reading the existing `data.term_id`. Cache results.
- `getRecentPosts(categoryId, n = 2, excludeId?)`: `GET /posts?categories=...&per_page=n&_fields=id,title,link&status=publish`.
- `createPost({ title, content, slug, excerpt, categories, tags, featured_media, status })`: `POST /posts`. Return `{ id, link }`.
- Retries: network errors and 5xx get 3 retries with backoff; 4xx do not retry (except 429).
- Request timeout 60 s for uploads, 30 s otherwise.
- Never create duplicate posts: before `createPost`, if state already has a `wpPostId` for this unit, skip.

**Internal linking:** after resolving the category, fetch two recent posts from the same category (excluding none, since the new post doesn't exist yet) and append a box to the end of `bodyHtml`:

```html
<div class="kst-read-more" style="border-left:4px solid #c00;padding:12px 16px;margin:24px 0;background:#f7f7f7;">
  <strong>আরও পড়ুন</strong>
  <ul>
    <li><a href="{link1}">{title1}</a></li>
    <li><a href="{link2}">{title2}</a></li>
  </ul>
</div>
```

If fewer than 2 posts exist, include what exists; if none, omit the box. Escape titles for HTML.

### 10.7 `pipeline.ts`

`processUnit(unit, ctx)` returns `{ outcome: 'published' | 'skipped' | 'failed', reason?, url? }`:

1. Layer 1 filter → skip on fail.
2. Download media (photos/video) as needed.
3. Gemini gate + generate → skip on `reject` (log `rejectReason`).
4. Build media: featured thumbnail, body images, video as per media type (photo / video-only / text-only).
5. Upload media to WP with Bengali alt text; collect IDs and URLs.
6. Resolve category and tags.
7. Compose final HTML: dateline + body + inline body images (as `<figure><img ...><figcaption>` with alt) + video embed if any + Read More box.
8. `createPost` with status (`--draft` forces `draft`).
9. Print live URL, update state.

Wrap each unit in try/catch so one failure never stops the batch. Respect `--dry-run`.

### 10.8 `cli.ts`
- Parse args with a small hand-written parser (`process.argv`), no extra dependency.
- Startup sequence: load config → verify WP auth → check fonts → connect Telegram → load state → run mode.
- `--once`: fetch, process, print summary, disconnect, exit.
- `--watch`: do the `--once` catch-up, then `listen()` and keep the process alive until SIGINT/SIGTERM.
- Catch `unhandledRejection` and log it without silently dying.

## 11. Functional Requirements Summary

| ID | Requirement | Priority |
| --- | --- | --- |
| FR1 | Interactive Telegram login and session-string output | Must |
| FR2 | Catch-up from `lastProcessedId`, chronological order | Must |
| FR3 | Album grouping by `groupedId` | Must |
| FR4 | Layer 1 local filter (buttons, ad/betting keywords) | Must |
| FR5 | Layer 2 Gemini gate (AdSense safety) | Must |
| FR6 | 300-400 word Bengali SEO article with dateline, H2s, slug, excerpt, category, tags | Must |
| FR7 | Photo thumbnail logic (attention crop / blurred canvas) | Must |
| FR8 | Video frame extraction + MP4 embed (<= 25 MB) | Must |
| FR9 | Text-only Bengali banner via SVG | Must |
| FR10 | WP media upload with Bengali alt text | Must |
| FR11 | Category/tag match-or-create | Must |
| FR12 | Internal "আরও পড়ুন" box | Should |
| FR13 | Draft mode, dry-run mode | Must / Should |
| FR14 | Live watch with album buffering and serial queue | Must |
| FR15 | Atomic state, retry/skip policy | Must |
| FR16 | Startup font check, WP auth check | Should |

## 12. Environment Setup (for the operator)

1. Telegram API ID/Hash from https://my.telegram.org (API development tools).
2. Gemini API key from Google AI Studio.
3. WordPress Application Password: wp-admin → Users → Profile → Application Passwords. Requires HTTPS on the site.
4. WSL2 Ubuntu Bengali fonts:
   ```bash
   sudo apt update && sudo apt install -y fonts-noto-core fonts-beng
   ```
5. Install:
   ```bash
   mkdir kstnews-cli && cd kstnews-cli
   npm init -y
   npm install telegram @google/genai sharp ffmpeg-static dotenv input
   npm install -D typescript @types/node tsx
   npx tsc --init
   ```
6. `package.json` scripts:
   ```json
   {
     "scripts": {
       "sync": "tsx src/cli.ts --once",
       "watch": "tsx src/cli.ts --watch",
       "draft": "tsx src/cli.ts --once --draft",
       "reset": "tsx src/cli.ts --reset"
     }
   }
   ```
7. `tsconfig.json`: `strict: true`, `target: ES2022`, `module`/`moduleResolution` consistent with `tsx` usage (`NodeNext` or `commonjs`), `esModuleInterop: true`, `skipLibCheck: true`.
8. First run: `npm run draft` → enter phone + OTP → copy printed session string into `TG_SESSION` in `.env` → rerun.

## 13. Non-Functional Requirements

- **Reliability:** a single bad post never aborts a run; crash-safe state; resumable.
- **Rate limits:** sequential processing; backoff on Gemini 429, Telegram FloodWait, WP 429.
- **Security:** `.env` and `state.json` in `.gitignore`; session string and app password never printed after initial login; session string printed once with a warning to keep it secret.
- **Performance:** target under ~30 s per post (Gemini + upload dominated). Memory: buffers only, release after each unit.
- **Observability:** readable colored logs; every skip has a reason; final run summary.
- **Portability:** no OS-specific paths; FFmpeg via `ffmpeg-static`.

## 14. Content, Legal and Quality Guardrails

- Articles must be rewritten originals, not near-verbatim copies of the source post. Do not copy Telegram media that is clearly watermarked by another outlet if the operator enables the optional `SKIP_WATERMARKED` setting (nice-to-have; not required in v1).
- No fabricated facts, quotes, or locations. When in doubt, Gemini omits.
- AdSense policy: reject graphic violence, blood, adult content, gambling promotion, and misleading content.
- Operator is responsible for having rights to republish the media; the tool should print a one-time notice on first run.
- Recommended: operator reviews output with `npm run draft` for the first few runs before switching to `publish`.

## 15. Edge Cases (must be handled)

| Case | Expected behavior |
| --- | --- |
| Album with caption on a non-first photo | Use first non-empty caption in the group |
| Album of >10 photos | Use first as featured; embed up to 5 extra body images |
| Post with only a sticker/poll/other media | Layer 1 skip (`unsupported media`) |
| Text contains only URLs | Layer 1 skip |
| Gemini returns reject | Skip, log reason, advance state |
| Gemini returns malformed JSON | Retry (max 2), then fail unit; do not advance past it |
| Duplicate slug on WP | WP auto-suffixes; accept returned `link` |
| WP category creation denied | Fall back to default category |
| Video > 25 MB | Thumbnail only, no MP4 embed, warn |
| FFmpeg failure | Fall back to text-only banner using `bannerHeadline` |
| Telegram session revoked | Clear message instructing to blank `TG_SESSION` and re-login |
| Ctrl+C mid-post | Abort current unit, don't advance state for it, exit cleanly |
| Telegram message edited/deleted later | Ignored (not tracked in v1) |
| Machine offline mid-run | Retries, then fail unit; resume next run |

## 16. Acceptance Criteria

1. `npm run draft` on a fresh setup prompts for Telegram login, prints a session string, and on rerun creates draft posts in wp-admin with correct title, dateline, H2s, slug, excerpt, category, tags, featured image, and Bengali alt text.
2. A post containing an inline URL button is skipped by Layer 1 with a logged reason.
3. A betting-promo post is skipped (Layer 1 or Layer 2); a graphic-violence post is rejected by Layer 2.
4. A landscape photo yields a 1200x630 attention-cropped thumbnail; a vertical photo yields a blurred-background 1200x630 thumbnail.
5. A video-only post yields a 1200x630 frame thumbnail and an embedded MP4 (when <= 25 MB).
6. A text-only post yields a readable Bengali banner (no tofu boxes) with the headline.
7. Articles contain an "আরও পড়ুন" box with up to two same-category links.
8. Running `npm run sync` twice in a row publishes nothing the second time (no duplicates).
9. Killing the process mid-run and rerunning does not lose or duplicate posts.
10. `npm run watch` publishes a newly posted channel message within ~1 minute and shuts down cleanly on Ctrl+C.
11. `npm run reset` clears state only after confirmation.
12. `--dry-run` makes zero WordPress write calls.
13. `npx tsc --noEmit` passes with no errors.

## 17. Suggested Build Order (for the agent)

1. Scaffold project, `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`.
2. `config.ts`, `logger.ts`, `state.ts` (+ simple self-test).
3. `wordpress.ts` with `verifyAuth`, then media upload, taxonomy, create post. Test with a hardcoded dummy post as a draft.
4. `gemini.ts` with a sample text input; verify JSON validation and Bengali output.
5. `media.ts`: thumbnails, body resize, banner, FFmpeg frame. Test with local sample files and save outputs to disk to inspect.
6. `filter.ts` with unit-style checks on sample strings.
7. `telegram.ts`: login, fetch, album grouping.
8. `pipeline.ts` wiring everything, then `cli.ts` with modes and flags.
9. Watch mode, album buffering, graceful shutdown.
10. Run through the acceptance criteria and fix gaps.

## 18. Deliverables

- Complete source under `src/` as specified.
- `.env.example` with all keys documented.
- `README.md` with setup steps from section 12 and the command table from section 6.
- `.gitignore` covering `.env`, `state.json`, `node_modules`.
- All acceptance criteria in section 16 verified, with notes on any that could not be tested (for example, live Telegram events).

## 19. Open Questions / Future Work

- Should source attribution (for example, "সূত্র: ...") be added to articles? Default in v1: no.
- Add scheduled posting (`status: future`) for staggered publishing.
- Support Rank Math / Yoast meta fields through custom REST fields (`excerpt` is used for meta description in v1).
- Optional duplicate-story detection (compare titles with recent WP posts) to avoid publishing the same news twice.
- Optional image-watermark detection.
