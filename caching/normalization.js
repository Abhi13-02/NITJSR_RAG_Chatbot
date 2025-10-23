// Normalization for cache keys (NFKC + trim + lowercase + collapse spaces + strip punctuation)

export function normalizeQuery(input, options = {}) {
  if (typeof input !== 'string') return '';
  const { keepStopwordCompression = false } = options;

  // Unicode normalize
  let s = input.normalize('NFKC');
  // Trim + lowercase
  s = s.trim().toLowerCase();
  // Collapse multiple spaces
  s = s.replace(/\s+/g, ' ');
  // Strip punctuation, keep letters, numbers, and spaces
  // Using Unicode categories: keep Letters (L), Numbers (N), and spaces
  s = s.replace(/[^\p{L}\p{N} ]+/gu, '');
  // Collapse spaces again after stripping
  s = s.replace(/\s+/g, ' ').trim();

  if (keepStopwordCompression) {
    // Optional: simple stopword compression hook (disabled by default)
    // Example: remove very common phrases that don’t change semantics much.
    // Keep minimal and conservative unless semantic cache is also used.
    const COMMON = [
      'please', 'tell', 'me', 'what', 'is', 'are', 'the', 'a', 'an', 'of', 'about'
    ];
    const words = s.split(' ').filter(w => !COMMON.includes(w));
    s = words.join(' ');
  }

  return s;
}

