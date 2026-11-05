import { AppConfig } from './config.js';
import { logger } from './logger.js';

export interface WpMediaResult {
  id: number;
  source_url: string;
}

export interface WpCategory {
  id: number;
  name: string;
  slug: string;
}

export interface WpTag {
  id: number;
  name: string;
}

export interface WpRecentPost {
  id: number;
  title: string;
  link: string;
}

export interface CreatePostPayload {
  title: string;
  content: string;
  slug: string;
  excerpt: string;
  categories: number[];
  tags: number[];
  featured_media?: number;
  status: 'publish' | 'draft' | 'pending';
}

export interface CreatePostResult {
  id: number;
  link: string;
}

export class WordPressClient {
  private baseUrl: string;
  private authHeader: string;
  private username: string;
  private appPassword: string;
  private categoriesCache: Map<string, WpCategory> = new Map();
  private tagsCache: Map<string, number> = new Map();

  constructor(config: Pick<AppConfig, 'wpUrl' | 'wpUsername' | 'wpAppPassword'>) {
    this.baseUrl = `${config.wpUrl}/wp-json/wp/v2`;
    this.username = config.wpUsername;
    this.appPassword = config.wpAppPassword;
    const credentials = Buffer.from(
      `${config.wpUsername}:${config.wpAppPassword}`
    ).toString('base64');
    this.authHeader = `Basic ${credentials}`;
  }

  private async request(
    endpoint: string,
    options: RequestInit = {},
    timeoutMs = 30000,
    retryCount = 0
  ): Promise<Response> {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    const headers = new Headers(options.headers || {});
    if (!headers.has('Authorization')) {
      headers.set('Authorization', this.authHeader);
    }
    if (!headers.has('X-Authorization')) {
      headers.set('X-Authorization', this.authHeader);
    }
    if (!headers.has('X-WP-User')) {
      headers.set('X-WP-User', this.username);
    }
    if (!headers.has('X-WP-Password')) {
      headers.set('X-WP-Password', this.appPassword);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Handle 429 and 5xx retries (except 501 Not Implemented)
      if (
        (response.status === 429 || (response.status >= 500 && response.status !== 501)) &&
        retryCount < 3
      ) {
        const waitMs = Math.pow(2, retryCount + 1) * 1000;
        logger.warn(
          `WordPress returned HTTP ${response.status} for ${endpoint}. Retrying in ${waitMs}ms (attempt ${retryCount + 1}/3)...`
        );
        await new Promise((res) => setTimeout(res, waitMs));
        return this.request(endpoint, options, timeoutMs, retryCount + 1);
      }

      return response;
    } catch (err: any) {
      clearTimeout(timer);
      if (retryCount < 3) {
        const waitMs = Math.pow(2, retryCount + 1) * 1000;
        logger.warn(
          `WordPress network request error (${err.message}) on ${endpoint}. Retrying in ${waitMs}ms...`
        );
        await new Promise((res) => setTimeout(res, waitMs));
        return this.request(endpoint, options, timeoutMs, retryCount + 1);
      }
      throw err;
    }
  }

  /**
   * Verifies credentials against /wp-json/wp/v2/users/me
   */
  async verifyAuth(): Promise<void> {
    const res = await this.request('/users/me');

    if (res.status === 401 || res.status === 403) {
      // Check if application passwords are specifically disabled on WordPress (e.g. by Wordfence or LiteSpeed)
      try {
        const appPassRes = await this.request('/users/me/application-passwords');
        if (appPassRes.status === 501) {
          const body = (await appPassRes.json().catch(() => ({}))) as any;
          if (body?.code === 'application_passwords_disabled') {
            throw new Error(
              `WordPress Application Passwords are DISABLED on this site (HTTP 501: "application_passwords_disabled").\n` +
              `  → Wordfence: Go to WordPress Admin → Wordfence → Login Security → Settings → uncheck "Disable WordPress application passwords".\n` +
              `  → LiteSpeed / Hostinger: Ensure your .htaccess includes:\n` +
              `      RewriteEngine On\n` +
              `      RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]\n` +
              `  → Profile: Under Users → Profile, verify that the "Application Passwords" section is visible.`
            );
          }
        }
      } catch (innerErr: any) {
        if (innerErr.message.includes('application_passwords_disabled')) {
          throw innerErr;
        }
      }

      throw new Error(
        `WordPress authentication failed (HTTP ${res.status}). Verify WP_USERNAME and WP_APP_PASSWORD in .env.`
      );
    }

    if (res.status === 404) {
      throw new Error(
        `WordPress REST API endpoint not found (${this.baseUrl}/users/me). Verify WP_URL and ensure pretty permalinks are enabled.`
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `WordPress verifyAuth failed with HTTP ${res.status}: ${text.slice(0, 200)}`
      );
    }
  }

