import { escapeHtml } from '../util'

// ---------------------------------------------------------------- import

export function htmlFromImport(filename: string, text: string) {
  if (/\.html?$/i.test(filename)) {
    // Parsed into an inert document; the editor schema then drops anything it doesn't know.
    const doc = new DOMParser().parseFromString(text, 'text/html')
    doc.querySelectorAll('script, style, iframe, object, embed, link, meta').forEach((n) => n.remove())
    return doc.body.innerHTML
  }
  if (/\.(md|markdown)$/i.test(filename)) return markdownToHtml(text)
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function inlineMd(s: string) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
}

/** Small Markdown subset: headings, paragraphs, lists, quotes, code blocks, rules, inline styles. */
export function markdownToHtml(md: string) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`)
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      out.push(`<h${Math.min(3, h[1].length)}>${inlineMd(h[2])}</h${Math.min(3, h[1].length)}>`)
      i++
      continue
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<hr>')
      i++
      continue
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''))
      out.push(`<blockquote>${markdownToHtml(buf.join('\n'))}</blockquote>`)
      continue
    }
    const listRe = /^\s*([-*+]|\d+[.)])\s+(.*)$/
    if (listRe.test(line)) {
      const ordered = /^\s*\d/.test(line)
      const items: string[] = []
      while (i < lines.length && listRe.test(lines[i])) items.push(`<li><p>${inlineMd(listRe.exec(lines[i++])![2])}</p></li>`)
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i++])
    out.push(`<p>${inlineMd(buf.join(' '))}</p>`)
  }
  return out.join('')
}

// ---------------------------------------------------------------- export

export function htmlToMarkdown(root: Node): string {
  const walk = (n: Node, ctx: { list?: 'ul' | 'ol'; index?: number; depth: number }): string => {
    if (n.nodeType === Node.TEXT_NODE) return (n.textContent || '').replace(/([*_`[\]])/g, '\\$1')
    if (!(n instanceof HTMLElement)) return ''
    const kids = (c = ctx) => [...n.childNodes].map((k) => walk(k, c)).join('')
    switch (n.tagName) {
      case 'H1':
        return `# ${kids()}\n\n`
      case 'H2':
        return `## ${kids()}\n\n`
      case 'H3':
        return `### ${kids()}\n\n`
      case 'P':
        return ctx.list ? kids() : `${kids()}\n\n`
      case 'BR':
        return '  \n'
      case 'STRONG':
      case 'B':
        return `**${kids()}**`
      case 'EM':
      case 'I':
        return `*${kids()}*`
      case 'S':
        return `~~${kids()}~~`
      case 'CODE':
        return n.parentElement?.tagName === 'PRE' ? n.textContent || '' : `\`${n.textContent}\``
      case 'PRE':
        return `\`\`\`\n${n.textContent}\n\`\`\`\n\n`
      case 'BLOCKQUOTE':
        return (
          kids()
            .trim()
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n') + '\n\n'
        )
      case 'HR':
        return '---\n\n'
      case 'A':
        return n.classList.contains('fn-ref') ? `[^${n.textContent}]` : `[${kids()}](${n.getAttribute('href')})`
      case 'SUP':
        return kids()
      case 'IMG':
        return `![${n.getAttribute('alt') || ''}](${n.getAttribute('src')})`
      case 'UL':
      case 'OL': {
        let idx = 0
        const items = [...n.children].map((li) => {
          idx++
          const body = [...li.childNodes].map((k) => walk(k, { list: n.tagName === 'UL' ? 'ul' : 'ol', index: idx, depth: ctx.depth + 1 })).join('').trim()
          return `${'  '.repeat(ctx.depth)}${n.tagName === 'UL' ? '-' : `${idx}.`} ${body}`
        })
        return items.join('\n') + (ctx.depth ? '\n' : '\n\n')
      }
      default:
        return kids()
    }
  }
  return walk(root, { depth: 0 }).replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
