import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

const REPOSITORY = 'ACGsu/su-music'
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const MAX_METADATA_BYTES = 2 * 1024 * 1024
const MAX_PACKAGE_BYTES = 300 * 1024 * 1024

export type Distribution = 'installed' | 'portable' | 'development'
export interface UpdateInfo {
  state: 'up-to-date' | 'available'
  currentVersion: string
  latestVersion: string
  distribution: Distribution
  releaseName: string | null
  publishedAt: string | null
  prerelease: boolean
  assetName: string | null
}

interface ReleaseAsset { name: string; size: number; browser_download_url: string }
interface ReleaseRecord {
  tag_name: string
  name: string | null
  draft: boolean
  prerelease: boolean
  published_at: string | null
  assets: ReleaseAsset[]
}
interface SelectedUpdate { info: UpdateInfo; package: ReleaseAsset; checksum: ReleaseAsset }
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

export class UpdateError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code }
}

const messages: Record<string, string> = {
  UPDATE_DEVELOPMENT_BUILD: '开发模式不执行在线更新，请先使用发行版本。',
  UPDATE_NETWORK_ERROR: '暂时无法连接 GitHub，请稍后重试。',
  UPDATE_RESPONSE_INVALID: 'GitHub 返回的版本资料无法确认。',
  UPDATE_PACKAGE_MISSING: '新版本尚未上传适用于当前版本形态的更新包。',
  UPDATE_CHECK_REQUIRED: '请先检查更新，再选择一键更新。',
  UPDATE_DOWNLOAD_FAILED: '更新包下载失败，请稍后重试。',
  UPDATE_CHECKSUM_INVALID: '更新包校验未通过，已停止更新。',
  UPDATE_DIRECTORY_UNWRITABLE: 'Portable EXE 所在目录不可写，请移动到可写目录后重试。',
  UPDATE_LAUNCH_FAILED: '更新程序未能启动，请稍后重试。'
}
export function updateMessage(error: unknown): string {
  return error instanceof UpdateError ? messages[error.code] ?? '更新未能完成，请稍后重试。' : '更新未能完成，请稍后重试。'
}

function parseVersion(input: string): { core: number[]; prerelease: string[] } {
  const value = input.replace(/^v/, '')
  if (!VERSION_PATTERN.test(value)) throw new UpdateError('UPDATE_RESPONSE_INVALID')
  const withoutBuild = value.split('+', 1)[0]!
  const separator = withoutBuild.indexOf('-')
  const core = separator < 0 ? withoutBuild : withoutBuild.slice(0, separator), prerelease = separator < 0 ? '' : withoutBuild.slice(separator + 1)
  return { core: core.split('.').map(Number), prerelease: prerelease ? prerelease.split('.') : [] }
}
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left), b = parseVersion(right)
  for (let index = 0; index < 3; index++) {
    const difference = a.core[index]! - b.core[index]!
    if (difference) return Math.sign(difference)
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index++) {
    const av = a.prerelease[index], bv = b.prerelease[index]
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1
    if (av === bv) continue
    const an = /^\d+$/.test(av), bn = /^\d+$/.test(bv)
    if (an && bn) return Number(av) < Number(bv) ? -1 : 1
    if (an !== bn) return an ? -1 : 1
    return av < bv ? -1 : 1
  }
  return 0
}

function checkedReleaseUrl(input: string, api = false): URL {
  let url: URL
  try { url = new URL(input) } catch { throw new UpdateError('UPDATE_RESPONSE_INVALID') }
  if (url.protocol !== 'https:' || url.username || url.password) throw new UpdateError('UPDATE_RESPONSE_INVALID')
  if (api) {
    if (url.hostname !== 'api.github.com' || url.pathname !== `/repos/${REPOSITORY}/releases`) throw new UpdateError('UPDATE_RESPONSE_INVALID')
  } else if (url.hostname === 'github.com') {
    if (!url.pathname.startsWith(`/${REPOSITORY}/releases/download/`)) throw new UpdateError('UPDATE_RESPONSE_INVALID')
  } else if (!['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(url.hostname)) {
    throw new UpdateError('UPDATE_RESPONSE_INVALID')
  }
  return url
}

async function responseWithRedirects(fetcher: Fetcher, input: string, headers: Record<string, string>, api = false): Promise<Response> {
  let url = checkedReleaseUrl(input, api)
  for (let redirects = 0; redirects <= 5; redirects++) {
    let response: Response
    try { response = await fetcher(url.href, { headers, redirect: 'manual' }) }
    catch { throw new UpdateError('UPDATE_NETWORK_ERROR') }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    if (!location) throw new UpdateError('UPDATE_RESPONSE_INVALID')
    url = checkedReleaseUrl(new URL(location, url).href)
  }
  throw new UpdateError('UPDATE_RESPONSE_INVALID')
}

async function responseBytes(response: Response, limit: number, failureCode: string): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new UpdateError(failureCode)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > limit) throw new UpdateError(failureCode)
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) { await reader.cancel(); throw new UpdateError(failureCode) }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

