import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectContext } from './context.mjs'

test('collectContext accepts sync and async Wechaty accessors', async () => {
  const talker = {
    id: 'wxid_talker',
    alias: async () => 'Alias',
    name: () => 'Display Name',
  }
  const receiver = {
    id: 'wxid_receiver',
    name: () => 'Receiver Name',
  }
  const room = {
    id: 'room@chatroom',
    topic: async () => 'Room Topic',
  }

  const context = await collectContext({
    talker: () => talker,
    to: () => receiver,
    room: () => room,
  }, { id: 'bot' })

  assert.equal(context.talkerAlias, 'Alias')
  assert.equal(context.talkerName, 'Display Name')
  assert.equal(context.receiverName, 'Receiver Name')
  assert.equal(context.roomTopic, 'Room Topic')
})

test('collectContext tolerates missing or throwing accessors', async () => {
  const context = await collectContext({
    talker: () => ({ alias: () => { throw new Error('no alias') } }),
    to: () => undefined,
    room: () => ({ topic: () => undefined }),
  }, {})

  assert.equal(context.talkerAlias, '')
  assert.equal(context.talkerName, '')
  assert.equal(context.receiverName, '')
  assert.equal(context.roomTopic, '')
})
