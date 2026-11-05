# Project Plan: KSTNews24 Manual CLI AutoPilot

**KSTNews24 AI AutoPilot** is a command-line tool built with Node.js and TypeScript. When launched manually in your terminal, it connects to Telegram, catches up on any unread posts from your target channel, filters out advertisements, rewrites breaking updates into search-optimized Bengali news articles using Gemini 2.5 Flash, formats media for Google Discover, and publishes directly to **kstnews24.com** via the WordPress REST API.

---

## 1. System Architecture & Tech Stack

| Component | Package | Purpose |
| --- | --- | --- |
| Runtime | Node.js & TypeScript | Local CLI execution |
| Telegram Client | `telegram` | MTProto fetcher and live stream |
| AI Engine | `@google/genai` | Gemini 2.5 Flash JSON rewriter |
| Image Processor | `sharp` | Thumbnail resizing and banners |
| Video Processor | `ffmpeg-static` | Video frame extraction |
| CLI Input | `input` | Interactive terminal prompts |

All state tracking is stored locally in a flat **state.json** file, requiring zero databases, background daemons, or web servers.

---

## 2. Project Directory Structure

```text
kstnews-cli/
├── src/
│   ├── config.ts          # Loads and validates .env variables
│   ├── state.ts           # Reads and updates lastMessageId in state.json
│   ├── logger.ts          # Color-coded terminal output formatting
│   ├── filter.ts          # Layer 1 spam, inline-button, and ad keyword filter
│   ├── gemini.ts          # Layer 2 AdSense check and SEO Bengali article generator
│   ├── media.ts           # Sharp image resizer, SVG banner maker, and FFmpeg extractor
│   ├── wordpress.ts       # WP REST API uploader, taxonomy resolver, and publisher
│   ├── telegram.ts        # GramJS catch-up fetcher and album grouping logic
│   └── cli.ts             # Main CLI entrypoint and command argument parser
├── state.json             # Stores lastProcessedId and CLI run history
├── .env                   # API keys and WordPress credentials
├── package.json           # Dependencies and CLI run scripts
└── tsconfig.json          # TypeScript configuration

```

---

## 3. Manual CLI Execution Modes

You control the tool entirely from your terminal using standard npm scripts and stops via `Ctrl + C`:

| Command | Mode | Behavior |
| --- | --- | --- |
| `npm run sync` | One-Shot Sync | Publishes unread posts and exits |
| `npm run watch` | Live Watch | Syncs missed posts then listens live |
| `npm run draft` | Draft Test | Saves unread posts as WP drafts |
| `npm run reset` | State Reset | Clears saved message ID history |

* **One-Shot Sync (`npm run sync`):** Ideal when you open your laptop, want to pull the latest posts from **basherkella**, publish them to WordPress, and immediately close the terminal.
* **Live Watch (`npm run watch`):** First catches up on missed posts, then keeps the terminal active to publish breaking news in real time until you press `Ctrl + C`.
* **Draft Test (`npm run draft`):** Runs a one-shot sync but overrides the WordPress status to draft so you can inspect formatting inside **wp-admin** before publishing.

---

## 4. Core Pipeline Workflow

1. **State Check & Catch-Up:**
* Reads **state.json** to find the last processed Telegram message ID.
* Fetches unread messages from the target channel, groups multi-photo or video albums sharing a `groupedId`, and processes them chronologically.


2. **Two-Layer Ad & AdSense Gatekeeper:**
* **Layer 1 (Local Filter):** Immediately skips posts containing inline call-to-action buttons, betting promotions, or advertisement keywords.
* **Layer 2 (Gemini Gate):** Checks editorial validity and Google AdSense compliance, rejecting graphic violence, blood, or adult content.


3. **SEO Article Generation:**
* Rewrites valid posts into original Bengali news reports (300 to 400 words) featuring a location dateline, H2 subheadings, an English URL slug, a meta description excerpt, categories, and tags.


4. **Automated Media Pipeline:**
* **Photo Posts:** Formats the first photo into a 1200 by 630 pixel Featured Thumbnail (smart attention crop for landscape photos; blurred background canvas for vertical or square photos). Optimizes extra body images to a maximum width of 1200 pixels.
* **Video-Only Posts:** Extracts a frame at the one-second mark via FFmpeg, resizes it to a 1200 by 630 pixel Featured Thumbnail, and uploads the MP4 video (up to 25 MB) to embed in the post body.
* **Text-Only Posts:** Generates a 1200 by 630 pixel branded Bengali breaking-news banner with the headline using Sharp SVG compositing.


5. **WordPress Publishing & Internal Linking:**
* Uploads media buffers to the WordPress Media Library with Bengali alt text.
* Matches or creates categories and tags via the WordPress REST API.
* Queries two recent articles from the same category to embed an internal "আরও পড়ুন" (Read More) box.
* Publishes the article, prints the live URL in the terminal, and saves the new message ID to **state.json**.



---

## 5. Step-by-Step Implementation Plan

### Phase 1: Credentials & Font Setup

1. Obtain your Telegram API ID and Hash from the Telegram API development portal.
2. Generate a free Gemini API key from Google AI Studio.
3. Create a WordPress Application Password under **Users → Profile** in your WordPress dashboard.
4. If using WSL2 Ubuntu, install Bengali fonts once so Sharp renders Bengali script cleanly on fallback banners:
```bash
sudo apt update && sudo apt install -y fonts-noto-core fonts-beng

```



### Phase 2: Project Initialization

Open your IDE terminal and install the slim CLI dependency stack:

```bash
mkdir kstnews-cli && cd kstnews-cli
npm init -y
npm install telegram @google/genai sharp ffmpeg-static dotenv input
npm install -D typescript @types/node tsx
npx tsc --init

```

### Phase 3: Configure Scripts & Environment

Add the CLI commands to your **package.json**:

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

Create your **.env** file in the project root:

```env
TG_API_ID=your_api_id
TG_API_HASH=your_api_hash
TG_SESSION=
TG_CHANNEL=basherkella

GEMINI_API_KEY=your_gemini_api_key

WP_URL=https://kstnews24.com
WP_USERNAME=your_wp_username
WP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx
WP_POST_STATUS=publish

THUMB_WIDTH=1200
THUMB_HEIGHT=630
BODY_MAX_WIDTH=1200

```

### Phase 4: First-Time Login & Daily Workflow

1. Run `npm run draft` in your terminal for the initial run.
2. Enter your Telegram phone number and OTP code in the interactive CLI prompt.
3. Copy the printed session string from the terminal into your **.env** file under `TG_SESSION`.
4. Whenever you want to publish new updates, open your terminal and run `npm run sync` (for a quick one-time batch) or `npm run watch` (to stream live updates while you work).