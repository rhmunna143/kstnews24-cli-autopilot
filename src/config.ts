import dotenv from 'dotenv';
import { logger } from './logger.js';

// Load .env file
dotenv.config();

export interface AppConfig {
  tgApiId: number;
  tgApiHash: string;
  tgSession: string;
  tgChannel: string;

  geminiApiKey: string;
  geminiModel: string;

  wpUrl: string;
  wpUsername: string;
  wpAppPassword: string;
  wpPostStatus: 'publish' | 'draft' | 'pending';

  thumbWidth: number;
  thumbHeight: number;
  bodyMaxWidth: number;
  maxVideoMb: number;
  firstRunLimit: number;
}

export interface ConfigOverrides {
  draft?: boolean;
}

export function maskSecret(secret?: string, visibleChars = 4): string {
  if (!secret) return '(empty)';
  if (secret.length <= visibleChars) return '****';
  return `${secret.slice(0, visibleChars)}...****...${secret.slice(-visibleChars)}`;
}

export function loadConfig(overrides?: ConfigOverrides): AppConfig {
  const errors: string[] = [];

  // Telegram
  const rawApiId = process.env.TG_API_ID?.trim() || '';
  const tgApiId = Number(rawApiId);
  if (!rawApiId || isNaN(tgApiId) || tgApiId <= 0) {
    errors.push('TG_API_ID is required and must be a positive integer.');
  }

  const tgApiHash = process.env.TG_API_HASH?.trim() || '';
  if (!tgApiHash) {
    errors.push('TG_API_HASH is required.');
  }

  const tgSession = process.env.TG_SESSION?.trim() || '';
  let tgChannel = process.env.TG_CHANNEL?.trim() || 'basherkella';
  if (tgChannel.startsWith('@')) {
    tgChannel = tgChannel.slice(1);
  }
  if (!tgChannel) {
    errors.push('TG_CHANNEL must be a valid channel username.');
  }

  // Gemini
  const geminiApiKey = process.env.GEMINI_API_KEY?.trim() || '';
  if (!geminiApiKey) {
    errors.push('GEMINI_API_KEY is required.');
  }
  const geminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';

  // WordPress
  let wpUrl = process.env.WP_URL?.trim() || 'https://kstnews24.com';
  if (!wpUrl) {
    errors.push('WP_URL is required.');
  } else {
    // Strip trailing slashes
    wpUrl = wpUrl.replace(/\/+$/, '');
    try {
      new URL(wpUrl);
    } catch {
      errors.push(`WP_URL is not a valid URL: "${wpUrl}"`);
    }
  }

  const wpUsername = process.env.WP_USERNAME?.trim() || '';
  if (!wpUsername) {
    errors.push('WP_USERNAME is required.');
  }

  const wpAppPassword = process.env.WP_APP_PASSWORD?.trim() || '';
  if (!wpAppPassword) {
    errors.push('WP_APP_PASSWORD is required.');
  }

  let wpPostStatus: 'publish' | 'draft' | 'pending' = 'publish';
  const rawStatus = (process.env.WP_POST_STATUS?.trim().toLowerCase() || 'publish') as any;
  if (['publish', 'draft', 'pending'].includes(rawStatus)) {
    wpPostStatus = rawStatus;
  } else {
    errors.push(`WP_POST_STATUS must be "publish", "draft", or "pending" (got: "${rawStatus}").`);
  }

  // CLI override for --draft
  if (overrides?.draft) {
    wpPostStatus = 'draft';
  }

  // Numeric sizing & limits
  const parseNum = (val: string | undefined, defaultVal: number, keyName: string): number => {
    if (val === undefined || val.trim() === '') return defaultVal;
    const n = Number(val);
    if (isNaN(n) || n <= 0) {
      errors.push(`${keyName} must be a positive number (got: "${val}").`);
      return defaultVal;
    }
    return n;
  };

  const thumbWidth = parseNum(process.env.THUMB_WIDTH, 1200, 'THUMB_WIDTH');
  const thumbHeight = parseNum(process.env.THUMB_HEIGHT, 630, 'THUMB_HEIGHT');
  const bodyMaxWidth = parseNum(process.env.BODY_MAX_WIDTH, 1200, 'BODY_MAX_WIDTH');
  const maxVideoMb = parseNum(process.env.MAX_VIDEO_MB, 25, 'MAX_VIDEO_MB');
  const firstRunLimit = parseNum(process.env.FIRST_RUN_LIMIT, 10, 'FIRST_RUN_LIMIT');

  if (errors.length > 0) {
    logger.error('Configuration validation failed:');
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    console.error('\nPlease update your .env file or reference .env.example.');
    process.exit(1);
  }

  return {
    tgApiId,
    tgApiHash,
    tgSession,
    tgChannel,
    geminiApiKey,
    geminiModel,
    wpUrl,
    wpUsername,
    wpAppPassword,
    wpPostStatus,
    thumbWidth,
    thumbHeight,
    bodyMaxWidth,
    maxVideoMb,
    firstRunLimit,
  };
}
