import { TelegramClient, Api, errors } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import input from 'input';
import { AppConfig } from './config.js';
import { logger } from './logger.js';

export type MediaKind = 'photo' | 'video' | 'album' | 'other' | 'none';

export interface TelegramMediaItem {
  kind: 'photo' | 'video' | 'other';
  rawMessage: Api.Message;
  fileSizeBytes?: number;
  mimeType?: string;
}

export interface PostUnit {
  id: number; // Highest message ID in unit
  messageIds: number[];
  text: string;
  date: Date;
  mediaItems: TelegramMediaItem[];
  mediaKind: MediaKind;
  hasInlineButtons: boolean;
  hasUnsupportedMedia: boolean;
  forwardedFromTitle?: string;
  forwardedFromUsername?: string;
}

export class TelegramService {
  private client: TelegramClient;
  private config: AppConfig;
  private channelEntity: any = null;

  constructor(config: AppConfig) {
    this.config = config;
    const session = new StringSession(config.tgSession || '');
    this.client = new TelegramClient(session, config.tgApiId, config.tgApiHash, {
      connectionRetries: 5,
    });
  }

  /**
   * Connects to Telegram. If session is blank, launches interactive login.
   */
  async connect(): Promise<void> {
    try {
      if (!this.config.tgSession) {
        logger.info('TG_SESSION is empty. Starting interactive terminal login...');
        await this.client.start({
          phoneNumber: async () => await input.text('Enter your Telegram phone number (with country code): '),
          password: async () => await input.password('Enter your 2FA password (leave empty if none): '),
          phoneCode: async () => await input.text('Enter the login code you received: '),
          onError: (err) => logger.error('Telegram authentication error:', err),
        });

        const savedSession = (this.client.session as any).save();
        logger.success('Interactive login succeeded!');
        console.log('\n================== TELEGRAM SESSION STRING ==================');
        console.log(savedSession);
        console.log('=============================================================\n');
        logger.info('Copy and paste the session string above into your .env file as:');
        logger.info(`TG_SESSION=${savedSession}\n`);
      } else {
        await this.client.connect();
        const isAuth = await this.client.isUserAuthorized();
        if (!isAuth) {
          throw new Error(
            'Telegram session expired or revoked. Please clear TG_SESSION in .env and run again to re-authenticate.'
          );
        }
      }

      logger.info(`Resolving channel @${this.config.tgChannel}...`);
      this.channelEntity = await this.client.getEntity(this.config.tgChannel);
      logger.success(`Connected to Telegram channel: @${this.config.tgChannel}`);
    } catch (err: any) {
      if (err instanceof errors.FloodWaitError) {
        logger.warn(`Telegram FloodWait: must wait ${err.seconds} seconds.`);
        await new Promise((res) => setTimeout(res, (err.seconds + 1) * 1000));
        return this.connect();
      }
      throw err;
    }
  }

  /**
   * Disconnects Telegram client.
   */
  async disconnect(): Promise<void> {
    try {
      await this.client.disconnect();
    } catch {
      // Ignore disconnect errors
    }
  }

  /**
   * Fetches unread messages chronologically.
   * If lastProcessedId == 0, applies FIRST_RUN_LIMIT rule.
   */
  async fetchUnread(lastProcessedId: number, limitOverride?: number): Promise<PostUnit[]> {
    const rawMessages: Api.Message[] = [];

    if (lastProcessedId === 0) {
      const fetchLimit = limitOverride || this.config.firstRunLimit;
      logger.info(
        `First run detected (lastProcessedId == 0). Fetching latest ${fetchLimit} messages...`
      );
      const messages = await this.client.getMessages(this.channelEntity, {
        limit: fetchLimit,
      });
      // getMessages returns descending (newest first). Reverse to make oldest first.
      rawMessages.push(...[...messages].reverse() as Api.Message[]);
    } else {
      logger.info(`Fetching unread messages newer than #${lastProcessedId}...`);
      const iter = this.client.iterMessages(this.channelEntity, {
        minId: lastProcessedId,
        reverse: true, // Oldest first
        limit: limitOverride,
      });

      for await (const msg of iter) {
        rawMessages.push(msg as Api.Message);
      }
    }

    return this.groupMessagesIntoUnits(rawMessages);
  }

