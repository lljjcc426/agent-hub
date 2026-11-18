export function pendingHref(conversation:string, item:string) {
  return '#conversation/'+conversation+'/pending/'+encodeURIComponent(item)
}
export function chatLocation(hash:string) {
  const match=/^#conversation\/([a-f0-9-]{36})(?:\/pending\/([^/]+))?$/.exec(hash)
  if (!match) return
  try { return {conversation:match[1]!, item:match[2] && decodeURIComponent(match[2])} }
  catch { return }
}
