// Speed test: builds a large script on a running server and measures the editor in a real browser.
//
//   node scripts/stress.js --url http://127.0.0.1:8080 --user you --password '…' [--words 40000 --beats 200 --images 150]
//
// Creates a document called "Stress test …" in your account (move it to the trash afterwards).
// Needs Playwright with Chromium (npm i -g playwright && npx playwright install chromium).
import { createRequire } from 'node:module'
import zlib from 'node:zlib'
import * as Y from 'yjs'

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 ? process.argv[i + 1] : d
}
const BASE = arg('url', 'http://127.0.0.1:8080')
const USER = arg('user')
const PASS = arg('password')
const WORDS = Number(arg('words', 40000))
const BEATS = Number(arg('beats', 200))
const IMAGES = Number(arg('images', 150))
const SECTIONS = 6

let cookie = ''
async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'x-sidescript': '1', cookie, ...(body && !(body instanceof Buffer) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined,
  })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

// Minimal PNG encoder (solid colour with a stripe), so each image is distinct.
function png(w, h, rgb) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      const stripe = (x + y) % 60 < 8
      raw[o] = stripe ? 255 : rgb[0]
      raw[o + 1] = stripe ? 255 : rgb[1]
      raw[o + 2] = stripe ? 255 : rgb[2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const LEX = 'the keeper climbs spiral stairs storm glass waves research survey reading books students harbour tides sailors grade function definition experiment question answer video camera light shadow window coffee table couch archive library coastal report evidence claim quote source'.split(' ')
const sentence = (n) => {
  const w = Array.from({ length: n }, () => LEX[Math.floor(Math.random() * LEX.length)])
  w[0] = w[0][0].toUpperCase() + w[0].slice(1)
  return w.join(' ') + '.'
}

async function main() {
  if (!USER || !PASS) throw new Error('Pass --user and --password')
  await api('POST', '/api/login', { username: USER, password: PASS })

  // 1. Media: upload images to a holder document.
  const holder = (await api('POST', '/api/docs', { title: 'Stress test media' })).doc
  const urls = []
  for (let i = 0; i < IMAGES; i++) {
    const img = png(480, 270, [(i * 53) % 256, (i * 97) % 256, (i * 151) % 256])
    urls.push((await api('POST', `/api/docs/${holder.id}/media`, img, { 'content-type': 'image/png' })).url)
  }

  // 2. Build the script.
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('default')
  const beatsMap = doc.getMap('beats')
  const visualTypes = ['aroll', 'vlog', 'broll', 'montage', 'call', 'gfx']
  const statuses = ['pending', 'shoot', 'pendingupload', 'uploaded', 'edited']
  const wordsPerBeat = Math.round(WORDS / BEATS)
  let n = 0
  doc.transact(() => {
    doc.getMap('meta').set('title', `Stress test ${WORDS} words`)
    for (let s = 0; s < SECTIONS; s++) {
      const sec = new Y.XmlElement('section')
      sec.setAttribute('id', `s${s}`)
      const title = new Y.XmlElement('sectionTitle')
      title.insert(0, [new Y.XmlText(`Act ${s + 1}: ${sentence(5).slice(0, -1)}`)])
      const kids = [title]
      const count = Math.round(BEATS / SECTIONS)
      for (let b = 0; b < count; b++, n++) {
        const beat = new Y.XmlElement('beat')
        beat.setAttribute('id', `b${n}`)
        const paras = []
        let left = wordsPerBeat
        while (left > 0) {
          const len = Math.min(left, 30 + Math.floor(Math.random() * 50))
          const p = new Y.XmlElement('paragraph')
          let text = ''
          for (let k = 0; k < len; k += 12) text += sentence(Math.min(12, len - k)) + ' '
          p.insert(0, [new Y.XmlText(text.trim())])
          paras.push(p)
          left -= len
        }
        beat.insert(0, paras)
        kids.push(beat)
        const data = new Y.Map()
        beatsMap.set(`b${n}`, data)
        data.set('scene', `${s + 1}${String.fromCharCode(97 + (b % 26))}`)
        data.set('status', statuses[n % 4])
        data.set('visual', { type: visualTypes[n % 4], desc: sentence(6), images: n < IMAGES ? [{ id: `i${n}`, url: urls[n], thumb: urls[n], name: `still-${n}.png` }] : [] })
      }
      sec.insert(0, kids)
      frag.push([sec])
    }
  })
  const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
  const target = (await api('POST', '/api/docs', { title: `Stress test ${WORDS} words`, state })).doc
  console.log(`Created ${BASE}/d/${target.id}  (${(state.length / 1024).toFixed(0)} KB of document data)`)

  // 3. Measure in a browser.
  const { chromium } = createRequire(import.meta.url)('playwright')
  const browser = await chromium.launch()
  const results = {}
  for (const variant of [
    { name: 'document, pageless', layout: 'document', pages: 'pageless' },
    { name: 'document, pages', layout: 'document', pages: 'paged' },
    { name: 'table', layout: 'table', pages: 'pageless' },
    { name: 'document, pageless, no off-screen skipping', layout: 'document', pages: 'pageless', noSkip: true },
  ]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await ctx.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: BASE }])
    const page = await ctx.newPage()
    await page.addInitScript(([id, layout, noSkip]) => {
      localStorage.setItem(`sidescript:view:${id}`, JSON.stringify({ hidden: [], comments: true, mode: 'annotated', panel: null, group: 'position', layout }))
      if (noSkip) document.addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: '.beat{content-visibility:visible!important}' })))
    }, [target.id, variant.layout, variant.noSkip])
    // Page mode is a document setting; set it through the UI once loaded.
    const t0 = Date.now()
    await page.goto(`${BASE}/d/${target.id}`)
    await page.locator('.beat').first().waitFor()
    const firstBeat = Date.now() - t0
    await page.waitForFunction((count) => document.querySelectorAll('.beat').length >= count, Math.round(BEATS / SECTIONS) * SECTIONS)
    const allBeats = Date.now() - t0
    if (variant.pages === 'paged') await page.getByRole('radio', { name: /^Pages/ }).click()
    else await page.getByRole('radio', { name: /Pageless/ }).click()
    await page.waitForTimeout(1500)

    // Typing latency: key press -> text on screen, in a beat in the middle of the script.
    const mid = page.locator('.beat').nth(Math.floor(BEATS / 2)).locator('.beat-body p').first()
    await mid.scrollIntoViewIfNeeded()
    await mid.click()
    await page.keyboard.press('End')
    await page.evaluate(() => {
      window.__lat = []
      window.__down = 0
      document.addEventListener('keydown', () => (window.__down = performance.now()), true)
      new MutationObserver(() => {
        if (!window.__down) return
        const d = window.__down
        window.__down = 0
        requestAnimationFrame(() => window.__lat.push(performance.now() - d))
      }).observe(document.querySelector('.doc-body'), { characterData: true, childList: true, subtree: true })
    })
    for (const ch of ' quick typing test to measure latency') {
      await page.keyboard.type(ch)
      await page.waitForTimeout(25)
    }
    const lat = (await page.evaluate(() => window.__lat)).sort((a, b) => a - b)

    // Change a status in the middle of the table (field edit, not text).
    const t1 = Date.now()
    await page.evaluate(() => window.scrollTo(0, 0))
    const scroller = page.locator('.ed-scroll')
    const scrollStart = Date.now()
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight))
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const scrollToEnd = Date.now() - scrollStart
    void t1
    const mem = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null))
    results[variant.name] = {
      firstBeatMs: firstBeat,
      allBeatsMs: allBeats,
      typingMedianMs: +lat[Math.floor(lat.length / 2)]?.toFixed(1),
      typingP95Ms: +lat[Math.floor(lat.length * 0.95)]?.toFixed(1),
      jumpToEndMs: scrollToEnd,
      heapMB: mem,
      pages: variant.pages === 'paged' ? await page.locator('.page-controls').innerText().then((t) => t.match(/(\d+) pages?/)?.[1]) : undefined,
    }
    await ctx.close()
  }
  await browser.close()
  console.table(results)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
