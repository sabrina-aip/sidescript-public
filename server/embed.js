/**
 * Paste a link into an annotation -> an embedded attachment. Everything is fetched
 * by this server once, at paste time, and stored locally, so viewing an annotation
 * never contacts a third party:
 *   - image / audio / video / PDF links: the file itself is copied into the doc's media
 *   - YouTube / Vimeo: title + thumbnail stored locally; the player is only loaded
 *     (privacy-enhanced mode) if someone clicks play
 *   - any other web page: a link card (title, site, author, date, preview image)
 * All requests go through cite.js's checks (public addresses only, limits, redirects).
 */
import crypto from 'node:crypto'
import { openUrl, bodyStream, isHtml, readBody, parseCitation } from './cite.js'
import { saveMedia } from './storage.js'

const MEDIA = /^(image\/(png|jpe?g|gif|webp|avif|svg\+xml)|audio\/|video\/|application\/pdf)/i
const mediaUrl = (docId, name) => `/api/docs/${docId}/media/${name}`
const fileName = (u) => {
  try {
    return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || new URL(u).hostname).slice(0, 120)
  } catch {
    return 'file'
  }
}

export function videoEmbed(input) {
  let u
  try {
    u = new URL(input)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^(www\.|m\.)/, '')
  let id = null
  if (host === 'youtu.be') id = u.pathname.slice(1)
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v') || /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(u.pathname)?.[1] || null
  }
  if (id && /^[\w-]{6,20}$/.test(id)) return { provider: 'YouTube', id, embed: `https://www.youtube-nocookie.com/embed/${id}`, thumbUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const vid = /\/(?:video\/)?(\d{5,12})(?:$|[/?#])/.exec(u.pathname)?.[1]
    if (vid) return { provider: 'Vimeo', id: vid, embed: `https://player.vimeo.com/video/${vid}?dnt=1` }
  }
  return null
}

/** Copy a remote image into the doc's media (for thumbnails). Returns a local URL or ''. */
async function saveRemoteImage(docId, url, opts) {
  if (!url) return ''
  try {
    const { res } = await openUrl(url, opts)
    const mime = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (!/^image\/(png|jpe?g|gif|webp|avif)$/.test(mime)) {
      res.resume()
      return ''
    }
    const { name } = await saveMedia(docId, mime === 'image/jpg' ? 'image/jpeg' : mime, bodyStream(res))
    return mediaUrl(docId, name)
  } catch {
    return ''
  }
}

async function pageDetails(url, opts) {
  try {
    const { res, finalUrl } = await openUrl(url, opts)
    if (!isHtml(res)) {
      res.resume()
      return null
    }
    return parseCitation(await readBody(res), finalUrl)
  } catch {
    return null
  }
}

export async function makeEmbed(docId, input, opts = {}) {
  const href = String(input || '').trim()
  const id = crypto.randomBytes(4).toString('hex')

  const video = videoEmbed(href)
  if (video) {
    const page = await pageDetails(href, opts)
    const thumb = await saveRemoteImage(docId, page?.image || video.thumbUrl, opts)
    return { id, type: 'video/embed', provider: video.provider, embed: video.embed, href, name: page?.title || `${video.provider} video`, title: page?.title || '', site: video.provider, thumb }
  }

  const { res, finalUrl } = await openUrl(href, opts)
  const mime = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (MEDIA.test(mime)) {
    const { name, size } = await saveMedia(docId, mime === 'image/jpg' ? 'image/jpeg' : mime, bodyStream(res))
    return { id, type: mime, url: mediaUrl(docId, name), name: fileName(finalUrl), size, href }
  }
  if (!isHtml(res)) {
    res.resume()
    throw Object.assign(new Error('That link isn’t a web page, image, audio or video'), { status: 422 })
  }
  const page = parseCitation(await readBody(res), finalUrl)
  const thumb = await saveRemoteImage(docId, page.image, opts)
  return {
    id,
    type: 'link',
    href: page.url || finalUrl,
    name: page.title || new URL(finalUrl).hostname,
    title: page.title,
    site: page.siteName || page.source,
    author: page.author,
    date: page.year,
    thumb,
  }
}