  /**
   * Inspects a single message to classify media and flags.
   */
  inspectMessage(msg: Api.Message): {
    mediaItem?: TelegramMediaItem;
    hasInlineButtons: boolean;
    hasUnsupportedMedia: boolean;
    forwardedTitle?: string;
    forwardedUsername?: string;
  } {
    let hasInlineButtons = false;
    if (msg.replyMarkup && msg.replyMarkup instanceof Api.ReplyInlineMarkup) {
      if (Array.isArray(msg.replyMarkup.rows) && msg.replyMarkup.rows.length > 0) {
        hasInlineButtons = true;
      }
    }

    let hasUnsupportedMedia = false;
    let mediaItem: TelegramMediaItem | undefined;

    if (msg.media) {
      if (msg.media instanceof Api.MessageMediaPhoto) {
        mediaItem = {
          kind: 'photo',
          rawMessage: msg,
        };
      } else if (msg.media instanceof Api.MessageMediaDocument) {
        const doc = msg.media.document as Api.Document | undefined;
        const mime = doc?.mimeType || '';
        const isVideo =
          mime.startsWith('video/') ||
          doc?.attributes?.some((a) => a instanceof Api.DocumentAttributeVideo);

        if (isVideo) {
          mediaItem = {
            kind: 'video',
            rawMessage: msg,
            fileSizeBytes: doc?.size ? Number(doc.size) : undefined,
            mimeType: mime || 'video/mp4',
          };
        } else {
          hasUnsupportedMedia = true;
          mediaItem = {
            kind: 'other',
            rawMessage: msg,
          };
        }
      } else {
        // Poll, Contact, Geo, Sticker, etc.
        hasUnsupportedMedia = true;
        mediaItem = {
          kind: 'other',
          rawMessage: msg,
        };
      }
    }

    // Forward check
    let forwardedTitle: string | undefined;
    let forwardedUsername: string | undefined;
    if (msg.fwdFrom) {
      forwardedTitle = msg.fwdFrom.fromName || undefined;
    }

    return {
      mediaItem,
      hasInlineButtons,
      hasUnsupportedMedia,
      forwardedTitle,
      forwardedUsername,
    };
  }

  /**
   * Groups sequential messages sharing groupedId into single PostUnits.
   */
  groupMessagesIntoUnits(messages: Api.Message[]): PostUnit[] {
    const units: PostUnit[] = [];
    const groupedMap = new Map<string, Api.Message[]>();
    const order: Array<{ type: 'single'; msg: Api.Message } | { type: 'group'; groupId: string }> = [];

    for (const msg of messages) {
      if (msg.groupedId) {
        const key = msg.groupedId.toString();
        if (!groupedMap.has(key)) {
          groupedMap.set(key, []);
          order.push({ type: 'group', groupId: key });
        }
        groupedMap.get(key)!.push(msg);
      } else {
        order.push({ type: 'single', msg });
      }
    }

    for (const item of order) {
      if (item.type === 'single') {
        const inspected = this.inspectMessage(item.msg);
        const mediaItems: TelegramMediaItem[] = [];
        if (inspected.mediaItem) {
          mediaItems.push(inspected.mediaItem);
        }

        let mediaKind: MediaKind = 'none';
        if (mediaItems.length > 0) {
          mediaKind = mediaItems[0].kind;
        }

        units.push({
          id: item.msg.id,
          messageIds: [item.msg.id],
          text: item.msg.message?.trim() || '',
          date: new Date(item.msg.date * 1000),
          mediaItems,
          mediaKind,
          hasInlineButtons: inspected.hasInlineButtons,
          hasUnsupportedMedia: inspected.hasUnsupportedMedia,
          forwardedFromTitle: inspected.forwardedTitle,
          forwardedFromUsername: inspected.forwardedUsername,
        });
      } else {
        const groupMsgs = groupedMap.get(item.groupId)!;
        // Group properties
        const messageIds = groupMsgs.map((m) => m.id);
        const maxId = Math.max(...messageIds);
        // Unit's text is the first non-empty caption
        const text = groupMsgs.find((m) => m.message?.trim())?.message?.trim() || '';
        const newestDate = new Date(Math.max(...groupMsgs.map((m) => m.date)) * 1000);

        let hasInlineButtons = false;
        let hasUnsupportedMedia = false;
        const mediaItems: TelegramMediaItem[] = [];
        let forwardedFromTitle: string | undefined;
        let forwardedFromUsername: string | undefined;

        for (const m of groupMsgs) {
          const inspected = this.inspectMessage(m);
          if (inspected.hasInlineButtons) hasInlineButtons = true;
          if (inspected.hasUnsupportedMedia) hasUnsupportedMedia = true;
          if (inspected.mediaItem) mediaItems.push(inspected.mediaItem);
          if (inspected.forwardedTitle) forwardedFromTitle = inspected.forwardedTitle;
          if (inspected.forwardedUsername) forwardedFromUsername = inspected.forwardedUsername;
        }

        const mediaKind: MediaKind = mediaItems.length > 1 ? 'album' : mediaItems[0]?.kind || 'none';

        units.push({
          id: maxId,
          messageIds,
          text,
          date: newestDate,
          mediaItems,
          mediaKind,
          hasInlineButtons,
          hasUnsupportedMedia,
          forwardedFromTitle,
          forwardedFromUsername,
        });
      }
    }

    return units;
  }

