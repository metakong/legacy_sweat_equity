/**
 * Tests for the EOD debrief's Markdown renderer.
 *
 * It is browser code, so a minimal DOM is stubbed here rather than pulling in
 * jsdom — the renderer only ever touches createElement, createTextNode,
 * createDocumentFragment, appendChild, textContent and setAttribute, which is
 * exactly the point being tested.
 *
 * The security assertions matter most: this renders language-model output
 * derived from voice transcripts, so anything resembling markup must come out
 * as literal text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------
// Minimal DOM
// ---------------------------------------------------------------------
class Node {
  constructor(tag) {
    this.tagName = (tag || '').toUpperCase();
    this.childNodes = [];
    this.attributes = {};
    this.className = '';
    this._text = null;
  }

  appendChild(child) {
    this.childNodes.push(child);
    return child;
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }

  set textContent(value) {
    this._text = String(value);
    this.childNodes = [];
  }

  get textContent() {
    if (this._text !== null) return this._text;
    return this.childNodes.map((c) => c.textContent).join('');
  }

  /** Depth-first walk, so tests can assert on structure. */
  find(tag) {
    const wanted = tag.toUpperCase();
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.tagName === wanted) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  tags() {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.tagName) out.push(child.tagName);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

class TextNode {
  constructor(text) { this._text = String(text); this.childNodes = []; this.tagName = ''; }
  get textContent() { return this._text; }
}

globalThis.document = {
  createElement: (tag) => new Node(tag),
  createTextNode: (text) => new TextNode(text),
  createDocumentFragment: () => new Node('')
};

const { renderMarkdown } = await import('../public/app/markdown.js');

// ---------------------------------------------------------------------
// Security — the reason this file exists rather than a CDN parser
// ---------------------------------------------------------------------
test('HTML in model output is rendered as literal text, never as markup', () => {
  const hostile = 'A vendor named <img src=x onerror=alert(1)> called today.';
  const out = renderMarkdown(hostile);

  assert.equal(out.find('img').length, 0, 'no element may be created from the text');
  assert.ok(out.textContent.includes('<img src=x onerror=alert(1)>'), 'the characters survive verbatim');
});

test('script tags in model output do not become elements', () => {
  const out = renderMarkdown('Notes: <script>fetch("/api/companies")</script> end.');
  assert.equal(out.find('script').length, 0);
  assert.ok(out.textContent.includes('<script>'));
});

test('a table cell cannot smuggle markup', () => {
  const out = renderMarkdown([
    '| Metric | Value |',
    '| --- | --- |',
    '| <b>Doors</b> | <iframe src=evil> |'
  ].join('\n'));

  assert.equal(out.find('b').length, 0);
  assert.equal(out.find('iframe').length, 0);
  const cells = out.find('td');
  assert.equal(cells[0].textContent, '<b>Doors</b>');
  assert.equal(cells[1].textContent, '<iframe src=evil>');
});

test('the renderer never emits an anchor, so no model-supplied URL is clickable', () => {
  const out = renderMarkdown('See [click me](javascript:alert(1)) for details.');
  assert.equal(out.find('a').length, 0);
  assert.ok(out.textContent.includes('javascript:alert(1)'), 'shown as text, not linked');
});

// ---------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------
test('headings render, offset so the report never emits a second h1', () => {
  const out = renderMarkdown('# Debrief\n\n## Metrics\n\n### Detail');
  assert.equal(out.find('h1').length, 0);
  assert.equal(out.find('h2')[0].textContent, 'Debrief');
  assert.equal(out.find('h3')[0].textContent, 'Metrics');
  assert.equal(out.find('h4')[0].textContent, 'Detail');
});

test('a pipe table becomes a real table with header scope', () => {
  const out = renderMarkdown([
    '| Metric | Value |',
    '| --- | --- |',
    '| Total Doors | 9 |',
    '| DMs Met | 4 |'
  ].join('\n'));

  const headers = out.find('th');
  assert.deepEqual(headers.map((h) => h.textContent), ['Metric', 'Value']);
  assert.equal(headers[0].getAttribute('scope'), 'col');
  assert.equal(out.find('tr').length, 3, 'header + two body rows');
  assert.deepEqual(out.find('td').map((c) => c.textContent), ['Total Doors', '9', 'DMs Met', '4']);
});

