/**
 * A deliberately small Markdown -> DOM renderer.
 *
 * WHY THIS EXISTS RATHER THAN A LIBRARY
 * The only content it renders is the EOD debrief: text produced by a language
 * model from voice transcripts. That is untrusted input twice over, and the
 * project has no bundler, so pulling a parser off a CDN would mean shipping a
 * third-party script and widening the CSP for one screen.
 *
 * THE SECURITY PROPERTY
 * There is no HTML parsing anywhere in this file. Every node is created with
 * createElement and every piece of text is assigned via textContent, so a
 * model that emits `<img onerror=...>` renders those characters literally
 * instead of executing them. `innerHTML` must never appear here.
 *
 * Supported, because it is what the debrief prompt asks for: headings, pipe
 * tables, bullet and numbered lists, bold/italic/code spans, blockquotes,
 * horizontal rules and paragraphs. Anything else degrades to plain text, which
 * is the correct failure mode for a report.
 */

/** Split a table row on unescaped pipes, dropping the leading/trailing empties. */
function splitRow(line) {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map((cell) => cell.trim());
}

const isTableSeparator = (line) => /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(line) && line.includes('-');

/**
 * Inline spans: **bold**, *italic*, `code`. Emits text nodes and elements,
 * never markup. Unmatched delimiters are left as literal characters.
 */
function renderInline(text, target) {
  // Ordered so ** is consumed before a single *.
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      target.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      target.appendChild(strong);
    } else if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      target.appendChild(code);
    } else {
      const em = document.createElement('em');
      em.textContent = token.slice(1, -1);
      target.appendChild(em);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    target.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
  return target;
}

/**
 * @param {string} markdown
 * @returns {DocumentFragment} ready to hand to replaceChildren()
 */
export function renderMarkdown(markdown) {
  const fragment = document.createDocumentFragment();
  if (typeof markdown !== 'string' || !markdown.trim()) return fragment;

  // Strip a wrapping code fence — models add them even when told not to.
  const cleaned = markdown
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/, '');

  const lines = cleaned.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank
    if (!line.trim()) { i += 1; continue; }

    // Horizontal rule
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line) && !line.includes('|')) {
      fragment.appendChild(document.createElement('hr'));
      i += 1;
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6); // h1 is the page's, start at h2
      const node = document.createElement(`h${level}`);
      renderInline(heading[2].trim(), node);
      fragment.appendChild(node);
      i += 1;
      continue;
    }

    // Table: a pipe row followed by a separator row
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const table = document.createElement('table');
      table.className = 'md-table';

      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const cell of splitRow(line)) {
        const th = document.createElement('th');
        th.setAttribute('scope', 'col');
        renderInline(cell, th);
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      i += 2; // consume header + separator
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const tr = document.createElement('tr');
        for (const cell of splitRow(lines[i])) {
          const td = document.createElement('td');
          renderInline(cell, td);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        i += 1;
      }
      table.appendChild(tbody);

      // Wrapped so a wide table scrolls itself instead of the page.
      const scroller = document.createElement('div');
      scroller.className = 'md-table-scroll';
      scroller.appendChild(table);
      fragment.appendChild(scroller);
      continue;
    }

    // Lists (a run of consecutive items)
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      list.className = 'md-list';

      while (i < lines.length) {
        const itemMatch = ordered
          ? lines[i].match(/^\s*\d+[.)]\s+(.*)$/)
          : lines[i].match(/^\s*[-*+]\s+(.*)$/);
        if (!itemMatch) break;
        const li = document.createElement('li');
        renderInline(itemMatch[1].trim(), li);
        list.appendChild(li);
        i += 1;
      }

      fragment.appendChild(list);
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement('blockquote');
      const parts = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        parts.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      renderInline(parts.join(' '), quote);
      fragment.appendChild(quote);
      continue;
    }

    // Paragraph: consume until a blank line or a line that starts a new block
    const paragraph = document.createElement('p');
    const parts = [];
    while (
      i < lines.length
      && lines[i].trim()
      && !/^(#{1,6})\s/.test(lines[i])
      && !/^\s*[-*+]\s+/.test(lines[i])
      && !/^\s*\d+[.)]\s+/.test(lines[i])
      && !/^\s*>\s?/.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      parts.push(lines[i].trim());
      i += 1;
    }
    renderInline(parts.join(' '), paragraph);
    fragment.appendChild(paragraph);
  }

  return fragment;
}
