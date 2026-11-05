import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  evaluateLayer1,
  matchesAdKeywords,
  cleanTextForLengthCheck,
  AD_KEYWORDS_BN,
  AD_KEYWORDS_EN,
} from '../src/filter.js';
import {
  countWords,
  sanitizeHtml,
  sanitizeSlug,
} from '../src/gemini.js';
import {
  createFeaturedThumbnail,
  optimizeBodyImage,
  generateTextBanner,
  checkFontSanity,
  wrapBengaliText,
  escapeXml,
  extractVideoFrame,
} from '../src/media.js';
import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import {
  getDefaultState,
  loadState,
  saveState,
  markProcessed,
  isAlreadyProcessed,
  recordFailure,
  resetState,
  AppState,
} from '../src/state.js';
import { buildInternalLinksBox, WordPressClient } from '../src/wordpress.js';
import { processUnit, PipelineContext } from '../src/pipeline.js';
import { PostUnit } from '../src/telegram.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  \x1b[31m✖\x1b[0m ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n\x1b[1m=== Running KSTNews24 AutoPilot Test Suite ===\x1b[0m\n');

  // ==========================================
  // 1. FILTER & AD-BLOCKING TESTS (Layer 1)
  // ==========================================
  console.log('\x1b[36m--- 1. Filter & Guardrails (Layer 1) ---\x1b[0m');

  await test('Rejects inline buttons', () => {
    const res = evaluateLayer1({
      text: 'যথাযথ সংবাদ প্রতিবেদন কিন্তু এতে বোতাম রয়েছে।',
      hasPhoto: true,
      hasVideo: false,
      hasInlineButtons: true,
    });
    assert.equal(res.pass, false);
    assert.match(res.reason!, /inline buttons/);
  });

  await test('Detects Bengali betting & casino keywords', () => {
    const testCases = [
      'নতুন ক্যাসিনো সাইটে ১০০% বোনাস নিন!',
      'আজকের সেরা বেটিং টিপস দেখে নিন',
      'অনলাইন জুয়া খেলার নির্ভরযোগ্য প্ল্যাটফর্ম',
      'প্রমো কোড ব্যবহার করলেই পাচ্ছেন স্পেশাল বোনাস',
      'লটারি জিতে কোটিপতি হওয়ার সুযোগ',
    ];
    for (const text of testCases) {
      const match = matchesAdKeywords(text);
      assert.equal(match.matches, true, `Expected "${text}" to match ad keywords`);
      const res = evaluateLayer1({
        text,
        hasPhoto: true,
        hasVideo: false,
      });
      assert.equal(res.pass, false);
    }
  });

  await test('Detects English betting and promotional tokens', () => {
    const testCases = [
      'Sign up now on 1xbet for 200% bonus',
      'Best casino in Asia! Click link below',
      'Use referral code to register on bet365',
      'Exclusive promo code for new members: WIN50',
      'Join now: t.me/+AbCdEfGh123 for VIP tips',
    ];
    for (const text of testCases) {
      const match = matchesAdKeywords(text);
      assert.equal(match.matches, true, `Expected "${text}" to match English ad keywords`);
      const res = evaluateLayer1({
        text,
        hasPhoto: true,
        hasVideo: false,
      });
      assert.equal(res.pass, false);
    }
  });

  await test('Rejects text under 40 chars when no media attached', () => {
    const shortText = 'সংক্ষিপ্ত খবর মাত্র';
    const res = evaluateLayer1({
      text: shortText,
      hasPhoto: false,
      hasVideo: false,
    });
    assert.equal(res.pass, false);
    assert.match(res.reason!, /too short/);
  });

  await test('Allows short text when media (photo or video) is attached', () => {
    const shortText = 'সংক্ষিপ্ত ক্যাপশন সহ ছবি';
    const res = evaluateLayer1({
      text: shortText,
      hasPhoto: true,
      hasVideo: false,
    });
    assert.equal(res.pass, true);
  });

  await test('Rejects text containing only URLs or hashtags without media', () => {
    const onlyUrls = 'https://example.com/news https://t.me/channel #breaking #news';
    const res = evaluateLayer1({
      text: onlyUrls,
      hasPhoto: false,
      hasVideo: false,
    });
    assert.equal(res.pass, false);
    assert.match(res.reason!, /only URLs/);
  });

  await test('Rejects unsupported media (stickers/polls) without photo or video', () => {
    const res = evaluateLayer1({
      text: 'ভোট দিন আজকের জরিপে',
      hasPhoto: false,
      hasVideo: false,
      hasUnsupportedMedia: true,
    });
    assert.equal(res.pass, false);
    assert.match(res.reason!, /unsupported media/);
  });

  await test('Passes legitimate news text with photo', () => {
    const newsText =
      'জাতীয় সংসদে আগামী অর্থবছরের বাজেট উপস্থাপন করা হয়েছে। অর্থমন্ত্রী বিস্তারিত তথ্য তুলে ধরেন।';
    const res = evaluateLayer1({
      text: newsText,
      hasPhoto: true,
      hasVideo: false,
    });
    assert.equal(res.pass, true);
  });

  // ==========================================
  // 2. GEMINI TEXT & HTML SANITIZATION TESTS
  // ==========================================
  console.log('\n\x1b[36m--- 2. Gemini Sanitization & Formatting ---\x1b[0m');

  await test('Sanitizes HTML: strips script, style, and event handlers', () => {
    const dirty = `
      <p>প্রথম প্যারাগ্রাফ <script>alert("hack")</script></p>
      <h2 onclick="malicious()">উপশিরোনাম</h2>
      <style>body { display: none; }</style>
      <p>অন্য প্যারা <a href="javascript:alert(1)">লিঙ্ক</a> এবং <strong>বোল্ড</strong></p>
    `;
    const clean = sanitizeHtml(dirty);
    assert.equal(clean.includes('<script>'), false);
    assert.equal(clean.includes('<style>'), false);
    assert.equal(clean.includes('onclick'), false);
    assert.equal(clean.includes('javascript:'), false);
    assert.equal(clean.includes('<p>প্রথম প্যারাগ্রাফ </p>'), true);
    assert.equal(clean.includes('<h2>উপশিরোনাম</h2>'), true);
    assert.equal(clean.includes('<strong>বোল্ড</strong>'), true);
  });

  await test('Word counter correctly counts Bengali and English words', () => {
    const bnHtml = '<p>ঢাকা মেট্রো রেলের নতুন সময়সূচি ঘোষণা করা হয়েছে।</p> <h2>বিস্তারিত তথ্য</h2>';
    const count = countWords(bnHtml);
    assert.equal(count, 10);
  });

  await test('Sanitizes English slugs correctly', () => {
    const slug1 = sanitizeSlug('Bangladesh Railway New Schedule! 2026');
    assert.equal(slug1, 'bangladesh-railway-new-schedule-2026');

    const longSlug = sanitizeSlug(
      'this-is-a-very-long-headline-that-exceeds-the-sixty-character-limit-imposed-by-seo-standards'
    );
    assert.ok(longSlug.length <= 60);
    assert.equal(longSlug.endsWith('-'), false);
  });

  // ==========================================
  // 3. MEDIA PIPELINE TESTS (Sharp & Banner)
  // ==========================================
  console.log('\n\x1b[36m--- 3. Media Pipeline & Sharp Processing ---\x1b[0m');

  await test('Landscape photo produces 1200x630 attention-cropped thumbnail', async () => {
    // Create dummy landscape image (800x450, ratio 1.77)
    const landscapeInput = await sharp({
      create: {
        width: 800,
        height: 450,
        channels: 3,
        background: { r: 50, g: 120, b: 200 },
      },
    })
      .jpeg()
      .toBuffer();

    const output = await createFeaturedThumbnail(landscapeInput, 1200, 630);
    const meta = await sharp(output).metadata();

    assert.equal(meta.width, 1200);
    assert.equal(meta.height, 630);
    assert.equal(meta.format, 'jpeg');
  });

  await test('Vertical photo produces 1200x630 blurred-canvas thumbnail', async () => {
    // Create dummy vertical image (500x800, ratio 0.625)
    const verticalInput = await sharp({
      create: {
        width: 500,
        height: 800,
        channels: 3,
        background: { r: 200, g: 80, b: 80 },
      },
    })
      .jpeg()
      .toBuffer();

    const output = await createFeaturedThumbnail(verticalInput, 1200, 630);
    const meta = await sharp(output).metadata();

    assert.equal(meta.width, 1200);
    assert.equal(meta.height, 630);
    assert.equal(meta.format, 'jpeg');
  });

  await test('Square photo produces 1200x630 blurred-canvas thumbnail', async () => {
    // Create dummy square image (600x600, ratio 1.0)
    const squareInput = await sharp({
      create: {
        width: 600,
        height: 600,
        channels: 3,
        background: { r: 80, g: 180, b: 80 },
      },
    })
      .jpeg()
      .toBuffer();

    const output = await createFeaturedThumbnail(squareInput, 1200, 630);
    const meta = await sharp(output).metadata();

    assert.equal(meta.width, 1200);
    assert.equal(meta.height, 630);
  });

  await test('Optimizes body images to max width 1200px', async () => {
    const wideInput = await sharp({
      create: {
        width: 2400,
        height: 1600,
        channels: 3,
        background: { r: 100, g: 100, b: 100 },
      },
    })
      .jpeg()
      .toBuffer();

    const output = await optimizeBodyImage(wideInput, 1200);
    const meta = await sharp(output).metadata();

    assert.equal(meta.width, 1200);
  });

  await test('Text-only banner generates branded 1200x630 JPEG', async () => {
    const bannerHeadline = 'ঢাকায় নতুন ফ্লাইওভার উদ্বোধন করলেন প্রধানমন্ত্রী';
    const output = await generateTextBanner(bannerHeadline, 1200, 630);
    const meta = await sharp(output).metadata();

    assert.equal(meta.width, 1200);
    assert.equal(meta.height, 630);
    assert.equal(meta.format, 'jpeg');
  });

  await test('Bengali text wrap splits long headline properly', () => {
    const text = 'বাংলাদেশ জাতীয় ক্রিকেট দল টি-টোয়েন্টি বিশ্বকাপের সেমিফাইনালে অসাধারণ জয় নিশ্চিত করেছে';
    const lines = wrapBengaliText(text, 24);
    assert.ok(lines.length >= 2);
    for (const line of lines) {
      assert.ok(line.length <= 40);
    }
  });

  await test('Font sanity check executes without crashing', async () => {
    const result = await checkFontSanity();
    assert.equal(typeof result, 'boolean');
  });

  await test('Extracts frame from video buffer via FFmpeg', async () => {
    const bin = (typeof ffmpegPath === 'string' ? ffmpegPath : (ffmpegPath as any)?.default) as string;
    const testVideoPath = path.resolve('temp_synth.mp4');
    try {
      await execFileAsync(bin, [
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=320x240:rate=10',
        '-pix_fmt',
        'yuv420p',
        '-y',
        testVideoPath,
      ]);
      const videoBuffer = await fs.readFile(testVideoPath);
      const frame = await extractVideoFrame(videoBuffer);
      assert.ok(frame.length > 0, 'Extracted frame should not be empty');
      const meta = await sharp(frame).metadata();
      assert.equal(meta.width, 320);
      assert.equal(meta.height, 240);
    } finally {
      await fs.unlink(testVideoPath).catch(() => {});
    }
  });

  // ==========================================
  // 4. STATE MANAGEMENT TESTS
  // ==========================================
  console.log('\n\x1b[36m--- 4. State Management (Atomic & Resumable) ---\x1b[0m');

  const testStateFile = path.resolve('test-state.json');

  await test('Initial state loads defaults if file missing', async () => {
    await fs.unlink(testStateFile).catch(() => {});
    const state = await loadState('basherkella', testStateFile);
    assert.equal(state.channel, 'basherkella');
    assert.equal(state.lastProcessedId, 0);
    assert.equal(state.processed.length, 0);
  });

  await test('Atomic state save and reload', async () => {
    const state = getDefaultState('basherkella');
    state.lastProcessedId = 150;
    state.history.push({
      runAt: new Date().toISOString(),
      mode: 'sync',
      published: 1,
      skipped: 2,
      failed: 0,
    });

    await saveState(state, testStateFile);
    const loaded = await loadState('basherkella', testStateFile);
    assert.equal(loaded.lastProcessedId, 150);
    assert.equal(loaded.history.length, 1);
  });

  await test('markProcessed advances lastProcessedId on publish or skip', async () => {
    const state = getDefaultState('basherkella');
    state.lastProcessedId = 100;

    // Published entry
    await markProcessed(
      state,
      { messageIds: [105], wpPostId: 999, status: 'publish' },
      105,
      testStateFile
    );
    assert.equal(state.lastProcessedId, 105);

    // Skipped entry
    await markProcessed(
      state,
      { messageIds: [110], status: 'skipped', reason: 'ad keyword' },
      110,
      testStateFile
    );
    assert.equal(state.lastProcessedId, 110);
  });

  await test('markProcessed does NOT advance on first/second failure, but advances on 3rd failure', async () => {
    const state = getDefaultState('basherkella');
    state.lastProcessedId = 110;

    // Failure 1
    await markProcessed(
      state,
      { messageIds: [115], status: 'failed', reason: 'Network timeout' },
      115,
      testStateFile
    );
    assert.equal(state.lastProcessedId, 110, 'lastProcessedId must not advance on fail 1');

    // Failure 2
    await markProcessed(
      state,
      { messageIds: [115], status: 'failed', reason: 'Network timeout' },
      115,
      testStateFile
    );
    assert.equal(state.lastProcessedId, 110, 'lastProcessedId must not advance on fail 2');

    // Failure 3
    await markProcessed(
      state,
      { messageIds: [115], status: 'failed', reason: 'Network timeout' },
      115,
      testStateFile
    );
    assert.equal(state.lastProcessedId, 115, 'lastProcessedId must advance after 3 failures');

    // Clean up test state file
    await fs.unlink(testStateFile).catch(() => {});
    await fs.unlink(`${testStateFile}.tmp`).catch(() => {});
  });

  await test('isAlreadyProcessed prevents duplicate post handling', () => {
    const state = getDefaultState('basherkella');
    state.processed.push({
      messageIds: [201, 202],
      wpPostId: 4501,
      status: 'publish',
    });

    const check1 = isAlreadyProcessed(state, [201]);
    assert.ok(check1);
    assert.equal(check1?.wpPostId, 4501);

    const check2 = isAlreadyProcessed(state, [999]);
    assert.equal(check2, undefined);
  });

  // ==========================================
  // 5. WORDPRESS CLIENT & INTERNAL LINKS TESTS
  // ==========================================
  console.log('\n\x1b[36m--- 5. WordPress Client & Internal Linking ---\x1b[0m');

  await test('buildInternalLinksBox formats "আরও পড়ুন" HTML box correctly', () => {
    const posts = [
      { id: 10, title: 'প্রথম সম্পর্কিত খবর', link: 'https://kstnews24.com/post-10' },
      { id: 11, title: 'দ্বিতীয় সম্পর্কিত খবর <bold>', link: 'https://kstnews24.com/post-11?a=1&b=2' },
    ];
    const box = buildInternalLinksBox(posts);
    assert.ok(box.includes('class="kst-read-more"'));
    assert.ok(box.includes('<strong>আরও পড়ুন</strong>'));
    assert.ok(box.includes('https://kstnews24.com/post-10'));
    assert.ok(box.includes('প্রথম সম্পর্কিত খবর'));
    assert.ok(box.includes('https://kstnews24.com/post-11?a=1&amp;b=2'));
    assert.ok(box.includes('&lt;bold&gt;')); // Escaped HTML
  });

  await test('buildInternalLinksBox returns empty string if no posts exist', () => {
    const box = buildInternalLinksBox([]);
    assert.equal(box, '');
  });

  // ==========================================
  // 6. END-TO-END PIPELINE DRY-RUN TEST
  // ==========================================
  console.log('\n\x1b[36m--- 6. End-to-End Pipeline in Dry-Run Mode ---\x1b[0m');

  await test('Full pipeline executes correctly in dry-run mode without network writes', async () => {
    const dummyConfig = {
      tgApiId: 12345,
      tgApiHash: 'test_hash',
      tgSession: 'test_session',
      tgChannel: 'basherkella',
      geminiApiKey: 'test_key',
      geminiModel: 'gemini-2.5-flash',
      wpUrl: 'https://kstnews24.com',
      wpUsername: 'test_user',
      wpAppPassword: 'test_password',
      wpPostStatus: 'publish' as const,
      thumbWidth: 1200,
      thumbHeight: 630,
      bodyMaxWidth: 1200,
      maxVideoMb: 25,
      firstRunLimit: 10,
    };

    const mockState = getDefaultState('basherkella');

    // Create a mock Telegram service
    const mockTelegram: any = {
      downloadMedia: async () => ({
        buffer: await sharp({
          create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 100, b: 150 } },
        })
          .jpeg()
          .toBuffer(),
        isThumbnailOnly: false,
      }),
    };

    // Create a mock Gemini service
    const mockGemini: any = {
      processPost: async () => ({
        verdict: 'publish',
        title: 'টেস্ট সংবাদ শিরোনাম',
        dateline: 'ঢাকা, ৫ নভেম্বর:',
        bodyHtml: '<p>এটি একটি সম্পূর্ণ সফল টেস্ট সংবাদের মূল অংশ।</p><h2>উপশিরোনাম ১</h2><p>আরও বিস্তারিত তথ্য এখানে রয়েছে।</p>',
        slug: 'test-news-headline',
        excerpt: 'টেস্ট সংবাদের সংক্ষিপ্ত বিবরণী।',
        category: 'জাতীয়',
        tags: ['টেস্ট', 'সংবাদ'],
        imageAltText: 'টেস্ট ছবি ক্যাপশন',
        bannerHeadline: 'টেস্ট সংবাদ শিরোনাম',
      }),
    };

    // Create a mock WordPress client
    const mockWp: any = {
      listCategories: async () => [{ id: 1, name: 'জাতীয়', slug: 'national' }],
      uploadMedia: async () => {
        throw new Error('Should NOT be called during dry-run!');
      },
      createPost: async () => {
        throw new Error('Should NOT be called during dry-run!');
      },
      resolveCategory: async () => 1,
      resolveTags: async () => [101, 102],
      getRecentPosts: async () => [],
    };

    const dummyUnit: PostUnit = {
      id: 501,
      messageIds: [501],
      text: 'এটি একটি বৈধ জাতীয় সংবাদ প্রতিবেদন যাতে দেশের গুরুত্বপূর্ণ তথ্য রয়েছে।',
      date: new Date(),
      mediaItems: [
        {
          kind: 'photo',
          rawMessage: {} as any,
        },
      ],
      mediaKind: 'photo',
      hasInlineButtons: false,
      hasUnsupportedMedia: false,
    };

    const ctx: PipelineContext = {
      config: dummyConfig,
      state: mockState,
      telegram: mockTelegram,
      gemini: mockGemini,
      wordpress: mockWp,
      dryRun: true,
      noState: true,
    };

    const result = await processUnit(dummyUnit, ctx);
    assert.equal(result.outcome, 'published');
    assert.ok(result.url?.includes('test-news-headline'));
  });

  // ==========================================
  // SUMMARY
  // ==========================================
  console.log('\n\x1b[1m=== Test Results ===\x1b[0m');
  console.log(`  Total:  ${passed + failed}`);
  console.log(`  Passed: \x1b[32m${passed}\x1b[0m`);
  console.log(`  Failed: \x1b[31m${failed}\x1b[0m\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
