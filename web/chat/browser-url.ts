export function browserUrl(value: string): string | null {
  const text = value.trim();
  if (!text || /\s/.test(text)) return null;
  if (!/^https?:\/\//i.test(text) && !/^(localhost|127\.0\.0\.1|\[[\da-f:]+\]|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]|$)/i.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : (/^(localhost|127\.0\.0\.1)([:/]|$)/i.test(text) ? 'http://' : 'https://') + text);
    return ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
