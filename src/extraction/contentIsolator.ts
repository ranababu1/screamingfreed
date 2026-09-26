/**
 * WordPress content isolation.
 *
 * Locates the main article body by trying a prioritized list of selectors and
 * falling back to the whole `<body>` after removing boilerplate elements.
 */

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { Cheerio, CheerioAPI } from 'cheerio';

/** Selectors tried in order to locate the main WordPress article body. */
export const CONTENT_SELECTORS = [
  'article .entry-content',
  '.entry-content',
  '.post-content',
  'article',
  '#content',
  'main',
] as const;

/**
 * Boilerplate elements removed before falling back to the whole `<body>`.
 */
export const BOILERPLATE_SELECTORS = [
  'header',
  'footer',
  'nav',
  'aside',
  '.sidebar',
  '#sidebar',
  '.widget',
  '.widget-area',
  '.menu',
  '[role=navigation]',
  '[role=banner]',
  '[role=contentinfo]',
] as const;

/** Selector strategy recorded when the fallback path is used. */
export const FALLBACK_SELECTOR = 'body (boilerplate removed)';

export interface IsolatedContent {
  /** The parsed document, for further queries. */
  $: CheerioAPI;
  /** The isolated article body. */
  scope: Cheerio<AnyNode>;
  /** The winning selector strategy. */
  selectorUsed: string;
}

export function isolateContent(html: string): IsolatedContent {
  const $ = cheerio.load(html);
  for (const selector of CONTENT_SELECTORS) {
    const match = $(selector);
    if (match.length > 0) {
      return { $, scope: match as Cheerio<AnyNode>, selectorUsed: selector };
    }
  }
  // Fallback: use the whole <body> after stripping boilerplate elements.
  const $body: Cheerio<AnyNode> =
    $('body').length > 0
      ? ($('body') as Cheerio<AnyNode>)
      : ($.root() as Cheerio<AnyNode>);
  $body.find(BOILERPLATE_SELECTORS.join(', ')).remove();
  return { $, scope: $body, selectorUsed: FALLBACK_SELECTOR };
}