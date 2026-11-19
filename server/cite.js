/**
 * "Fetch details" for citations: this server downloads the cited page itself and
 * reads the metadata publishers embed for search engines and reference managers
 * (Highwire citation_* tags, schema.org JSON-LD, Dublin Core, Open Graph, <title>).
 * No third-party lookup service is ever contacted; only the cited site sees a request.
 *
 * Safety: only http(s) on ports 80/443, every hop (including redirects) must
 * resolve to a public IP address — checked at connect time, so DNS tricks can't
 * point it at your own network — plus a size cap and timeouts.
 */
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'
import zlib from 'node:zlib'

const MAX_BYTES = 3 * 1024 * 1024
const TIMEOUT_MS = 10000
const MAX_REDIRECTS = 5

// ---------------------------------------------------------------- address checks

function isPublicIPv4(ip) {
  const [a, b] = ip.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false // carrier-grade NAT
  if (a === 169 && b === 254) return false // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a >= 224) return false // multicast / reserved
  return true
}

export function isPublicAddress(ip) {
  if (net.isIPv4(ip)) return isPublicIPv4(ip)
  if (!net.isIPv6(ip)) return false
  const v = ip.toLowerCase()
  // IPv6 forms that embed an IPv4 address (mapped, compatible, NAT64), dotted or hex.
  const embedded = /^(?:::ffff:|::|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(v)
  if (embedded) {
    if (embedded[1]) return isPublicIPv4(embedded[1])
    const hi = parseInt(embedded[2], 16)
    const lo = parseInt(embedded[3], 16)
    return isPublicIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  if (v === '::' || v === '::1') return false
  if (/^f[cd]/.test(v)) return false // unique local
  if (/^fe[89ab]/.test(v)) return false // link-local
  if (/^ff/.test(v)) return false // multicast
  return true
}

function safeLookup(allowPrivate) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err)
      const ok = addrs.filter((a) => allowPrivate || isPublicAddress(a.address))
      if (!ok.length) return cb(Object.assign(new Error('That address is on a private network'), { code: 'EPRIVATE' }))
      if (options && options.all) return cb(null, ok)
      cb(null, ok[0].address, ok[0].family)
    })
  }
}

// ---------------------------------------------------------------- fetching

function get(url, allowPrivate) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(
      url,
      {
        method: 'GET',
        lookup: safeLookup(allowPrivate),
        timeout: TIMEOUT_MS,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SidescriptCitation/1.0)',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en;q=0.9, *;q=0.5',
        },
      },
      (res) => resolve(res),
    )
    req.on('timeout', () => req.destroy(Object.assign(new Error('The site took too long to respond'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    req.end()
  })
}

async function readBody(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase()
  let stream = res
  if (enc === 'gzip') stream = res.pipe(zlib.createGunzip())
  else if (enc === 'deflate') stream = res.pipe(zlib.createInflate())
  else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress())
  const chunks = []
  let size = 0
  for await (const c of stream) {
    size += c.length
    chunks.push(c)
    // Metadata lives in <head>; stop once we have plenty.
    if (size > MAX_BYTES) {
      res.destroy()
      break
    }
  }
  const buf = Buffer.concat(chunks)
  const charset = /charset=([\w-]+)/i.exec(String(res.headers['content-type'] || ''))?.[1] || /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'))?.[1] || 'utf-8'
  try {
    return new TextDecoder(charset.toLowerCase()).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

/** Open a URL with all the safety checks and redirects; returns the live response (any content type). */
export async function openUrl(input, { allowPrivate = false } = {}) {
  let url
  try {
    url = new URL(String(input).trim())
  } catch {
    throw Object.assign(new Error('That doesn’t look like a web address'), { status: 400 })
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('Only http and https links can be fetched'), { status: 400 })
    if (url.port && !['80', '443'].includes(url.port) && !allowPrivate) throw Object.assign(new Error('Only standard web ports can be fetched'), { status: 400 })
    if (url.username || url.password) throw Object.assign(new Error('Links with passwords can’t be fetched'), { status: 400 })
    // Literal IP addresses skip DNS (and so skip the lookup check): test them here.
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (net.isIP(host) && !allowPrivate && !isPublicAddress(host)) throw Object.assign(new Error('That address is on a private network, so it can’t be fetched'), { status: 422 })
    let res
    try {
      res = await get(url, allowPrivate)
    } catch (e) {
      throw Object.assign(new Error(e.code === 'EPRIVATE' ? 'That address is on a private network, so it can’t be fetched' : e.code === 'ETIMEDOUT' ? 'The site took too long to respond' : 'Couldn’t reach that site'), { status: 422 })
    }
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume()
      url = new URL(res.headers.location, url)
      continue
    }
    if (res.statusCode >= 400) {
      res.resume()
      throw Object.assign(new Error(`The site answered with an error (${res.statusCode})${res.statusCode === 403 ? ' — it may block automated requests' : ''}`), { status: 422 })
    }
    return { res, finalUrl: url.href }
  }
  throw Object.assign(new Error('Too many redirects'), { status: 422 })
}

/** Decompressed body stream of a response. */
export function bodyStream(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase()
  if (enc === 'gzip') return res.pipe(zlib.createGunzip())
  if (enc === 'deflate') return res.pipe(zlib.createInflate())
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress())
  return res
}

export const isHtml = (res) => {
  const type = String(res.headers['content-type'] || '')
  return !type || /html|xml/i.test(type)
}
export { readBody }

