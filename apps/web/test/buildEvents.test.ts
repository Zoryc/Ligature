import { describe, expect, it } from 'vitest'
import { BuildEvents } from '../src/lib/buildEvents.ts'
import { pagesInView } from '../src/lib/pdfLayout.ts'

describe('BuildEvents (review finding 5)', () => {
  it('ignores our own broadcast when it arrives BEFORE the HTTP result', () => {
    const b = new BuildEvents()
    b.begin()
    expect(b.onEvent({ buildId: 'mine', status: 'success' })).toBe('held')
    expect(b.succeeded('mine')).toEqual([])
    expect(b.inFlight).toBe(false)
  })

  it('ignores our own broadcast when it arrives AFTER the HTTP result', () => {
    const b = new BuildEvents()
    b.begin()
    expect(b.succeeded('mine')).toEqual([])
    expect(b.onEvent({ buildId: 'mine', status: 'success' })).toBe('ignore')
  })

  it("returns collaborators' builds that finished during ours (older: mention only)", () => {
    const b = new BuildEvents()
    b.begin()
    b.onEvent({ buildId: 'theirs', status: 'failure' })
    b.onEvent({ buildId: 'mine', status: 'success' })
    expect(b.succeeded('mine')).toEqual([{ buildId: 'theirs', status: 'failure' }])
    expect(b.onEvent({ buildId: 'later', status: 'success' })).toBe('show')
  })

  it('hands held events back when our compile fails', () => {
    const b = new BuildEvents()
    b.begin()
    b.onEvent({ buildId: 'theirs', status: 'success' })
    expect(b.failed()).toEqual([{ buildId: 'theirs', status: 'success' }])
    expect(b.inFlight).toBe(false)
    expect(b.onEvent({ buildId: 'next', status: 'success' })).toBe('show')
  })

  it('remembers a bounded number of own builds', () => {
    const b = new BuildEvents()
    for (let i = 0; i < 40; i++) { b.begin(); b.succeeded(`b${i}`) }
    expect(b.onEvent({ buildId: 'b39', status: 'success' })).toBe('ignore')
    expect(b.onEvent({ buildId: 'b0', status: 'success' })).toBe('show')
  })
})

describe('pagesInView (review finding 6)', () => {
  const layout = { heights: [100, 100, 100, 100, 100], padding: 10, gap: 10 }
  // pages at y = 10-110, 120-220, 230-330, 340-440, 450-550

  it('lists the pages that intersect the viewport', () => {
    expect(pagesInView(layout, 0, 50)).toEqual([0])
    expect(pagesInView(layout, 150, 100)).toEqual([1, 2])
    expect(pagesInView(layout, 1000, 100)).toEqual([])
  })

  it('extends by the margin', () => {
    expect(pagesInView(layout, 150, 100, 100)).toEqual([0, 1, 2, 3])
  })
})
