import { z } from 'zod';

/**
 * Strict boolean tool parameter.
 * MCP clients sometimes send booleans as strings, so "false" must not become true.
 * Accepts real booleans, the strings "true"/"false"/"1"/"0" (case-insensitive, trimmed),
 * and the numbers 1 and 0. Anything else passes through unchanged and fails validation.
 */
const TRUE_STRINGS = new Set(['true', '1']);
const FALSE_STRINGS = new Set(['false', '0']);

export const bool = z.preprocess((value) => {
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(s)) return true;
    if (FALSE_STRINGS.has(s)) return false;
    return value;
  }
  if (value === 1) return true;
  if (value === 0) return false;
  return value;
}, z.boolean());
