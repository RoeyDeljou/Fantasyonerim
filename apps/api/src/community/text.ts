import { badRequest } from '../errors.js';

/** C0 controls except tab (\t) and newline (\n), DEL, and C1 controls. \r is normalized away first. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

/**
 * User text is stored and rendered as plain text (never HTML). Line endings are normalized to \n and
 * runs of 3+ blank lines collapsed; any other control character is a 400.
 */
export function cleanPlainText(value: string, field: string): string {
  const text = value.replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n');
  if (FORBIDDEN_CONTROL.test(text)) throw badRequest(`${field}: contains control characters`);
  return text;
}