test('a wide table is wrapped in its own scroll container', () => {
  const out = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |');
  const wrapper = out.childNodes[0];
  assert.equal(wrapper.className, 'md-table-scroll');
  assert.equal(wrapper.childNodes[0].tagName, 'TABLE');
});

test('bullet and numbered lists render as ul/ol', () => {
  const bullets = renderMarkdown('- first\n- second');
  assert.equal(bullets.find('ul').length, 1);
  assert.deepEqual(bullets.find('li').map((l) => l.textContent), ['first', 'second']);

  const numbered = renderMarkdown('1. first\n2. second');
  assert.equal(numbered.find('ol').length, 1);
  assert.equal(numbered.find('li').length, 2);
});

test('inline bold, italic and code render as elements', () => {
  const out = renderMarkdown('Call **Yvonne** about the *Section 125* `payroll` question.');
  assert.equal(out.find('strong')[0].textContent, 'Yvonne');
  assert.equal(out.find('em')[0].textContent, 'Section 125');
  assert.equal(out.find('code')[0].textContent, 'payroll');
  assert.ok(out.textContent.startsWith('Call Yvonne about'));
});

test('unmatched emphasis markers stay literal instead of eating the line', () => {
  const out = renderMarkdown('Projected AP is 4800 * 12 months');
  assert.ok(out.textContent.includes('4800 * 12 months'));
});

test('blockquotes and horizontal rules render', () => {
  const out = renderMarkdown('> Watch this account.\n\n---\n\nDone.');
  assert.equal(out.find('blockquote')[0].textContent, 'Watch this account.');
  assert.equal(out.find('hr').length, 1);
});

test('paragraphs join wrapped lines but split on blank lines', () => {
  const out = renderMarkdown('Line one\nstill line one.\n\nSecond paragraph.');
  const paragraphs = out.find('p');
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].textContent, 'Line one still line one.');
  assert.equal(paragraphs[1].textContent, 'Second paragraph.');
});

// ---------------------------------------------------------------------
// Robustness — models produce imperfect Markdown
// ---------------------------------------------------------------------
test('a wrapping code fence is stripped', () => {
  const out = renderMarkdown('```markdown\n## Metrics\n\nBody text.\n```');
  assert.equal(out.find('h3')[0].textContent, 'Metrics');
  assert.ok(!out.textContent.includes('```'));
});

test('empty and non-string input produce an empty fragment', () => {
  for (const value of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(renderMarkdown(value).childNodes.length, 0);
  }
});

test('a table with no body rows still renders its header', () => {
  const out = renderMarkdown('| Metric | Value |\n| --- | --- |');
  assert.equal(out.find('th').length, 2);
  assert.equal(out.find('td').length, 0);
});

test('a realistic debrief renders end to end', () => {
  const out = renderMarkdown([
    '# End-of-Day Debrief — 2026-08-29',
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    '| Total Doors | 9 |',
    '| DMs Met | 4 |',
    '| Appointments | 2 |',
    '',
    '## Narrative',
    '',
    '**Mercy Occupational Health** was the standout — Yvonne Castillo confirmed a',
    'November open-enrollment window for 210 W-2 employees.',
    '',
    '### Recommended next steps',
    '- Send the Section 125 one-pager to Yvonne by 2026-08-31.',
    '- Re-approach the gatekeeper at Commercial Street Brewing.'
  ].join('\n'));

  const tags = out.tags();
  assert.ok(tags.includes('TABLE'));
  assert.ok(tags.includes('UL'));
  assert.ok(tags.includes('STRONG'));
  assert.equal(out.find('h2').length, 1, 'one top-level heading');
  assert.equal(out.find('h3').length, 2, 'Metrics and Narrative');
  assert.equal(out.find('li').length, 2);
  assert.ok(out.textContent.includes('Yvonne Castillo'));
});