  /**
   * Uploads media buffer to WP Media Library.
   */
  async uploadMedia(
    buffer: Buffer,
    filename: string,
    mimeType: string,
    meta?: { altText?: string; title?: string }
  ): Promise<WpMediaResult> {
    // Ensure filename is ASCII safe
    const cleanFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

    const res = await this.request(
      '/media',
      {
        method: 'POST',
        headers: {
          'Content-Type': mimeType,
          'Content-Disposition': `attachment; filename="${cleanFilename}"`,
        },
        body: buffer as any,
      },
      60000 // 60s timeout for media uploads
    );

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(
        `WordPress media upload failed (${res.status} ${res.statusText}): ${errBody.slice(0, 300)}`
      );
    }

    const data = (await res.json()) as any;
    const mediaId = data.id;
    const sourceUrl = data.source_url;

    // Update alt_text and title if provided
    if (meta?.altText || meta?.title) {
      try {
        await this.request(`/media/${mediaId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            alt_text: meta.altText || '',
            title: meta.title || '',
          }),
        });
      } catch (err: any) {
        logger.warn(`Could not set alt_text for media #${mediaId}: ${err.message}`);
      }
    }

    return { id: mediaId, source_url: sourceUrl };
  }

  /**
   * Fetches all categories and caches them.
   */
  async listCategories(): Promise<WpCategory[]> {
    if (this.categoriesCache.size > 0) {
      return Array.from(this.categoriesCache.values());
    }

    let page = 1;
    const all: WpCategory[] = [];

    while (true) {
      const res = await this.request(`/categories?per_page=100&page=${page}`);
      if (!res.ok) {
        if (res.status === 400 && page > 1) {
          // Out of pages
          break;
        }
        break;
      }

      const items = (await res.json()) as any[];
      if (!Array.isArray(items) || items.length === 0) break;

      for (const item of items) {
        const cat: WpCategory = { id: item.id, name: item.name, slug: item.slug };
        all.push(cat);
        this.categoriesCache.set(cat.name.toLowerCase().trim(), cat);
        this.categoriesCache.set(cat.slug.toLowerCase().trim(), cat);
      }

      const totalPages = Number(res.headers.get('x-wp-totalpages') || '1');
      if (page >= totalPages) break;
      page++;
    }

    return all;
  }

