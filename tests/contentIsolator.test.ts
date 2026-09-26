import { describe, expect, it } from 'vitest';
import {
  FALLBACK_SELECTOR,
  isolateContent,
} from '../src/extraction/contentIsolator.js';

function hrefs(html: string): string[] {
  const isolated = isolateContent(html);
  const found: string[] = [];
  isolated.scope.find('a').each((_index, element) => {
    found.push(isolated.$(element).attr('href') ?? '');
  });
  return found;
}

describe('isolateContent', () => {
  it('prefers article .entry-content over all later selectors', () => {
    const html = `<html><body>
      <header><a href="/header">Header</a></header>
      <main>
        <article><div class="entry-content"><a href="/inside">Inside</a></div></article>
        <div class="post-content"><a href="/post">Post</a></div>
      </main>
    </body></html>`;
    const isolated = isolateContent(html);
    expect(isolated.selectorUsed).toBe('article .entry-content');
    expect(hrefs(html)).toEqual(['/inside']);
  });

  it('tries .entry-content before .post-content', () => {
    const html = `<html><body>
      <div class="post-content"><a href="/post">Post</a></div>
      <div class="entry-content"><a href="/entry">Entry</a></div>
    </body></html>`;
    const isolated = isolateContent(html);
    expect(isolated.selectorUsed).toBe('.entry-content');
    expect(hrefs(html)).toEqual(['/entry']);
  });

  it('uses <article> when no content-class selector matches', () => {
    const html = `<html><body>
      <div id="content"><span>not an article</span></div>
      <article><a href="/article">Article</a></article>
    </body></html>`;
    expect(isolateContent(html).selectorUsed).toBe('article');
    expect(hrefs(html)).toEqual(['/article']);
  });

  it('uses <main> as the last content selector', () => {
    const html = `<html><body><main><a href="/main">Main</a></main></body></html>`;
    expect(isolateContent(html).selectorUsed).toBe('main');
    expect(hrefs(html)).toEqual(['/main']);
  });

  it('falls back to <body> with all boilerplate removed', () => {
    const html = `<html><body>
      <header><a href="/header">Header</a></header>
      <nav><a href="/nav">Nav</a></nav>
      <aside class="sidebar"><a href="/sidebar">Sidebar</a></aside>
      <div class="widget"><a href="/widget">Widget</a></div>
      <div class="widget-area"><a href="/widget-area">WidgetArea</a></div>
      <div class="menu"><a href="/menu">Menu</a></div>
      <div role="navigation"><a href="/role-nav">RoleNav</a></div>
      <div role="banner"><a href="/role-banner">RoleBanner</a></div>
      <div role="contentinfo"><a href="/role-footer">RoleFooter</a></div>
      <footer><a href="/footer">Footer</a></footer>
      <p><a href="/real-content">Real content</a></p>
    </body></html>`;
    const isolated = isolateContent(html);
    expect(isolated.selectorUsed).toBe(FALLBACK_SELECTOR);
    expect(hrefs(html)).toEqual(['/real-content']);
  });
});