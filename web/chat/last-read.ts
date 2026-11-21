function entries<T>(storage: string): [string, T][] {
  try {
    const saved = JSON.parse(localStorage.getItem(storage) ?? '[]')
    return Array.isArray(saved) ? saved.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string') : []
  } catch { return [] }
}

export function lastRead<T>(storage: string, key: string): T | undefined {
  return entries<T>(storage).find(entry => entry[0] === key)?.[1]
}

export function rememberRead<T>(storage: string, key: string, value: T, limit = 24) {
  try {
    const next = entries<T>(storage).filter(entry => entry[0] !== key)
    next.push([key, value])
    localStorage.setItem(storage, JSON.stringify(next.slice(-limit)))
  } catch { /* Reading from the host still works when browser storage is unavailable. */ }
}
