import { randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { encodeFrame, FRAME_CONTROL, FRAME_DATA, FrameDecoder, FrameError, readFrames, type Frame } from '../src/framing.ts'
import { Channel, ProtocolError } from '../src/protocol.ts'

function decodeAll(chunks: Buffer[]): Frame[] {
  const d = new FrameDecoder()
  const out: Frame[] = []
  for (const c of chunks) {
    d.push(c)
    for (let f = d.next(); f; f = d.next()) out.push(f)
  }
  expect(d.pending).toBe(0)
  return out
}

/** Split a buffer at random points (including 0-length and 1-byte pieces). */
function randomSplit(buf: Buffer, seed: number): Buffer[] {
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s }
  const out: Buffer[] = []
  let i = 0
  while (i < buf.length) {
    const n = rnd() % 4 === 0 ? 1 : rnd() % 7000
    out.push(buf.subarray(i, i + n))
    i += n
  }
  return out
}

describe('framing', () => {
  const frames: Frame[] = [
    { type: FRAME_CONTROL, payload: Buffer.from(JSON.stringify({ t: 'job', x: 'é' })) },
    { type: FRAME_DATA, payload: Buffer.alloc(0) },
    { type: FRAME_DATA, payload: randomBytes(70_000) },
    { type: FRAME_CONTROL, payload: Buffer.from('{}') },
    { type: FRAME_DATA, payload: randomBytes(1024 * 1024) },
  ]
  const wire = Buffer.concat(frames.map(f => encodeFrame(f.type, f.payload)))

  it('round-trips in one chunk', () => {
    expect(decodeAll([wire])).toEqual(frames)
  })

  it('round-trips under arbitrary chunking', () => {
    for (let seed = 1; seed <= 25; seed++) expect(decodeAll(randomSplit(wire, seed))).toEqual(frames)
  })

  it('header layout is type:u8 length:u32be', () => {
    const b = encodeFrame(FRAME_DATA, Buffer.from('abc'))
    expect([...b]).toEqual([2, 0, 0, 0, 3, 0x61, 0x62, 0x63])
  })

  it('rejects unknown types and oversize lengths, and stays failed', () => {
    const d = new FrameDecoder()
    d.push(Buffer.from([9, 0, 0, 0, 0]))
    expect(() => d.next()).toThrow(FrameError)
    expect(() => d.push(Buffer.from([1]))).toThrow(FrameError)

    const d2 = new FrameDecoder({ control: 10, data: 10 })
    d2.push(Buffer.from([2, 0, 0, 0, 11]))
    expect(() => d2.next()).toThrow(/too large/)
    expect(() => encodeFrame(FRAME_DATA, Buffer.alloc(11), { control: 10, data: 10 })).toThrow(/too large/)
  })

  it('readFrames reports truncated streams', async () => {
    const s = new PassThrough()
    s.end(wire.subarray(0, wire.length - 1))
    const got: Frame[] = []
    await expect((async () => { for await (const f of readFrames(s)) got.push(f) })()).rejects.toThrow(/middle of a frame/)
    expect(got.length).toBe(frames.length - 1)
  })
})

describe('Channel', () => {
  function pair() {
    const aToB = new PassThrough()
    const bToA = new PassThrough()
    return { a: new Channel(bToA, aToB), b: new Channel(aToB, bToA), aToB, bToA }
  }

  it('carries control messages and sized data streams', async () => {
    const { a, b } = pair()
    const blob = randomBytes(3 * 1024 * 1024 + 17)
    const sending = (async () => {
      await a.send({ t: 'blob', hash: 'x'.repeat(64), size: blob.length })
      await a.sendData(blob.length, [blob.subarray(0, 5), blob.subarray(5)])
      await a.send({ t: 'done' })
    })()
    const m = await b.recv()
    expect(m).toEqual({ t: 'blob', hash: 'x'.repeat(64), size: blob.length })
    const parts: Buffer[] = []
    await b.recvData(blob.length, c => { parts.push(Buffer.from(c)) })
    expect(Buffer.concat(parts).equals(blob)).toBe(true)
    expect(parts.every(p => p.length <= 1024 * 1024)).toBe(true)
    expect(await b.recv()).toEqual({ t: 'done' })
    await sending
  })

  it('sendData enforces the announced size', async () => {
    const { a } = pair()
    await expect(a.sendData(3, [Buffer.from('abcd')])).rejects.toThrow(ProtocolError)
    await expect(a.sendData(5, [Buffer.from('abcd')])).rejects.toThrow(ProtocolError)
  })

  it('recvData rejects excess data and control frames in a data stream', async () => {
    const { a, b } = pair()
    void a.sendData(4, [Buffer.from('abcd')])
    await expect(b.recvData(3, () => {})).rejects.toThrow(/more data/)

    const p2 = pair()
    void p2.a.send({ t: 'done' })
    await expect(p2.b.recvData(3, () => {})).rejects.toThrow(/data frame/)
  })

  it('recv rejects non-JSON and untyped messages; null at end of stream', async () => {
    const s1 = new PassThrough()
    s1.end(encodeFrame(FRAME_CONTROL, Buffer.from('not json')))
    await expect(new Channel(s1, new PassThrough()).recv()).rejects.toThrow(ProtocolError)

    const s2 = new PassThrough()
    s2.end(encodeFrame(FRAME_CONTROL, Buffer.from('[1,2]')))
    await expect(new Channel(s2, new PassThrough()).recv()).rejects.toThrow(/without a type/)

    const s3 = new PassThrough()
    s3.end()
    expect(await new Channel(s3, new PassThrough()).recv()).toBeNull()
  })
})
