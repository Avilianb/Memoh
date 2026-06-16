async function callOptionalMethod(target, methodName) {
  try {
    const method = target?.[methodName]
    if (typeof method !== 'function') return ''
    return (await Promise.resolve(method.call(target))) || ''
  } catch {
    return ''
  }
}

export async function collectContext(message, bot) {
  const talker = message.talker()
  const receiver = message.to()
  const room = message.room()
  const [talkerAlias, talkerName, receiverName, roomTopic] = await Promise.all([
    callOptionalMethod(talker, 'alias'),
    callOptionalMethod(talker, 'name'),
    callOptionalMethod(receiver, 'name'),
    callOptionalMethod(room, 'topic'),
  ])
  return {
    bot,
    talker,
    receiver,
    room,
    roomTopic: roomTopic || '',
    talkerAlias: talkerAlias || '',
    talkerName: talkerName || '',
    receiverName: receiverName || '',
  }
}
