import { describe, expect, it } from 'vitest'
import { cancelDialog, confirmDialog, dialogState, openDialog, promptDialog } from '../src/lib/dialogs.svelte.ts'

describe('dialogs', () => {
  it('cancelDialog resolves the open dialog with null and clears it', async () => {
    const p = promptDialog('Rename file', 'New name', 'big.bin')
    expect(dialogState.current?.title).toBe('Rename file')
    cancelDialog()
    expect(dialogState.current).toBeNull()
    await expect(p).resolves.toBeNull()
  })

  it('a cancelled confirmation is not confirmed', async () => {
    const p = confirmDialog('Delete', 'Delete it?')
    cancelDialog()
    await expect(p).resolves.toBe(false)
  })

  it('cancelDialog without an open dialog is a no-op; opening a second dialog cancels the first', async () => {
    cancelDialog()
    expect(dialogState.current).toBeNull()
    const first = openDialog({ title: 'one' })
    const second = openDialog({ title: 'two' })
    await expect(first).resolves.toBeNull()
    expect(dialogState.current?.title).toBe('two')
    dialogState.current?.resolve('')
    await expect(second).resolves.toBe('')
  })
})
