import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import ffmpegPath from 'ffmpeg-static';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

/**
 * Escapes characters for safe inclusion in SVG text nodes.
 */
export function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Word wraps text into lines based on approximate character width.
 */
export function wrapBengaliText(text: string, maxCharsPerLine = 24): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
    } else if (currentLine.length + 1 + word.length <= maxCharsPerLine) {
      currentLine += ` ${word}`;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Creates a 1200x630 featured thumbnail from an input image buffer.
 * - Landscape (aspect ratio >= ~1.35): attention-based smart crop.
 * - Vertical or square: blurred canvas background + centered foreground.
 */
export async function createFeaturedThumbnail(
  imageBuffer: Buffer,
  width = 1200,
  height = 630
): Promise<Buffer> {
  const rotated = sharp(imageBuffer).rotate();
  const meta = await rotated.metadata();

  const imgW = meta.width || width;
  const imgH = meta.height || height;
  const aspectRatio = imgW / imgH;

  // Landscape source
  if (aspectRatio >= 1.35) {
    return sharp(imageBuffer)
      .rotate()
      .resize(width, height, {
        fit: 'cover',
        position: sharp.strategy.attention,
      })
      .jpeg({ quality: 82, progressive: true })
      .toBuffer();
  }

  // Vertical or square source: Blurred background + centered foreground
  const bg = await sharp(imageBuffer)
    .rotate()
    .resize(width, height, { fit: 'cover' })
    .blur(30)
    .modulate({ brightness: 0.65 })
    .toBuffer();

  const fg = await sharp(imageBuffer)
    .rotate()
    .resize(width, height, { fit: 'inside' })
    .toBuffer();

  return sharp(bg)
    .composite([{ input: fg, gravity: 'center' }])
    .jpeg({ quality: 82, progressive: true })
    .toBuffer();
}

/**
 * Resizes body images to a maximum width (default 1200px) with withoutEnlargement.
 */
export async function optimizeBodyImage(
  imageBuffer: Buffer,
  maxWidth = 1200
): Promise<Buffer> {
  return sharp(imageBuffer)
    .rotate()
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality: 80, progressive: true })
    .toBuffer();
}

/**
 * Extracts a representative frame from a video buffer at 1s (or 0s fallback).
 */
export async function extractVideoFrame(videoBuffer: Buffer): Promise<Buffer> {
  const binPath = (typeof ffmpegPath === 'string' ? ffmpegPath : (ffmpegPath as any)?.default) as string;
  if (!binPath) {
    throw new Error('ffmpeg-static binary path not found');
  }

  const tmpDir = os.tmpdir();
  const randomSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const tmpVideo = path.join(tmpDir, `kst_in_${randomSuffix}.mp4`);
  const tmpFrame = path.join(tmpDir, `kst_out_${randomSuffix}.jpg`);

  try {
    await fs.writeFile(tmpVideo, videoBuffer);

    // Try at 1 second
    try {
      await execFileAsync(binPath, [
        '-ss',
        '1',
        '-i',
        tmpVideo,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '-y',
        tmpFrame,
      ]);
    } catch {
      // Fallback: extract at 0s for very short videos
      await execFileAsync(binPath, [
        '-ss',
        '0',
        '-i',
        tmpVideo,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '-y',
        tmpFrame,
      ]);
    }

    return await fs.readFile(tmpFrame);
  } finally {
    await fs.unlink(tmpVideo).catch(() => {});
    await fs.unlink(tmpFrame).catch(() => {});
  }
}

/**
 * Generates a 1200x630 branded SVG breaking news banner for text-only posts.
 */
export async function generateTextBanner(
  headline: string,
  width = 1200,
  height = 630
): Promise<Buffer> {
  // Wrap text
  let fontSize = 48;
  let maxChars = 24;
  if (headline.length > 70) {
    fontSize = 38;
    maxChars = 28;
  } else if (headline.length > 45) {
    fontSize = 42;
    maxChars = 26;
  }

  let lines = wrapBengaliText(headline, maxChars);
  if (lines.length > 4) {
    lines = lines.slice(0, 4);
    lines[3] = `${lines[3].replace(/[.,;:!?]+$/, '')}...`;
  }

  const lineHeight = fontSize * 1.35;
  const totalTextHeight = lines.length * lineHeight;
  const startY = (height - totalTextHeight) / 2 + fontSize * 0.7;

  const textTspans = lines
    .map(
      (line, idx) =>
        `<tspan x="80" y="${Math.round(startY + idx * lineHeight)}">${escapeXml(line)}</tspan>`
    )
    .join('\n      ');

  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0c1220" />
      <stop offset="60%" stop-color="#141d33" />
      <stop offset="100%" stop-color="#0a0f1d" />
    </linearGradient>
    <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#d32f2f" />
      <stop offset="100%" stop-color="#ff5252" />
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="100%" height="100%" fill="url(#bgGrad)" />

  <!-- Left Accent Bar -->
  <rect x="0" y="0" width="16" height="100%" fill="url(#accentGrad)" />

  <!-- Top Badge: ব্রেকিং নিউজ -->
  <g transform="translate(80, 70)">
    <rect x="0" y="0" width="160" height="42" rx="6" fill="#d32f2f" />
    <text x="80" y="27" fill="#ffffff" font-family="'Noto Sans Bengali', 'Noto Serif Bengali', sans-serif" font-size="20" font-weight="bold" text-anchor="middle">ব্রেকিং নিউজ</text>
  </g>

  <!-- Headline Text -->
  <text fill="#ffffff" font-family="'Noto Sans Bengali', 'Noto Serif Bengali', 'SolaimanLipi', sans-serif" font-size="${fontSize}" font-weight="bold">
      ${textTspans}
  </text>

  <!-- Footer Branding -->
  <line x1="80" y1="${height - 90}" x2="${width - 80}" y2="${height - 90}" stroke="#2a3b5c" stroke-width="2" />
  <g transform="translate(80, ${height - 50})">
    <text x="0" y="0" fill="#e0e6ed" font-family="'Noto Sans Bengali', sans-serif" font-size="22" font-weight="bold">
      KSTNews24 <tspan fill="#889bb5" font-size="18" font-weight="normal">• kstnews24.com</tspan>
    </text>
  </g>
</svg>`;

  return sharp(Buffer.from(svg))
    .jpeg({ quality: 85, progressive: true })
    .toBuffer();
}

/**
 * Startup font check to verify Bengali glyph rendering.
 */
export async function checkFontSanity(): Promise<boolean> {
  try {
    const testSvg = `<svg width="120" height="40" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#ffffff" />
      <text x="10" y="25" font-family="'Noto Sans Bengali', 'Noto Serif Bengali', sans-serif" font-size="18" fill="#000000">সংবাদ</text>
    </svg>`;

    const buf = await sharp(Buffer.from(testSvg)).png().toBuffer();
    if (buf.length < 200) {
      logger.warn(
        'Bengali font sanity check: Rendered banner size is unexpectedly small. Bengali fonts might be missing.'
      );
      logger.warn(
        'For clean Bengali text, install fonts: sudo apt update && sudo apt install -y fonts-noto-core fonts-beng'
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('Font sanity check failed to render test SVG.');
    logger.warn(
      'If running in Linux/WSL2, install: sudo apt update && sudo apt install -y fonts-noto-core fonts-beng'
    );
    return false;
  }
}
