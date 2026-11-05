# KSTNews24 AutoPilot CLI

KSTNews24 AutoPilot is a lightweight, local Node.js + TypeScript command-line tool. When executed manually by the operator, it:

1. Connects to Telegram via MTProto (`telegram` / GramJS) and reads unread posts from the target channel (`basherkella`).
2. Filters out advertisements, betting promotions, and AdSense-unsafe content (two-tier local + Gemini safety gate).
3. Rewrites valid posts into original, search-optimized Bengali news articles using Gemini 2.5 Flash (`@google/genai`).
4. Generates Google Discover-friendly media: 1200x630 featured thumbnails (smart attention crop or blurred-background canvas), body images, video frames via FFmpeg, and branded SVG text banners.
5. Publishes directly to **kstnews24.com** via the WordPress REST API with taxonomies and an internal "আরও পড়ুন" box.

State is tracked in a single atomic local file (`state.json`) with zero databases, background daemons, or web servers required.

---

## CLI Execution Commands

| Command | Script | Description |
| --- | --- | --- |
| `npm run sync` | `tsx src/cli.ts --once` | One-shot sync: catch up on unread posts, publish to WordPress, and exit. |
| `npm run watch` | `tsx src/cli.ts --watch` | Live watch: catch up on unread posts, then listen live to stream new channel updates until `Ctrl + C`. |
| `npm run draft` | `tsx src/cli.ts --once --draft` | Test mode: runs sync but forces WordPress post status to `draft` so you can review in `wp-admin`. |
| `npm run reset` | `tsx src/cli.ts --reset` | Clears local `state.json` (prompts for confirmation `y/N`). |

### Additional Flags

- `--draft`: Can be combined with `--watch` or `--once` to force draft status in WordPress.
- `--limit <n>`: Processes at most `n` post units in the run.
- `--dry-run`: Runs the complete pipeline (Layer 1 filter, Gemini analysis, media synthesis) but **does not make any WordPress write calls**. Prints what would be published.
- `--no-state`: Runs without writing updates to `state.json` (useful for dry runs and test executions).
- `-y` / `--yes`: Automatically confirms prompts (e.g. for `--reset`).

---

## Setup & Prerequisites

### 1. Requirements

- **Node.js**: v20 or newer
- **Operating System**: Linux, macOS, or Windows (WSL2 Ubuntu recommended for Bengali fonts)

### 2. Bengali Fonts (WSL2 / Linux)

For optimal Bengali text rendering on fallback breaking-news banners:

```bash
sudo apt update && sudo apt install -y fonts-noto-core fonts-beng
```

### 3. Credentials

Prepare the following API keys and credentials:

1. **Telegram API ID & Hash**: From [my.telegram.org](https://my.telegram.org) (API development tools).
2. **Google Gemini API Key**: From [Google AI Studio](https://aistudio.google.com).
3. **WordPress Application Password**: From your WordPress dashboard under **Users → Profile → Application Passwords**.

### 4. Configure Environment (`.env`)

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Fill in your credentials:

```env
TG_API_ID=your_api_id
TG_API_HASH=your_api_hash
TG_SESSION=
TG_CHANNEL=basherkella

GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash

WP_URL=https://kstnews24.com
WP_USERNAME=your_wp_username
WP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx
WP_POST_STATUS=publish

THUMB_WIDTH=1200
THUMB_HEIGHT=630
BODY_MAX_WIDTH=1200
MAX_VIDEO_MB=25
FIRST_RUN_LIMIT=10
```

> **Note on Initial Run:** Leave `TG_SESSION=` blank on your first run. The CLI will interactively prompt for your phone number and OTP code in the terminal. Once logged in, it will print your session string. Copy and paste that string into `.env` under `TG_SESSION` for seamless subsequent runs.

---

## Testing & Quality Assurance

Run the comprehensive unit and integration test suite:

```bash
npm test
```

Run TypeScript compilation check:

```bash
npm run typecheck
```

---

## Architecture & Pipeline Overview

```text
Telegram Channel (@basherkella)
      │
      ▼
Fetch & Group Albums (groupedId)
      │
      ▼
Layer 1 Local Filter (No network: checks inline buttons, ad/betting keywords, minimum length)
      │
      ▼
Layer 2 Gemini Gate & Article Generation (AdSense safety gate, Bengali SEO article, slug, dateline, H2s)
      │
      ▼
Media Pipeline (1200x630 smart attention thumbnail, blurred canvas, FFmpeg video frame, SVG banner)
      │
      ▼
WordPress REST API (Media upload with alt text, category & tag match/create, "আরও পড়ুন" internal links)
      │
      ▼
Publish Post & Atomic State Update (lastProcessedId updated in state.json)
```

---

## License

ISC License.