export async function fetchPage(input, opts) {
  const { res, finalUrl } = await openUrl(input, opts)
  if (!isHtml(res)) {
    res.resume()
    throw Object.assign(new Error('That link isn’t a web page (it may be a PDF or file)'), { status: 422 })
  }
  return { html: await readBody(res), finalUrl }
}

// ---------------------------------------------------------------- parsing

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }
const decode = (s) =>
  String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()

function attrs(tag) {
  const out = {}
  for (const m of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? '')
  return out
}

const ARTICLE_TYPES = /Article|BlogPosting|Report|Book|Chapter|Thesis|Review|Episode|Movie|VideoObject|CreativeWork|WebPage/
const typeRank = (t) => (/ScholarlyArticle|NewsArticle|Report/.test(t) ? 3 : /Article|BlogPosting|Book|Chapter|Thesis/.test(t) ? 2 : ARTICLE_TYPES.test(t) ? 1 : 0)

function jsonLd(html) {
  const found = []
  const visit = (o) => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) return o.forEach(visit)
    const t = [].concat(o['@type'] || []).join(' ')
    if (t && ARTICLE_TYPES.test(t)) found.push(o)
    if (o['@graph']) visit(o['@graph'])
    if (o.mainEntity) visit(o.mainEntity)
  }
  for (const m of html.matchAll(/<script[^>]+type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(m[1].trim()))
    } catch {
      /* ignore broken blocks */
    }
  }
  return found.sort((a, b) => typeRank([].concat(b['@type']).join(' ')) - typeRank([].concat(a['@type']).join(' ')))[0] || null
}

const nameOf = (x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? x.name || [x.givenName, x.familyName].filter(Boolean).join(' ') : '')
const isUrl = (s) => /^https?:\/\//i.test(s)
const uniq = (arr) => [...new Set(arr.map((s) => decode(s)).filter((s) => s && !isUrl(s)))]

/** Turn a page's HTML into citation fields. Pure function (no network). */
export function parseCitation(html, pageUrl) {
  const head = html.slice(0, 600000)
  const meta = {}
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0])
    const key = (a.name || a.property || a.itemprop || '').toLowerCase()
    if (!key || a.content === undefined) continue
    ;(meta[key] ||= []).push(a.content)
  }
  const first = (...keys) => {
    for (const k of keys) {
      const v = meta[k]?.find((x) => x && x.trim())
      if (v) return decode(v)
    }
    return ''
  }
  const ld = jsonLd(head)
  const titleTag = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] || '')
  const canonical = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0])).find((a) => /\bcanonical\b/i.test(a.rel || ''))?.href

  // Authors: academic tags, then structured data, then generic tags.
  let authors = uniq(meta['citation_author'] || [])
  if (!authors.length && ld?.author) authors = uniq([].concat(ld.author).map(nameOf))
  if (!authors.length) authors = uniq([...(meta['dc.creator'] || []), ...(meta['dcterms.creator'] || []), ...(meta['author'] || []), ...(meta['article:author'] || []), ...(meta['parsely-author'] || [])])

  const siteName = first('og:site_name', 'application-name')
  const publisher = nameOf(ld?.publisher) || first('citation_publisher', 'dc.publisher', 'dcterms.publisher')
  const source = first('citation_journal_title', 'citation_conference_title', 'citation_book_title') || siteName || publisher || new URL(pageUrl).hostname.replace(/^www\./, '')

  let title = first('citation_title', 'dc.title', 'dcterms.title') || decode(ld?.headline || ld?.name || '') || first('og:title', 'twitter:title') || titleTag
  // Drop a trailing " | Site name" / " - Site name".
  if (siteName && title.length > siteName.length + 3) title = title.replace(new RegExp(`\\s*[|\\-–—:]\\s*${siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '')

  const date = first('citation_publication_date', 'citation_date', 'citation_online_date', 'citation_cover_date') || decode(ld?.datePublished || ld?.dateCreated || '') || first('article:published_time', 'dc.date', 'dcterms.date', 'dcterms.issued', 'date', 'pubdate', 'publish-date', 'og:updated_time')
  const year = /\b(1[5-9]\d\d|20\d\d)\b/.exec(date)?.[1] || ''

  const fp = first('citation_firstpage')
  const lp = first('citation_lastpage')
  const doi = first('citation_doi', 'dc.identifier', 'prism.doi').replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/i, '')

  let url = first('citation_public_url', 'og:url') || canonical || pageUrl
  try {
    url = new URL(url, pageUrl).href
  } catch {
    url = pageUrl
  }

  return {
    title: title.slice(0, 500),
    author: authors.slice(0, 20).join('; ').slice(0, 500),
    source: source.slice(0, 300),
    year,
    date: date.slice(0, 40),
    pages: fp ? (lp && lp !== fp ? `${fp}–${lp}` : fp) : '',
    doi: /^10\.\d{4,}\//.test(doi) ? doi : '',
    url,
    siteName: siteName.slice(0, 200),
    image: (() => {
      const raw = first('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src') || (typeof ld?.image === 'string' ? ld.image : [].concat(ld?.image || [])[0]?.url || '')
      try {
        return raw ? new URL(raw, pageUrl).href : ''
      } catch {
        return ''
      }
    })(),
  }
}

export async function fetchCitation(input, opts) {
  const { html, finalUrl } = await fetchPage(input, opts)
  return parseCitation(html, finalUrl)
}
