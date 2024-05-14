import crypto from 'node:crypto';
import { resolve } from 'node:path';

import { pathExistsSync } from 'fs-extra';

import type { ErrnoException } from './error_tracker';
import type { CrawlingContext } from '../crawlers/crawler_commons';
import type { KeyValueStore } from '../storages';
import type { PlaywrightCrawlingContext, PuppeteerCrawlingContext, PlaywrightPage, PuppeteerPage, SnapshotResult } from '../typedefs';

/**
 * ErrorSnapshotter class is used to capture a screenshot of the page and a snapshot of the HTML when an error occur during web crawling.
 */
export class ErrorSnapshotter {
    static readonly MAX_ERROR_CHARACTERS = 30;
    static readonly MAX_HASH_LENGTH = 30;
    static readonly MAX_FILENAME_LENGTH = 250;
    static readonly BASE_MESSAGE = 'An error occurred';
    static readonly SNAPSHOT_PREFIX = 'ERROR_SNAPSHOT';

    private KEY_VALUE_STORE_LOCAL_PATH: string;
    private KEY_VALUE_PLATFORM_PATH :string;

    constructor() {
        // v3.0.0 used `crawlee_storage` as the default, we changed this in v3.0.1 to just `storage`,
        // this function handles it without making BC breaks - it respects existing `crawlee_storage`
        // directories, and uses the `storage` only if it's not there.
        const defaultStorageDir = () => {
            if (pathExistsSync(resolve('./crawlee_storage'))) {
                return 'crawlee_storage';
            }

            return 'storage';
        };

        this.KEY_VALUE_PLATFORM_PATH = 'https://api.apify.com/v2/key-value-stores';
        this.KEY_VALUE_STORE_LOCAL_PATH = `file://${process.env.PWD}/${defaultStorageDir()}/key_value_stores`;
    }

    /**
     * Capture a snapshot of the error context.
     */
    async captureSnapshot(error: ErrnoException, context: CrawlingContext): Promise<{ screenshotFileUrl?: string; htmlFileUrl?: string }> {
        try {
            const page = context?.page as PuppeteerPage | PlaywrightPage | undefined;
            const body = context?.body;

            const keyValueStore = await context?.getKeyValueStore();
            // If the key-value store is not available, or the body and page are not available, return empty filenames
            if (!keyValueStore || (!body && !page)) {
                return {};
            }

            const filename = this.generateFilename(error);

            let screenshotFilename: string | undefined;
            let htmlFileName: string | undefined;

            if (page) {
                const capturedFiles = await this.captureSnapShot(
                    context as unknown as PlaywrightCrawlingContext | PuppeteerCrawlingContext,
                    filename,
                );

                if (capturedFiles) {
                    screenshotFilename = capturedFiles.screenshotFilename;
                    htmlFileName = capturedFiles.htmlFileName;
                }

                // If the snapshot for browsers failed to capture the HTML, try to capture it from the page content
                if (!htmlFileName) {
                    const html = await page?.content() || undefined;
                    htmlFileName = html ? await this.saveHTMLSnapshot(html, keyValueStore, filename) : undefined;
                }
            } else if (typeof body === 'string') { // for non-browser contexts
                htmlFileName = await this.saveHTMLSnapshot(body, keyValueStore, filename);
            }

            if (process.env.APIFY_IS_AT_HOME) {
                const platformPath = `${this.KEY_VALUE_PLATFORM_PATH}/${keyValueStore.id}/records`;
                return {
                    screenshotFileUrl: screenshotFilename ? `${platformPath}/${screenshotFilename}` : undefined,
                    htmlFileUrl: htmlFileName ? `${platformPath}/${htmlFileName}` : undefined,
                };
            }

            const localPath = `${this.KEY_VALUE_STORE_LOCAL_PATH}/${keyValueStore.name || 'default'}`;
            return {
                screenshotFileUrl: screenshotFilename ? `${localPath}/${screenshotFilename}` : undefined,
                htmlFileUrl: htmlFileName ? `${localPath}/${htmlFileName}` : undefined,
            };
        } catch (e) {
            return {};
        }
    }

    /**
     * Capture a screenshot and HTML of the page (For Browser only), and return the filename with the extension.
     */
    async captureSnapShot(context: PlaywrightCrawlingContext | PuppeteerCrawlingContext, filename: string): Promise<SnapshotResult> {
        try {
            await context.saveSnapshot({ key: filename });
            return {
                // The screenshot file extension is different for Apify and local environments
                screenshotFilename: `${filename}${process.env.APIFY_IS_AT_HOME ? '.jpg' : '.jpeg'}`,
                htmlFileName: `${filename}.html`,
            };
        } catch (e) {
            return undefined;
        }
    }

    /**
     * Save the HTML snapshot of the page, and return the filename with the extension.
     */
    async saveHTMLSnapshot(html: string, keyValueStore: KeyValueStore, filename: string): Promise<string | undefined> {
        try {
            await keyValueStore.setValue(filename, html, { contentType: 'text/html' });
            return `${filename}.html`;
        } catch (e) {
            return undefined;
        }
    }

    /**
     * Generate a unique filename for each error snapshot.
     */
    generateFilename(error: ErrnoException): string {
        const { SNAPSHOT_PREFIX, BASE_MESSAGE, MAX_HASH_LENGTH, MAX_ERROR_CHARACTERS, MAX_FILENAME_LENGTH } = ErrorSnapshotter;
        // Create a hash of the error stack trace
        const errorStackHash = crypto.createHash('sha1').update(error.stack || error.message || '').digest('hex').slice(0, MAX_HASH_LENGTH);
        const errorMessagePrefix = (error.message || BASE_MESSAGE).slice(0, MAX_ERROR_CHARACTERS).trim();

        /**
         * Remove non-word characters from the start and end of a string.
         */
        const sanitizeString = (str: string): string => {
            return str.replace(/^\W+|\W+$/g, '');
        };

        // Generate filename and remove disallowed characters
        const filename = `${SNAPSHOT_PREFIX}_${sanitizeString(errorStackHash)}_${sanitizeString(errorMessagePrefix)}`
            .replace(/\W+/g, '-') // Replace non-word characters with a dash
            .slice(0, MAX_FILENAME_LENGTH);

        return filename;
    }
}
