import path from 'node:path'
export const APP_URL = 'su-music://app/'
export const DEVELOPMENT_URL = 'http://127.0.0.1:5173/'
export const PRODUCTION_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src su-music://media; object-src 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'"
export function isTrustedPage(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual), e = new URL(expected)
    return !a.username && !a.password && a.protocol === e.protocol && a.hostname === e.hostname && a.port === e.port &&
      a.pathname === e.pathname && a.search === e.search
  } catch { return false }
}
export function assetPath(root: string, requestURL: string): string | null {
  try {
    const url = new URL(requestURL)
    if (url.protocol !== 'su-music:' || url.hostname !== 'app' || url.username || url.password || url.port) return null
    const decoded = decodeURIComponent(url.pathname)
    if (decoded.includes('\0') || decoded.includes('\\')) return null
    const directory = path.resolve(root)
    const target = path.resolve(directory, '.' + (decoded === '/' ? '/index.html' : decoded))
    return target.startsWith(directory + path.sep) ? target : null
  } catch { return null }
}
export function safeCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)) return error.message
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) return error.code
  return 'INTERNAL_ERROR'
}
