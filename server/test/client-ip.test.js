import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientIp } from '../auth.js'

const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } })

test('without a proxy the socket address is used and X-Forwarded-For is ignored', () => {
  assert.equal(clientIp(req('203.0.113.9', '1.2.3.4'), ['loopback']), '203.0.113.9')
  assert.equal(clientIp(req('::ffff:203.0.113.9'), ['loopback']), '203.0.113.9')
})

test('behind a loopback proxy the proxy-appended address is used', () => {
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.9'), ['loopback']), '203.0.113.9')
  assert.equal(clientIp(req('::1', 'spoofed, 203.0.113.9'), ['loopback']), '203.0.113.9')
  assert.equal(clientIp(req('127.0.0.1'), ['loopback']), '127.0.0.1')
})

test('chains of listed proxies are skipped; TRUST_PROXY=off trusts nothing', () => {
  assert.equal(clientIp(req('10.0.0.2', 'spoofed, 203.0.113.9, 10.0.0.5'), ['10.0.0.2', '10.0.0.5']), '203.0.113.9')
  assert.equal(clientIp(req('10.0.0.2', '203.0.113.9'), ['loopback']), '10.0.0.2')
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.9'), ['off']), '127.0.0.1')
})
