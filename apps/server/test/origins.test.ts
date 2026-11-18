import { describe, expect, it } from 'vitest'
import { originChecker } from '../src/http/origins.ts'

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
