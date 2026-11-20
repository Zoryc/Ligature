import { describe, expect, it } from 'vitest'
import { originChecker, parseAllowedOrigins } from '../src/http/origins.ts'

describe('originChecker', () => {
  const prod = originChecker(['https://latex.example.org'], false)
  const dev = originChecker(['http://localhost:5173'], true)

  it('production: exact matches only', () => {
    expect(prod('https://latex.example.org')).toBe(true)
    expect(prod('http://latex.example.org')).toBe(false)
    expect(prod('http://localhost:5173')).toBe(false)
    expect(prod('http://bob.localhost:5173')).toBe(false)
    expect(prod(undefined)).toBe(false)
    expect(prod('null')).toBe(false)
  })

  it('development: any *.localhost, but nothing that merely contains localhost', () => {
    expect(dev('http://localhost:5173')).toBe(true)
    expect(dev('http://bob.localhost:5173')).toBe(true)
    expect(dev('http://a.b.localhost')).toBe(true)
    expect(dev('http://localhost.evil.com')).toBe(false)
    expect(dev('http://evil-localhost:5173')).toBe(false)
    expect(dev('https://evil.com/localhost')).toBe(false)
    expect(dev('http://evil.com#.localhost')).toBe(false)
    expect(dev(null)).toBe(false)
  })
})

describe('parseAllowedOrigins', () => {
  const fix = (raw: string) => {
    try { parseAllowedOrigins(raw); return null } catch (e) { return (e as Error).message }
  }

  it('accepts exact origins, trims entries, skips empty ones', () => {
    expect(parseAllowedOrigins(' https://latex.example.org , http://localhost:8080,,http://[::1]:3000 '))
      .toEqual(['https://latex.example.org', 'http://localhost:8080', 'http://[::1]:3000'])
    expect(parseAllowedOrigins('')).toEqual([])
  })

  it.each([
    ['https://latex.example.org/', 'https://latex.example.org'],
    ['https://latex.example.org/app', 'https://latex.example.org'],
    ['https://Latex.Example.ORG', 'https://latex.example.org'],
    ['HTTPS://latex.example.org', 'https://latex.example.org'],
    ['https://latex.example.org:443', 'https://latex.example.org'],
    ['http://latex.example.org:80/', 'http://latex.example.org'],
    ['https://user:pw@latex.example.org', 'https://latex.example.org'],
    ['https://latex.example.org?x=1', 'https://latex.example.org'],
    ['latex.example.org', 'https://latex.example.org'],
    ['latex.example.org/', 'https://latex.example.org'],
    ['localhost:8080', 'http://localhost:8080'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080'],
  ])('%s is refused with the fix %s', (bad, good) => {
    expect(fix(`https://ok.example.org,${bad}`)).toBe(
      `ALLOWED_ORIGINS entry "${bad}" is not an origin (scheme://host[:port], lowercase, no path or trailing slash); use "${good}"`)
    expect(parseAllowedOrigins(good)).toEqual([good])
  })

  it('other schemes and garbage are refused without a guess', () => {
    expect(fix('ftp://latex.example.org')).toMatch(/^ALLOWED_ORIGINS entry "ftp:\/\/latex.example.org" is not an origin \(.*\)$/)
    expect(fix('file:///srv')).not.toContain('use')
    expect(fix('https://')).not.toBeNull()
    expect(fix('*')).not.toBeNull()
  })
})
