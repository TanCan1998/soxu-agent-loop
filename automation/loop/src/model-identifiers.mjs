// Windows launches Pi via cmd.exe: accept Unicode identifiers but never shell syntax,
// whitespace, control characters or option-like leading hyphens.
const SAFE_IDENTIFIER = /^(?:[A-Za-z0-9]|[^\x00-\x7f])(?:[A-Za-z0-9._:/+\\-]|[^\x00-\x7f])*$/u;
const SAFE_UNICODE = /^[\p{L}\p{N}\p{M}\p{S}]*$/u;
export function isModelIdentifier(value) {
  if (typeof value !== "string" || value.length > 180 || !SAFE_IDENTIFIER.test(value)) return false;
  return SAFE_UNICODE.test(value.replace(/[\x00-\x7f]/g, ""));
}