function assetName(version: string, distribution: Distribution): string {
  return distribution === 'portable' ? `Su-Music-${version}-x64-portable.exe` : `Su-Music-${version}-x64-setup.exe`
}
function validAsset(value: unknown): value is ReleaseAsset {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.name === 'string' && item.name.length <= 180 && typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size >= 0 &&
    typeof item.browser_download_url === 'string' && item.browser_download_url.length <= 2048
}
function validRelease(value: unknown): value is ReleaseRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.tag_name === 'string' && item.tag_name.length <= 100 && (item.name === null || typeof item.name === 'string' && item.name.length <= 200) &&
    typeof item.draft === 'boolean' && typeof item.prerelease === 'boolean' && (item.published_at === null || typeof item.published_at === 'string') &&
    Array.isArray(item.assets) && item.assets.length <= 100 && item.assets.every(validAsset)
}

async function hashFile(filename: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filename)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

const helperSource = `param(
  [Parameter(Mandatory=$true)][ValidateSet('installer','portable')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$Package,
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][int]$WaitFor,
  [Parameter(Mandatory=$true)][string]$Log
)
$ErrorActionPreference='Stop'
try {
  Wait-Process -Id $WaitFor -ErrorAction SilentlyContinue
  if ($Mode -eq 'installer') {
    $process=Start-Process -FilePath $Package -ArgumentList '/S' -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "INSTALLER_EXIT_$($process.ExitCode)" }
  } else {
    $replaced=$false
    for ($attempt=0; $attempt -lt 120; $attempt++) {
      try { Move-Item -LiteralPath $Package -Destination $Target -Force; $replaced=$true; break }
      catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $replaced) { throw 'PORTABLE_REPLACE_FAILED' }
  }
  if (Test-Path -LiteralPath $Target) { Start-Process -FilePath $Target }
} catch {
  Set-Content -LiteralPath $Log -Value $_.Exception.Message -Encoding UTF8
  if (Test-Path -LiteralPath $Target) { Start-Process -FilePath $Target }
  exit 1
}
`

export class UpdateService {
  private selected: SelectedUpdate | null = null
  private readonly options: {
    currentVersion: string
    distribution: Distribution
    userData: string
    executable: string
    portableExecutable: string | null
    fetcher: Fetcher
  }
  constructor(options: UpdateService['options']) { this.options = options }

  async check(): Promise<UpdateInfo> {
    if (this.options.distribution === 'development') throw new UpdateError('UPDATE_DEVELOPMENT_BUILD')
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': `Su-Music/${this.options.currentVersion}`, 'X-GitHub-Api-Version': '2022-11-28' }
    const response = await responseWithRedirects(this.options.fetcher, API_URL, headers, true)
    const bytes = await responseBytes(response, MAX_METADATA_BYTES, response.status === 403 || response.status === 429 ? 'UPDATE_NETWORK_ERROR' : 'UPDATE_RESPONSE_INVALID')
    let value: unknown
    try { value = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new UpdateError('UPDATE_RESPONSE_INVALID') }
    if (!Array.isArray(value) || value.length > 20 || !value.every(validRelease)) throw new UpdateError('UPDATE_RESPONSE_INVALID')
    const currentIsPrerelease = this.options.currentVersion.includes('-')
    const candidates = value.filter(item => !item.draft && (currentIsPrerelease || !item.prerelease)).map(item => ({ release: item, version: item.tag_name.replace(/^v/, '') }))
      .filter(item => VERSION_PATTERN.test(item.version)).sort((a, b) => compareVersions(b.version, a.version))
    const latest = candidates[0]
    if (!latest || compareVersions(latest.version, this.options.currentVersion) <= 0) {
      this.selected = null
      return { state: 'up-to-date', currentVersion: this.options.currentVersion, latestVersion: latest?.version ?? this.options.currentVersion,
        distribution: this.options.distribution, releaseName: latest?.release.name ?? null, publishedAt: latest?.release.published_at ?? null,
        prerelease: latest?.release.prerelease ?? currentIsPrerelease, assetName: null }
    }
    const name = assetName(latest.version, this.options.distribution)
    const packageAsset = latest.release.assets.find(item => item.name === name)
    const checksumAsset = latest.release.assets.find(item => item.name === name + '.sha256')
    if (!packageAsset || packageAsset.size < 1024 * 1024 || packageAsset.size > MAX_PACKAGE_BYTES || !checksumAsset || checksumAsset.size > 4096) throw new UpdateError('UPDATE_PACKAGE_MISSING')
    checkedReleaseUrl(packageAsset.browser_download_url); checkedReleaseUrl(checksumAsset.browser_download_url)
    const info: UpdateInfo = { state: 'available', currentVersion: this.options.currentVersion, latestVersion: latest.version,
      distribution: this.options.distribution, releaseName: latest.release.name, publishedAt: latest.release.published_at,
      prerelease: latest.release.prerelease, assetName: name }
    this.selected = { info, package: packageAsset, checksum: checksumAsset }
    return info
  }

