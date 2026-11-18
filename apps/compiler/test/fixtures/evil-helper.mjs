// A misbehaving helper (as if the TeX run had taken it over): it answers the protocol with an output
// name outside OUTPUT_NAMES. Mode comes from argv[2]:
//   badname   result announces "../../escape"
//   bigsize   result announces an output.pdf larger than the cap
//   foreign   need list asks for a hash that is not in the manifest
//   crash     exits right after reading the job
//   linger    answers correctly (success, no outputs) and then never exits; writes its pid to argv[3]
import { writeFileSync } from 'node:fs'

const mode = process.argv[2]
if (mode === 'linger') {
  writeFileSync(process.argv[3], String(process.pid))
  setInterval(() => {}, 1000)
  process.stdin.on('end', () => { /* keep running after the worker closes our stdin */ })
}

function frame(obj) {
  const payload = Buffer.from(JSON.stringify(obj))
  const head = Buffer.alloc(5)
  head.writeUInt8(1, 0)
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

let buf = Buffer.alloc(0)
process.stdin.on('data', c => {
  buf = Buffer.concat([buf, c])
  while (buf.length >= 5) {
    const len = buf.readUInt32BE(1)
    if (buf.length < 5 + len) break
    const type = buf.readUInt8(0)
    const payload = buf.subarray(5, 5 + len)
    buf = buf.subarray(5 + len)
    if (type === 1) onMessage(JSON.parse(payload.toString()))
  }
})

function onMessage(m) {
  if (m.t === 'job') {
    if (mode === 'crash') process.exit(3)
    if (mode === 'foreign') process.stdout.write(frame({ t: 'need', hashes: ['f'.repeat(64)] }))
    else process.stdout.write(frame({ t: 'need', hashes: [] }))
  } else if (m.t === 'blobs-done' && mode === 'linger') {
    process.stdout.write(frame({ t: 'result', status: 'success', durationMs: 1, log: 'lingering', outputs: [] }))
    process.stdout.write(frame({ t: 'done' }))
  } else if (m.t === 'blobs-done') {
    const outputs = mode === 'bigsize' ? [{ name: 'output.pdf', size: 500 * 1024 * 1024 }] : [{ name: '../../escape', size: 4 }]
    process.stdout.write(frame({ t: 'result', status: 'success', durationMs: 1, log: 'evil', outputs }))
  }
}