  /**
   * Downloads media for a Telegram media item.
   * If video exceeds maxVideoMb, downloads only video thumbnail.
   */
  async downloadMedia(
    item: TelegramMediaItem
  ): Promise<{ buffer: Buffer; isThumbnailOnly?: boolean }> {
    const maxBytes = this.config.maxVideoMb * 1024 * 1024;

    if (item.kind === 'video' && item.fileSizeBytes && item.fileSizeBytes > maxBytes) {
      logger.warn(
        `Video #${item.rawMessage.id} (${(item.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB) exceeds MAX_VIDEO_MB (${this.config.maxVideoMb} MB). Downloading thumbnail only.`
      );
      // Download thumbnail
      const thumbBuffer = (await this.client.downloadMedia(item.rawMessage, {
        thumb: 1,
      })) as Buffer;

      return {
        buffer: thumbBuffer,
        isThumbnailOnly: true,
      };
    }

    const buffer = (await this.client.downloadMedia(item.rawMessage, {})) as Buffer;
    return { buffer, isThumbnailOnly: false };
  }

  /**
   * Listens for live messages with album buffering and sequential dispatch.
   */
  listen(onUnit: (unit: PostUnit) => Promise<void>): void {
    const pendingAlbums = new Map<string, { msgs: Api.Message[]; timer: NodeJS.Timeout }>();
    const serialQueue: Array<() => Promise<void>> = [];
    let isProcessing = false;

    const processNext = async () => {
      if (isProcessing || serialQueue.length === 0) return;
      isProcessing = true;
      const task = serialQueue.shift()!;
      try {
        await task();
      } catch (err: any) {
        logger.error('Error processing live post unit:', err);
      } finally {
        isProcessing = false;
        processNext();
      }
    };

    const enqueueUnit = (unit: PostUnit) => {
      serialQueue.push(() => onUnit(unit));
      processNext();
    };

    logger.info(`Listening live for new messages on @${this.config.tgChannel}... (Ctrl+C to stop)`);

    this.client.addEventHandler(async (event: any) => {
      const msg = event.message as Api.Message;
      if (!msg) return;

      if (msg.groupedId) {
        const groupId = msg.groupedId.toString();
        const existing = pendingAlbums.get(groupId);

        if (existing) {
          clearTimeout(existing.timer);
          existing.msgs.push(msg);
          existing.timer = setTimeout(() => {
            const buffered = pendingAlbums.get(groupId);
            if (buffered) {
              pendingAlbums.delete(groupId);
              const units = this.groupMessagesIntoUnits(buffered.msgs);
              for (const u of units) {
                enqueueUnit(u);
              }
            }
          }, 2000);
        } else {
          const timer = setTimeout(() => {
            const buffered = pendingAlbums.get(groupId);
            if (buffered) {
              pendingAlbums.delete(groupId);
              const units = this.groupMessagesIntoUnits(buffered.msgs);
              for (const u of units) {
                enqueueUnit(u);
              }
            }
          }, 2000);

          pendingAlbums.set(groupId, { msgs: [msg], timer });
        }
      } else {
        const units = this.groupMessagesIntoUnits([msg]);
        for (const u of units) {
          enqueueUnit(u);
        }
      }
    }, new NewMessage({ chats: [this.channelEntity] }));
  }
}
