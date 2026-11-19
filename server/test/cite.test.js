import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { parseCitation, fetchCitation, isPublicAddress } from '../cite.js'
import { videoEmbed } from '../embed.js'

test('journal pages: citation_* tags win (title, all authors, journal, year, pages, DOI)', () => {
  const html = `<html><head><title>Ignored | Journal</title>
    <meta name="citation_title" content="Coastal Erosion &amp; Sea Level Records">
    <meta name="citation_author" content="Smith, Jane"><meta name="citation_author" content="Lee, Ahn">
    <meta name="citation_journal_title" content="Journal of Coastal Studies">
    <meta name="citation_publication_date" content="2019/04/02">
    <meta name="citation_firstpage" content="12"><meta name="citation_lastpage" content="30">
    <meta name="citation_doi" content="https://doi.org/10.1000/xyz123">
    <meta property="og:site_name" content="Wiley"></head><body></body></html>`
  assert.deepEqual(parseCitation(html, 'https://example.org/a'), {
    title: 'Coastal Erosion & Sea Level Records', author: 'Smith, Jane; Lee, Ahn', source: 'Journal of Coastal Studies',
    year: '2019', date: '2019/04/02', pages: '12–30', doi: '10.1000/xyz123', url: 'https://example.org/a', siteName: 'Wiley', image: '',
  })
})

test('news pages: JSON-LD article data (author objects, publisher, date) and canonical URL', () => {
  const html = `<head><title>How fast is the coastline retreating? - Tidewatch</title>
    <link rel="canonical" href="https://example.org/articles/coastal-erosion/">
    <meta property="og:site_name" content="Tidewatch">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"page"},
      {"@type":"NewsArticle","headline":"How Fast Is the Coastline Retreating?","datePublished":"2022-11-03T10:00:00Z",
       "author":[{"@type":"Person","name":"Rowan Hale"}],"publisher":{"@type":"Organization","name":"Tidewatch Media"}}]}</script></head>`
  const c = parseCitation(html, 'https://example.org/articles/coastal-erosion/?utm=x')
  assert.equal(c.title, 'How Fast Is the Coastline Retreating?')
  assert.equal(c.author, 'Rowan Hale')
  assert.equal(c.source, 'Tidewatch')
  assert.equal(c.year, '2022')
  assert.equal(c.url, 'https://example.org/articles/coastal-erosion/')
})

test('plain pages fall back to Open Graph / <title>, stripping the site name; author URLs ignored', () => {
  const html = `<head><title>Why I Read Romance | Bean's Blog</title><meta property="og:site_name" content="Bean's Blog">
    <meta property="article:author" content="https://facebook.com/someone"><meta name="author" content="Sam Bean">
    <meta property="article:published_time" content="2024-01-05"></head>`
  const c = parseCitation(html, 'https://bean.blog/romance')
  assert.equal(c.title, 'Why I Read Romance')
  assert.equal(c.author, 'Sam Bean')
  assert.equal(c.source, "Bean's Blog")
  assert.equal(c.year, '2024')
})

test('private, loopback and metadata addresses are never fetched', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '64:ff9b::a9fe:a9fe'])
    assert.equal(isPublicAddress(ip), false, ip)
  for (const ip of ['93.184.216.34', '2606:4700::1111']) assert.equal(isPublicAddress(ip), true, ip)
  for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::ffff:7f00:1]/'])
    await assert.rejects(fetchCitation(url), /private network/, url)
  await assert.rejects(fetchCitation('file:///etc/passwd'), /Only http/)
  await assert.rejects(fetchCitation('http://example.com:22/'), /standard web ports/)
})

test('redirects are followed but each hop is checked; a real fetch parses the page', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/hop') return res.writeHead(302, { location: '/article' }).end()
    if (req.url === '/evil') return res.writeHead(302, { location: 'http://169.254.169.254/' }).end()
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<head><meta name="citation_title" content="Local test"><meta name="citation_date" content="2001"></head>')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    const c = await fetchCitation(`${base}/hop`, { allowPrivate: true })
    assert.equal(c.title, 'Local test')
    assert.equal(c.url, `${base}/article`)
    // Without the test-only switch the same local server is refused outright.
    await assert.rejects(fetchCitation(`${base}/hop`), /private network|standard web ports/)
  } finally {
    srv.close()
  }
})

test('YouTube and Vimeo links become privacy-enhanced embeds', () => {
  for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/shorts/dQw4w9WgXcQ'])
    assert.equal(videoEmbed(u)?.embed, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', u)
  assert.equal(videoEmbed('https://vimeo.com/76979871')?.embed, 'https://player.vimeo.com/video/76979871?dnt=1')
  assert.equal(videoEmbed('https://example.com/watch?v=dQw4w9WgXcQ'), null)
})