  /**
   * Resolves category by name/slug; creates it if missing; falls back to ID 1.
   */
  async resolveCategory(name: string): Promise<number> {
    const trimmed = name.trim();
    if (!trimmed) return 1;

    // Refresh cache if empty
    if (this.categoriesCache.size === 0) {
      await this.listCategories();
    }

    const cached = this.categoriesCache.get(trimmed.toLowerCase());
    if (cached) {
      return cached.id;
    }

    // Try to create category
    try {
      const res = await this.request('/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });

      if (res.ok) {
        const created = (await res.json()) as any;
        const cat: WpCategory = { id: created.id, name: created.name, slug: created.slug };
        this.categoriesCache.set(cat.name.toLowerCase().trim(), cat);
        this.categoriesCache.set(cat.slug.toLowerCase().trim(), cat);
        return cat.id;
      }

      const errJson = (await res.json().catch(() => ({}))) as any;
      if (errJson?.code === 'term_exists') {
        const termId = errJson?.data?.term_id || errJson?.data;
        if (typeof termId === 'number') {
          return termId;
        }
      }

      logger.warn(`Failed to create category "${trimmed}". Falling back to default category (ID 1).`);
      return 1;
    } catch (err: any) {
      logger.warn(`Error resolving category "${trimmed}": ${err.message}. Using default ID 1.`);
      return 1;
    }
  }

  /**
   * Resolves tags by name; creates any missing tags.
   */
  async resolveTags(tagNames: string[]): Promise<number[]> {
    const resultIds: number[] = [];

    for (const rawName of tagNames) {
      const name = rawName.trim();
      if (!name) continue;

      const cacheKey = name.toLowerCase();
      if (this.tagsCache.has(cacheKey)) {
        resultIds.push(this.tagsCache.get(cacheKey)!);
        continue;
      }

      try {
        // Search tag
        const searchRes = await this.request(`/tags?search=${encodeURIComponent(name)}&per_page=10`);
        if (searchRes.ok) {
          const tags = (await searchRes.json()) as any[];
          const exact = tags.find(
            (t) => t.name.toLowerCase().trim() === name.toLowerCase()
          );
          if (exact) {
            this.tagsCache.set(cacheKey, exact.id);
            resultIds.push(exact.id);
            continue;
          }
        }

        // Create tag
        const createRes = await this.request('/tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });

        if (createRes.ok) {
          const created = (await createRes.json()) as any;
          this.tagsCache.set(cacheKey, created.id);
          resultIds.push(created.id);
          continue;
        }

        const errJson = (await createRes.json().catch(() => ({}))) as any;
        if (errJson?.code === 'term_exists') {
          const termId = errJson?.data?.term_id || errJson?.data;
          if (typeof termId === 'number') {
            this.tagsCache.set(cacheKey, termId);
            resultIds.push(termId);
            continue;
          }
        }
      } catch (err: any) {
        logger.warn(`Could not resolve tag "${name}": ${err.message}`);
      }
    }

    return resultIds;
  }

  /**
   * Retrieves recent published posts in a category.
   */
  async getRecentPosts(
    categoryId: number,
    n = 2,
    excludeId?: number
  ): Promise<WpRecentPost[]> {
    try {
      let endpoint = `/posts?categories=${categoryId}&per_page=${n}&_fields=id,title,link&status=publish`;
      if (excludeId) {
        endpoint += `&exclude=${excludeId}`;
      }

      const res = await this.request(endpoint);
      if (!res.ok) return [];

      const posts = (await res.json()) as any[];
      if (!Array.isArray(posts)) return [];

      return posts.map((p) => ({
        id: p.id,
        title: typeof p.title === 'string' ? p.title : p.title?.rendered || '',
        link: p.link,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Publishes or drafts a new WordPress post.
   */
  async createPost(payload: CreatePostPayload): Promise<CreatePostResult> {
    const res = await this.request('/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `WordPress createPost failed (${res.status} ${res.statusText}): ${errText.slice(0, 300)}`
      );
    }

    const data = (await res.json()) as any;
    return {
      id: data.id,
      link: data.link,
    };
  }
}

/**
 * Builds the "আরও পড়ুন" HTML box for internal linking.
 */
export function buildInternalLinksBox(posts: WpRecentPost[]): string {
  if (!posts || posts.length === 0) return '';

  const escapeHtml = (str: string) =>
    str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const listItems = posts
    .slice(0, 2)
    .map(
      (p) =>
        `    <li><a href="${escapeHtml(p.link)}">${escapeHtml(p.title)}</a></li>`
    )
    .join('\n');

  return `\n<div class="kst-read-more" style="border-left:4px solid #c00;padding:12px 16px;margin:24px 0;background:#f7f7f7;">
  <strong>আরও পড়ুন</strong>
  <ul>
${listItems}
  </ul>
</div>`;
}
