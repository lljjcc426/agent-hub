/** Converts only the just-typed punctuation, leaving pasted text and code intact. */
export function smartPunctuation(text: string, caret: number, inserted: string): {text: string; caret: number} {
  if (!['\"', "'", '.', '-', '>'].includes(inserted)) return {text, caret};
  const before = text.slice(0, caret), after = text.slice(caret);
  let codeDelimiter = ''
  for (const match of before.matchAll(/`+/g)) {
    if (!codeDelimiter) codeDelimiter = match[0]
    else if (match[0] === codeDelimiter) codeDelimiter = ''
  }
  if (before.startsWith('/') || codeDelimiter) return {text, caret};
  let replacement = before;
  if (inserted === '"' || inserted === "'") {
    const prefix = before.slice(0, -1);
    const opening = !prefix || /[\s([{—–]$/.test(prefix);
    replacement = prefix + (inserted === '"' ? (opening ? '“' : '”') : (opening ? '‘' : '’'));
  } else if (inserted === '.' && before.endsWith('...')) replacement = before.slice(0, -3) + '…';
  else if (inserted === '-' && before.endsWith('--')) replacement = before.slice(0, -2) + '—';
  else if (inserted === '>' && before.endsWith('->')) replacement = before.slice(0, -2) + '→';
  else if (inserted === '>' && before.endsWith('=>')) replacement = before.slice(0, -2) + '⇒';
  else if (inserted === '-' && before.endsWith('<-')) replacement = before.slice(0, -2) + '←';
  return {text: replacement + after, caret: replacement.length};
}
