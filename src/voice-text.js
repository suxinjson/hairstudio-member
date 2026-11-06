// Format decimal text without rounding or converting accounting values.
export function formatSpokenAmount(value) {
  const text = String(value);
  const match = /^(-?\d+)\.(\d+)$/.exec(text);
  if (!match) return text;
  const fraction = match[2].replace(/0+$/, '');
  return match[1] + (fraction ? '.' + fraction : '');
}

// Also handle currency text submitted by installed clients and manual previews.
export function normalizeVoiceText(text) {
  return text
    .replace(/(?<![A-Za-z0-9_.+-])-?\d+\.\d+(?=\s*(?:元|块))/g, formatSpokenAmount)
    .replace(/([¥￥]\s*)(-?\d+\.\d+)(?![\d.])/g, (_match, prefix, amount) => prefix + formatSpokenAmount(amount));
}
