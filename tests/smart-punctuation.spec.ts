import {describe, expect, it} from 'vitest';
import {smartPunctuation} from '../web/chat/smart-punctuation.ts';

describe('smart punctuation in the chat composer', () => {
  it('uses opening and closing quotes and preserves text after the caret', () => {
    expect(smartPunctuation('say "later', 5, '"')).toEqual({text: 'say “later', caret: 5});
    expect(smartPunctuation('“hello"', 7, '"').text).toBe('“hello”');
    expect(smartPunctuation("don't", 4, "'").text).toBe('don’t');
  });
  it('converts only a newly completed dash or ellipsis and updates the caret', () => {
    expect(smartPunctuation('wait... here', 7, '.')).toEqual({text: 'wait… here', caret: 5});
    expect(smartPunctuation('hello--', 7, '-')).toEqual({text: 'hello—', caret: 6});
  });
  it('formats typed arrows', () => {
    expect(smartPunctuation('a ->', 4, '>').text).toBe('a →');
    expect(smartPunctuation('x =>', 4, '>').text).toBe('x ⇒');
    expect(smartPunctuation('<-', 2, '-').text).toBe('←');
  });
  it('leaves slash commands, inline code, and fenced code untouched', () => {
    for (const text of ['/ask "', '`const x = "', '``const x = "', '```js\nconst x = "']) {
      expect(smartPunctuation(text, text.length, '"').text).toBe(text);
    }
  });
});
