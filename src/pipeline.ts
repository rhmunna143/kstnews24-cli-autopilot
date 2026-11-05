import { AppConfig } from './config.js';
import { AppState, markProcessed, isAlreadyProcessed } from './state.js';
import { logger } from './logger.js';
import { PostUnit, TelegramService } from './telegram.js';
import { evaluateLayer1, PostUnitMeta } from './filter.js';
import { GeminiService, GeminiResult } from './gemini.js';
import { WordPressClient, buildInternalLinksBox, WpRecentPost } from './wordpress.js';
import {
  createFeaturedThumbnail,
  optimizeBodyImage,
  extractVideoFrame,
  generateTextBanner,
} from './media.js';

export interface PipelineContext {
  config: AppConfig;
  state: AppState;
  telegram: TelegramService;
  gemini: GeminiService;
  wordpress: WordPressClient;
  draft?: boolean;
  dryRun?: boolean;
  noState?: boolean;
  abortSignal?: AbortSignal;
}

export interface UnitProcessResult {
  outcome: 'published' | 'skipped' | 'failed';
  reason?: string;
  url?: string;
}

/**
 * Orchestrates end-to-end processing of a single PostUnit.
 */
export async function processUnit(
  unit: PostUnit,
  ctx: PipelineContext
): Promise<UnitProcessResult> {
  const { config, state, telegram, gemini, wordpress, draft, dryRun, noState, abortSignal } =
    ctx;

  if (abortSignal?.aborted) {
    logger.warn(`Unit #${unit.id} aborted before execution started.`);
    return { outcome: 'failed', reason: 'Aborted by operator (SIGINT)' };
  }

  // 0. Duplicate check against state
  const already = isAlreadyProcessed(state, unit.messageIds);
  if (already) {
    logger.skip(unit.id, `already processed (WP Post #${already.wpPostId})`);
    return {
      outcome: 'skipped',
      reason: `already processed (#${already.wpPostId})`,
      url: already.url,
    };
  }

  try {
    // 1. Layer 1 Filter
    const filterMeta: PostUnitMeta = {
      text: unit.text,
      hasPhoto: unit.mediaItems.some((m) => m.kind === 'photo'),
      hasVideo: unit.mediaItems.some((m) => m.kind === 'video'),
      hasUnsupportedMedia: unit.hasUnsupportedMedia,
      hasInlineButtons: unit.hasInlineButtons,
      forwardedFromTitle: unit.forwardedFromTitle,
      forwardedFromUsername: unit.forwardedFromUsername,
    };

    const l1Result = evaluateLayer1(filterMeta);
    if (!l1Result.pass) {
      const reason = l1Result.reason || 'layer1: filter rejected';
      logger.skip(unit.id, reason);
      await markProcessed(
        state,
        { messageIds: unit.messageIds, status: 'skipped', reason },
        unit.id,
        'state.json',
        noState || dryRun
      );
      return { outcome: 'skipped', reason };
    }

    if (abortSignal?.aborted) {
      return { outcome: 'failed', reason: 'Aborted by operator (SIGINT)' };
    }

    // 2. Fetch existing WP categories for Gemini context
    let existingCategoryNames: string[] = [];
    try {
      const cats = await wordpress.listCategories();
      existingCategoryNames = cats.map((c) => c.name);
    } catch {
      // Non-fatal, use empty list
    }

    // 3. Layer 2 Gemini Gate + Article Generation
    logger.step(`[#${unit.id}] Analyzing with Gemini & generating Bengali article...`);
    const dateFormatted = unit.date.toLocaleDateString('bn-BD', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const geminiResult: GeminiResult = await gemini.processPost({
      text: unit.text,
      mediaKind: unit.mediaKind === 'other' ? 'none' : unit.mediaKind,
      dateStr: `${dateFormatted} (${unit.date.toISOString().slice(0, 10)})`,
      existingCategories: existingCategoryNames,
    });

    if (geminiResult.verdict === 'reject') {
      const reason = `layer2: ${geminiResult.rejectReason || 'rejected by editorial gate'}`;
      logger.skip(unit.id, reason);
      await markProcessed(
        state,
        { messageIds: unit.messageIds, status: 'skipped', reason },
        unit.id,
        'state.json',
        noState || dryRun
      );
      return { outcome: 'skipped', reason };
    }

    if (abortSignal?.aborted) {
      return { outcome: 'failed', reason: 'Aborted by operator (SIGINT)' };
    }

    // 4. Download and process media
    logger.step(`[#${unit.id}] Preparing media for article...`);

    let featuredThumbBuffer: Buffer;
    let extraBodyImages: Buffer[] = [];
    let uploadedVideoBuffer: Buffer | null = null;

    const photoItems = unit.mediaItems.filter((m) => m.kind === 'photo');
    const videoItems = unit.mediaItems.filter((m) => m.kind === 'video');

    if (photoItems.length > 0) {
      // Photo post or photo album
      const firstPhotoDownload = await telegram.downloadMedia(photoItems[0]);
      featuredThumbBuffer = await createFeaturedThumbnail(
        firstPhotoDownload.buffer,
        config.thumbWidth,
        config.thumbHeight
      );

      // Extra photos in album: embed up to 5 additional body images
      const extraPhotos = photoItems.slice(1, 6);
      for (const extraItem of extraPhotos) {
        try {
          const dl = await telegram.downloadMedia(extraItem);
          const opt = await optimizeBodyImage(dl.buffer, config.bodyMaxWidth);
          extraBodyImages.push(opt);
        } catch (err: any) {
          logger.warn(`Failed to process extra album photo: ${err.message}`);
        }
      }
    } else if (videoItems.length > 0) {
      // Video post
      const videoDl = await telegram.downloadMedia(videoItems[0]);

      if (videoDl.isThumbnailOnly) {
        // Video exceeded MAX_VIDEO_MB, buffer is thumbnail
        featuredThumbBuffer = await createFeaturedThumbnail(
          videoDl.buffer,
          config.thumbWidth,
          config.thumbHeight
        );
      } else {
        // Video downloaded in full
        uploadedVideoBuffer = videoDl.buffer;
        try {
          const frameBuffer = await extractVideoFrame(videoDl.buffer);
          featuredThumbBuffer = await createFeaturedThumbnail(
            frameBuffer,
            config.thumbWidth,
            config.thumbHeight
          );
        } catch (ffmpegErr: any) {
          logger.warn(
            `FFmpeg frame extraction failed (${ffmpegErr.message}). Falling back to text banner.`
          );
          featuredThumbBuffer = await generateTextBanner(
            geminiResult.bannerHeadline || geminiResult.title!,
            config.thumbWidth,
            config.thumbHeight
          );
        }
      }
    } else {
      // Text-only post -> generate branded SVG banner
      featuredThumbBuffer = await generateTextBanner(
        geminiResult.bannerHeadline || geminiResult.title!,
        config.thumbWidth,
        config.thumbHeight
      );
    }

    if (abortSignal?.aborted) {
      return { outcome: 'failed', reason: 'Aborted by operator (SIGINT)' };
    }

    // 5. Upload media to WordPress (or mock in dry-run)
    let featuredMediaId: number | undefined;
    let featuredMediaUrl = '';
    const bodyImageUrls: string[] = [];
    let videoSourceUrl = '';

    if (dryRun) {
      logger.info(`[#${unit.id}] [DRY-RUN] Would upload featured media (1200x630 JPEG).`);
      featuredMediaId = 10001;
      featuredMediaUrl = 'https://kstnews24.com/wp-content/mock-featured.jpg';

      if (extraBodyImages.length > 0) {
        logger.info(
          `[#${unit.id}] [DRY-RUN] Would upload ${extraBodyImages.length} additional body images.`
        );
        for (let i = 0; i < extraBodyImages.length; i++) {
          bodyImageUrls.push(`https://kstnews24.com/wp-content/mock-body-${i}.jpg`);
        }
      }

      if (uploadedVideoBuffer) {
        logger.info(`[#${unit.id}] [DRY-RUN] Would upload MP4 video.`);
        videoSourceUrl = 'https://kstnews24.com/wp-content/mock-video.mp4';
      }
    } else {
      logger.step(`[#${unit.id}] Uploading media to WordPress...`);
      const thumbFilename = `${geminiResult.slug}-featured-${unit.id}.jpg`;
      const uploadedThumb = await wordpress.uploadMedia(
        featuredThumbBuffer,
        thumbFilename,
        'image/jpeg',
        {
          altText: geminiResult.imageAltText || geminiResult.title,
          title: geminiResult.title,
        }
      );
      featuredMediaId = uploadedThumb.id;
      featuredMediaUrl = uploadedThumb.source_url;

      for (let i = 0; i < extraBodyImages.length; i++) {
        const bodyFilename = `${geminiResult.slug}-body-${unit.id}-${i + 1}.jpg`;
        const uploadedBody = await wordpress.uploadMedia(
          extraBodyImages[i],
          bodyFilename,
          'image/jpeg',
          {
            altText: geminiResult.imageAltText || geminiResult.title,
            title: `${geminiResult.title} - ছবি ${i + 1}`,
          }
        );
        bodyImageUrls.push(uploadedBody.source_url);
      }

      if (uploadedVideoBuffer) {
        const videoFilename = `${geminiResult.slug}-video-${unit.id}.mp4`;
        const uploadedVid = await wordpress.uploadMedia(
          uploadedVideoBuffer,
          videoFilename,
          'video/mp4',
          {
            title: geminiResult.title,
          }
        );
        videoSourceUrl = uploadedVid.source_url;
      }
    }

    if (abortSignal?.aborted) {
      return { outcome: 'failed', reason: 'Aborted by operator (SIGINT)' };
    }

    // 6. Resolve Categories & Tags
    let categoryId = 1;
    let tagIds: number[] = [];

    if (!dryRun) {
      if (geminiResult.category) {
        categoryId = await wordpress.resolveCategory(geminiResult.category);
      }
      if (geminiResult.tags && geminiResult.tags.length > 0) {
        tagIds = await wordpress.resolveTags(geminiResult.tags);
      }
    }

    // 7. Compose Final HTML Content
    let fullHtml = geminiResult.bodyHtml || '';

    // Prefix dateline if present and not already at start of first paragraph
    if (geminiResult.dateline) {
      const cleanDateline = geminiResult.dateline.trim();
      if (!fullHtml.includes(cleanDateline)) {
        if (fullHtml.startsWith('<p>')) {
          fullHtml = `<p><strong>${cleanDateline}</strong> ${fullHtml.slice(3)}`;
        } else {
          fullHtml = `<p><strong>${cleanDateline}</strong></p>\n${fullHtml}`;
        }
      }
    }

    // Insert inline body images
    if (bodyImageUrls.length > 0) {
      const imagesHtml = bodyImageUrls
        .map(
          (url) =>
            `<figure class="wp-block-image size-large"><img src="${url}" alt="${geminiResult.imageAltText || geminiResult.title || ''}"/></figure>`
        )
        .join('\n');

      // Place images after the first <h2> or append if no <h2>
      const h2Index = fullHtml.indexOf('</h2>');
      if (h2Index !== -1) {
        fullHtml = `${fullHtml.slice(0, h2Index + 5)}\n${imagesHtml}\n${fullHtml.slice(h2Index + 5)}`;
      } else {
        fullHtml = `${fullHtml}\n${imagesHtml}`;
      }
    }

    // Embed Video if uploaded
    if (videoSourceUrl) {
      const videoHtml = `\n<figure class="wp-block-video"><video controls preload="metadata" poster="${featuredMediaUrl}"><source src="${videoSourceUrl}" type="video/mp4">আপনার ব্রাউজার ভিডিওটি সমর্থন করে না।</video></figure>`;
      fullHtml += videoHtml;
    }

    // Internal Linking ("আরও পড়ুন" box)
    let recentPosts: WpRecentPost[] = [];
    if (!dryRun) {
      recentPosts = await wordpress.getRecentPosts(categoryId, 2);
    } else {
      recentPosts = [
        { id: 991, title: 'নমুনা সংবাদ ১', link: 'https://kstnews24.com/sample-1' },
        { id: 992, title: 'নমুনা সংবাদ ২', link: 'https://kstnews24.com/sample-2' },
      ];
    }
    const readMoreBox = buildInternalLinksBox(recentPosts);
    if (readMoreBox) {
      fullHtml += readMoreBox;
    }

    // 8. Publish or Draft Post
    const targetStatus = draft ? 'draft' : config.wpPostStatus;

    if (dryRun) {
      const mockUrl = `${config.wpUrl}/${geminiResult.slug}/`;
      logger.info(
        `[#${unit.id}] [DRY-RUN] Would create post: "${geminiResult.title}" (Status: ${targetStatus})`
      );
      logger.info(`[#${unit.id}] [DRY-RUN] URL: ${mockUrl}`);

      return {
        outcome: 'published',
        url: mockUrl,
      };
    }

    logger.step(`[#${unit.id}] Publishing post to WordPress (${targetStatus})...`);
    const created = await wordpress.createPost({
      title: geminiResult.title!,
      content: fullHtml,
      slug: geminiResult.slug!,
      excerpt: geminiResult.excerpt || '',
      categories: [categoryId],
      tags: tagIds,
      featured_media: featuredMediaId,
      status: targetStatus,
    });

    logger.published(unit.id, created.link, targetStatus === 'draft');

    // 9. Update State
    await markProcessed(
      state,
      {
        messageIds: unit.messageIds,
        wpPostId: created.id,
        url: created.link,
        status: targetStatus,
      },
      unit.id,
      'state.json',
      noState
    );

    return {
      outcome: 'published',
      url: created.link,
    };
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    logger.failed(unit.id, errorMsg);

    await markProcessed(
      state,
      {
        messageIds: unit.messageIds,
        status: 'failed',
        reason: errorMsg,
      },
      unit.id,
      'state.json',
      noState || dryRun
    );

    return {
      outcome: 'failed',
      reason: errorMsg,
    };
  }
}
