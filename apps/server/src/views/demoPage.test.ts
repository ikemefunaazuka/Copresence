import { describe, expect, it } from 'vitest';

import { renderLandingPage, renderSessionPage } from './demoPage.js';

describe('renderLandingPage', () => {
  it('is a full HTML document linking to /s/new', () => {
    const html = renderLandingPage();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('href="/s/new"');
  });
});

describe('renderSessionPage', () => {
  it('embeds the given sid on body.dataset.sid', () => {
    const html = renderSessionPage({ sid: 'abc-123', clientScriptSrc: '/static/copresence.js' });
    expect(html).toContain('data-sid="abc-123"');
  });

  it('embeds the given client script src', () => {
    const html = renderSessionPage({ sid: 's1', clientScriptSrc: '/static/copresence.js' });
    expect(html).toContain('<script src="/static/copresence.js"></script>');
  });

  it('escapes HTML-meaningful characters in the sid rather than interpolating them raw', () => {
    const html = renderSessionPage({
      sid: '<script>alert(1)</script>',
      clientScriptSrc: '/static/copresence.js',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('is a full HTML document containing the participant panel and article content', () => {
    const html = renderSessionPage({ sid: 's1', clientScriptSrc: '/static/copresence.js' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('id="participants"');
    expect(html).toContain('<article>');
  });
});