  async stageAndLaunch(): Promise<UpdateInfo> {
    const selected = this.selected
    if (!selected) throw new UpdateError('UPDATE_CHECK_REQUIRED')
    const directory = path.join(this.options.userData, 'updates')
    fs.mkdirSync(directory, { recursive: true })
    if (selected.info.distribution === 'portable') this.ensurePortableDirectoryWritable()
    const headers = { Accept: 'application/octet-stream', 'User-Agent': `Su-Music/${this.options.currentVersion}` }
    const checksumResponse = await responseWithRedirects(this.options.fetcher, selected.checksum.browser_download_url, headers)
    const checksumBytes = await responseBytes(checksumResponse, 4096, 'UPDATE_DOWNLOAD_FAILED')
    const checksumText = new TextDecoder().decode(checksumBytes).trim()
    const checksumMatch = /^([a-fA-F0-9]{64})\s+\*?([^\r\n]+)$/.exec(checksumText)
    if (!checksumMatch || path.basename(checksumMatch[2]!.trim()) !== selected.package.name) throw new UpdateError('UPDATE_CHECKSUM_INVALID')
    const expectedHash = checksumMatch[1]!.toLowerCase()
    const destination = path.join(directory, selected.package.name), partial = destination + '.part'
    fs.rmSync(partial, { force: true })
    const packageResponse = await responseWithRedirects(this.options.fetcher, selected.package.browser_download_url, headers)
    if (!packageResponse.ok || !packageResponse.body) throw new UpdateError('UPDATE_DOWNLOAD_FAILED')
    const declared = Number(packageResponse.headers.get('content-length') ?? selected.package.size)
    if (declared > MAX_PACKAGE_BYTES || declared < 1024 * 1024) throw new UpdateError('UPDATE_DOWNLOAD_FAILED')
    const file = await fs.promises.open(partial, 'w', 0o600)
    let total = 0
    try {
      const reader = packageResponse.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_PACKAGE_BYTES) { await reader.cancel(); throw new UpdateError('UPDATE_DOWNLOAD_FAILED') }
        let offset = 0
        while (offset < value.byteLength) {
          const { bytesWritten } = await file.write(value, offset, value.byteLength - offset)
          if (!bytesWritten) throw new UpdateError('UPDATE_DOWNLOAD_FAILED')
          offset += bytesWritten
        }
      }
    } catch (error) {
      throw error instanceof UpdateError ? error : new UpdateError('UPDATE_DOWNLOAD_FAILED')
    } finally { await file.close() }
    if (total !== selected.package.size || await hashFile(partial) !== expectedHash) { fs.rmSync(partial, { force: true }); throw new UpdateError('UPDATE_CHECKSUM_INVALID') }
    fs.rmSync(destination, { force: true }); fs.renameSync(partial, destination)
    const helper = path.join(directory, 'apply-update.ps1'), log = path.join(directory, 'update-error.txt')
    fs.writeFileSync(helper, helperSource, { encoding: 'utf8', mode: 0o600 }); fs.rmSync(log, { force: true })
    const target = selected.info.distribution === 'portable' ? this.options.portableExecutable : this.options.executable
    if (!target) throw new UpdateError('UPDATE_LAUNCH_FAILED')
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    try {
      const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
        '-Mode', selected.info.distribution === 'portable' ? 'portable' : 'installer', '-Package', destination, '-Target', target, '-WaitFor', String(process.pid), '-Log', log],
      { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
    } catch { throw new UpdateError('UPDATE_LAUNCH_FAILED') }
    return selected.info
  }

  private ensurePortableDirectoryWritable(): void {
    const executable = this.options.portableExecutable
    if (!executable) throw new UpdateError('UPDATE_DIRECTORY_UNWRITABLE')
    const directory = path.dirname(executable), probe = path.join(directory, `.su-music-update-${process.pid}.tmp`)
    try { fs.writeFileSync(probe, '', { flag: 'wx' }); fs.rmSync(probe) }
    catch { fs.rmSync(probe, { force: true }); throw new UpdateError('UPDATE_DIRECTORY_UNWRITABLE') }
  }
}
