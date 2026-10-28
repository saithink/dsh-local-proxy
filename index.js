/**
 * Host half of `@local/dsh-local-proxy`.
 *
 * Provides full-process outbound proxy management for DeepSeek Harness:
 * 1. Global Undici Dispatcher injection (Node 18+ fetch / LLM requests / web tools)
 * 2. Native node:http and node:https CONNECT-tunnel interception
 * 3. Environment variable synchronization (HTTP_PROXY / HTTPS_PROXY etc.)
 * 4. Loopback and whitelist bypass protection
 * 5. Diagnostic connection testing and exit IP detection
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

/** Route base owned by this plugin. */
const ROUTE_BASE = '/api/local-proxy'

/** Default proxy configuration. */
const DEFAULT_CONFIG = {
  enabled: true,
  proxyUrl: 'http://127.0.0.1:7897',
  bypass: 'localhost, 127.0.0.1, ::1, [::1]',
  interceptHttp: true,
  injectEnv: true,
}

/** Proxy environment variable names to maintain. */
const PROXY_ENV_NAMES = [
  'http_proxy', 'HTTP_PROXY',
  'https_proxy', 'HTTPS_PROXY',
  'all_proxy', 'ALL_PROXY',
  'no_proxy', 'NO_PROXY',
]

/** Runtime state. */
const state = {
  config: { ...DEFAULT_CONFIG },
  savedConfig: null,
  previousDispatcher: null,
  activeDispatcher: null,
  previousEnv: {},
  httpPatched: false,
  stats: {
    proxiedRequests: 0,
    directRequests: 0,
    lastTestedAt: null,
    lastTestResult: null,
  },
  recentLogs: [],
  disposed: false,
}

/** Original http/https functions for unpatching. */
let originalHttpRequest = null
let originalHttpsRequest = null

/** Exported Cordis Config Schema for Harness Plugins settings page. */
export const Config = Schema.object({
  enabled: Schema.boolean().default(false).description('启用全局代理 / Enable outbound proxy'),
  proxyUrl: Schema.string('http://127.0.0.1:7890').description('代理服务器地址 / Proxy server URL (http://host:port)'),
  bypass: Schema.string('localhost, 127.0.0.1, ::1').description('绕过名单（逗号分隔）/ Bypass hosts (comma-separated)'),
  interceptHttp: Schema.boolean().default(true).description('拦截 Node 原生 http/https 模块 / Intercept Node http/https modules'),
  injectEnv: Schema.boolean().default(true).description('同步设置进程环境变量 / Sync process environment variables (HTTP_PROXY)'),
})

export const inject = ['webServer']

/**
 * Resolve state directory.
 */
function stateDir() {
  const base =
    (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 && process.env.DSH_HOME) ||
    (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.length > 0 && process.env.DSH_PROFILE_DIR) ||
    join(homedir(), '.dsh')
  return join(base, 'local-proxy')
}

function configFile() {
  return join(stateDir(), 'config.json')
}

/**
 * Check if hostname belongs to loopback addresses.
 */
function isLoopback(hostname) {
  if (!hostname) return true
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host === '::') return true
  if (host.startsWith('127.')) return true
  return false
}

/**
 * Check whether a target URL matches the bypass rules.
 */
function shouldBypass(url, bypassString) {
  try {
    const target = typeof url === 'string' ? new URL(url) : url
    const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (isLoopback(host)) return true

    const port = target.port || (target.protocol === 'https:' ? '443' : '80')
    const rawList = (bypassString || '').split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean)

    for (const item of rawList) {
      if (item === '*') return true
      const [entryHost, entryPort] = item.split(':')
      if (entryPort && entryPort !== port) continue
      const pattern = entryHost.replace(/^\*?\./, '')
      if (host === pattern || host.endsWith('.' + pattern)) return true
    }
  } catch {
    // If URL parsing fails, default to bypassing for safety
    return true
  }
  return false
}

/**
 * Record a routed request for live dashboard inspection.
 */
function logRequest(hostname, route) {
  if (route === 'proxy') state.stats.proxiedRequests++
  else state.stats.directRequests++

  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    time: new Date().toLocaleTimeString(),
    host: hostname || 'unknown',
    route, // 'proxy' | 'direct'
  }
  state.recentLogs.unshift(entry)
  if (state.recentLogs.length > 25) {
    state.recentLogs.pop()
  }
}

/**
 * Synchronize process environment variables.
 */
function updateEnvironmentVariables(config) {
  if (config.enabled && config.injectEnv && config.proxyUrl) {
    const normalizedBypass = [
      'localhost', '127.0.0.1', '::1', '[::1]',
      ...(config.bypass || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
    ].filter((v, i, arr) => arr.indexOf(v) === i).join(',')

    process.env.HTTP_PROXY = config.proxyUrl
    process.env.http_proxy = config.proxyUrl
    process.env.HTTPS_PROXY = config.proxyUrl
    process.env.https_proxy = config.proxyUrl
    process.env.ALL_PROXY = config.proxyUrl
    process.env.all_proxy = config.proxyUrl
    process.env.NO_PROXY = normalizedBypass
    process.env.no_proxy = normalizedBypass
    process.env.NODE_USE_ENV_PROXY = '1'
  } else {
    // Restore or clear
    for (const key of PROXY_ENV_NAMES) {
      if (state.previousEnv[key] !== undefined) {
        process.env[key] = state.previousEnv[key]
      } else {
        delete process.env[key]
      }
    }
    delete process.env.NODE_USE_ENV_PROXY
  }
}

/**
 * Update Undici global dispatcher.
 */
async function applyUndiciDispatcher(config, logger) {
  try {
    const undici = await import('undici')
    if (!state.previousDispatcher) {
      state.previousDispatcher = undici.getGlobalDispatcher()
    }

    if (!config.enabled || !config.proxyUrl) {
      if (state.previousDispatcher) {
        undici.setGlobalDispatcher(state.previousDispatcher)
      }
      if (state.activeDispatcher) {
        await state.activeDispatcher.close?.().catch(() => {})
        state.activeDispatcher = null
      }
      logger?.info?.('local-proxy: Undici global dispatcher restored to default direct routing')
      return
    }

    const { Agent, Pool, ProxyAgent } = undici
    const proxyUri = config.proxyUrl

    const dispatcher = new Agent({
      factory(origin, opts) {
        const originUrl = new URL(origin.toString())
        if (shouldBypass(originUrl, config.bypass)) {
          logRequest(originUrl.hostname, 'direct')
          return new Pool(origin, opts)
        }
        logRequest(originUrl.hostname, 'proxy')
        return new ProxyAgent({
          ...opts,
          uri: proxyUri,
        })
      },
    })

    undici.setGlobalDispatcher(dispatcher)
    if (state.activeDispatcher) {
      await state.activeDispatcher.close?.().catch(() => {})
    }
    state.activeDispatcher = dispatcher
    logger?.info?.(`local-proxy: Undici global dispatcher routed to ${proxyUri}`)
  } catch (error) {
    logger?.warn?.(`local-proxy: Failed to configure Undici dispatcher: ${String(error)}`)
  }
}

/**
 * Patch Node.js native http and https requests to forward non-bypassed requests via proxy.
 */
function patchNativeHttp(config, logger) {
  if (state.httpPatched) return

  originalHttpRequest = http.request
  originalHttpsRequest = https.request

  // Patch http.request
  http.request = function (...args) {
    if (!state.config.enabled || !state.config.interceptHttp || !state.config.proxyUrl) {
      return originalHttpRequest.apply(this, args)
    }

    const parsed = normalizeRequestArgs(args, 'http:')
    if (!parsed || shouldBypass(parsed.url, state.config.bypass)) {
      if (parsed) logRequest(parsed.url.hostname, 'direct')
      return originalHttpRequest.apply(this, args)
    }

    logRequest(parsed.url.hostname, 'proxy')
    // HTTP Proxy: rewrite request to proxy server with absolute URI
    const proxy = new URL(state.config.proxyUrl)
    const options = { ...parsed.options }
    options.host = proxy.hostname
    options.port = proxy.port || 80
    options.path = parsed.url.href
    options.headers = { ...options.headers, Host: parsed.url.host }
    return originalHttpRequest.call(http, options, parsed.callback)
  }

  // Patch https.request using CONNECT tunnel
  https.request = function (...args) {
    if (!state.config.enabled || !state.config.interceptHttp || !state.config.proxyUrl) {
      return originalHttpsRequest.apply(this, args)
    }

    const parsed = normalizeRequestArgs(args, 'https:')
    if (!parsed || shouldBypass(parsed.url, state.config.bypass)) {
      if (parsed) logRequest(parsed.url.hostname, 'direct')
      return originalHttpsRequest.apply(this, args)
    }

    logRequest(parsed.url.hostname, 'proxy')
    const proxy = new URL(state.config.proxyUrl)
    const targetHost = parsed.url.hostname
    const targetPort = parsed.url.port || 443

    const options = { ...parsed.options }
    options.createConnection = function (opts, oncreate) {
      const proxyReq = http.request({
        host: proxy.hostname,
        port: proxy.port || 80,
        method: 'CONNECT',
        path: `${targetHost}:${targetPort}`,
        headers: {
          Host: `${targetHost}:${targetPort}`,
          ...(proxy.username || proxy.password ? {
            'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64'),
          } : {}),
        },
      })

      proxyReq.on('connect', (res, socket) => {
        if (res.statusCode === 200) {
          const tlsSocket = tls.connect({
            socket,
            servername: targetHost,
            rejectUnauthorized: opts.rejectUnauthorized !== false,
          })
          oncreate(null, tlsSocket)
        } else {
          oncreate(new Error(`Proxy CONNECT returned HTTP ${res.statusCode}`))
        }
      })

      proxyReq.on('error', (err) => {
        oncreate(err)
      })

      proxyReq.end()
    }

    return originalHttpsRequest.call(https, options, parsed.callback)
  }

  state.httpPatched = true
  logger?.info?.('local-proxy: Patched node:http and node:https with CONNECT tunneling')
}

/**
 * Unpatch native http/https when unloaded.
 */
function unpatchNativeHttp() {
  if (originalHttpRequest) http.request = originalHttpRequest
  if (originalHttpsRequest) https.request = originalHttpsRequest
  state.httpPatched = false
}

/**
 * Helper to normalize arguments passed to http/https.request.
 */
function normalizeRequestArgs(args, protocol) {
  let options = {}
  let callback = null

  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    const url = new URL(args[0].toString())
    if (typeof args[1] === 'object' && args[1] !== null) {
      options = { ...args[1] }
      callback = typeof args[2] === 'function' ? args[2] : null
    } else if (typeof args[1] === 'function') {
      callback = args[1]
    }
    return { url, options, callback }
  } else if (typeof args[0] === 'object' && args[0] !== null) {
    options = { ...args[0] }
    callback = typeof args[1] === 'function' ? args[1] : null
    const host = options.hostname || options.host || 'localhost'
    const port = options.port || (protocol === 'https:' ? 443 : 80)
    const path = options.path || '/'
    try {
      const url = new URL(`${protocol}//${host}:${port}${path}`)
      return { url, options, callback }
    } catch {
      return null
    }
  }
  return null
}

/**
 * Test connectivity through proxy.
 */
async function testProxyConnection(targetUrl, proxyUrl) {
  const startTime = Date.now()
  const target = new URL(targetUrl || 'https://cloudflare.com/cdn-cgi/trace')
  const proxy = new URL(proxyUrl || state.config.proxyUrl)

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({
        success: false,
        latencyMs: Date.now() - startTime,
        error: 'Connection timed out after 10000ms',
      })
    }, 10000)

    try {
      const targetHost = target.hostname
      const targetPort = target.port || (target.protocol === 'https:' ? 443 : 80)

      if (target.protocol === 'https:') {
        const connectReq = http.request({
          host: proxy.hostname,
          port: proxy.port || 80,
          method: 'CONNECT',
          path: `${targetHost}:${targetPort}`,
          headers: {
            Host: `${targetHost}:${targetPort}`,
            ...(proxy.username || proxy.password ? {
              'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64'),
            } : {}),
          },
        })

        connectReq.on('connect', (res, socket) => {
          if (res.statusCode !== 200) {
            clearTimeout(timeout)
            return resolve({
              success: false,
              latencyMs: Date.now() - startTime,
              statusCode: res.statusCode,
              error: `Proxy tunnel rejected: HTTP ${res.statusCode}`,
            })
          }

          const tlsSocket = tls.connect({
            socket,
            servername: targetHost,
          }, () => {
            const req = https.request({
              hostname: targetHost,
              port: targetPort,
              path: target.pathname + target.search,
              method: 'GET',
              createConnection: () => tlsSocket,
              headers: {
                Host: targetHost,
                'User-Agent': 'DeepSeek-Harness-Local-Proxy-Tester/1.0',
              },
            }, (response) => {
              let body = ''
              response.on('data', chunk => { body += chunk })
              response.on('end', () => {
                clearTimeout(timeout)
                const latencyMs = Date.now() - startTime
                // Extract IP if cloudflare trace
                let detectedIp = null
                const ipMatch = body.match(/ip=([^\r\n]+)/) || body.match(/"origin"\s*:\s*"([^"]+)"/)
                if (ipMatch) detectedIp = ipMatch[1].trim()

                resolve({
                  success: response.statusCode >= 200 && response.statusCode < 400,
                  latencyMs,
                  statusCode: response.statusCode,
                  ip: detectedIp,
                  preview: body.slice(0, 200),
                })
              })
            })

            req.on('error', (err) => {
              clearTimeout(timeout)
              resolve({
                success: false,
                latencyMs: Date.now() - startTime,
                error: err.message,
              })
            })

            req.end()
          })

          tlsSocket.on('error', (err) => {
            clearTimeout(timeout)
            resolve({
              success: false,
              latencyMs: Date.now() - startTime,
              error: 'TLS handshake failed: ' + err.message,
            })
          })
        })

        connectReq.on('error', (err) => {
          clearTimeout(timeout)
          resolve({
            success: false,
            latencyMs: Date.now() - startTime,
            error: `Failed to connect to proxy server (${proxy.hostname}:${proxy.port || 80}): ${err.message}`,
          })
        })

        connectReq.end()
      } else {
        // Plain HTTP via proxy
        const req = http.request({
          host: proxy.hostname,
          port: proxy.port || 80,
          path: target.href,
          method: 'GET',
          headers: {
            Host: target.host,
            'User-Agent': 'DeepSeek-Harness-Local-Proxy-Tester/1.0',
          },
        }, (res) => {
          let body = ''
          res.on('data', chunk => { body += chunk })
          res.on('end', () => {
            clearTimeout(timeout)
            resolve({
              success: res.statusCode >= 200 && res.statusCode < 400,
              latencyMs: Date.now() - startTime,
              statusCode: res.statusCode,
              preview: body.slice(0, 200),
            })
          })
        })

        req.on('error', (err) => {
          clearTimeout(timeout)
          resolve({
            success: false,
            latencyMs: Date.now() - startTime,
            error: err.message,
          })
        })

        req.end()
      }
    } catch (error) {
      clearTimeout(timeout)
      resolve({
        success: false,
        latencyMs: Date.now() - startTime,
        error: error.message,
      })
    }
  })
}

/**
 * Load stored config file.
 */
async function loadSavedConfig() {
  try {
    const file = configFile()
    const content = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(content)
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return null
  }
}

/**
 * Save config file.
 */
async function persistConfig(newConfig) {
  const file = configFile()
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(newConfig, null, 2), 'utf8')
}

/**
 * Apply runtime config changes across all mechanisms.
 */
async function applyConfig(nextConfig, logger) {
  state.config = { ...state.config, ...nextConfig }
  updateEnvironmentVariables(state.config)
  await applyUndiciDispatcher(state.config, logger)
  if (state.config.interceptHttp) {
    patchNativeHttp(state.config, logger)
  }
}

/**
 * Parse incoming JSON body.
 */
async function readJson(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
  }
  return body ? JSON.parse(body) : {}
}

/**
 * Send JSON response.
 */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  })
  res.end(JSON.stringify(data))
}

/**
 * Cordis plugin entrypoint.
 */
export async function apply(ctx, rowConfig) {
  const logger = ctx.logger || console

  // Backup initial process environment
  for (const key of PROXY_ENV_NAMES) {
    state.previousEnv[key] = process.env[key]
  }

  // Layer configuration: rowConfig -> saved file config
  const saved = await loadSavedConfig()
  const initial = {
    ...DEFAULT_CONFIG,
    ...(rowConfig || {}),
    ...(saved || {}),
  }

  await applyConfig(initial, logger)

  // Web routes for frontend
  const route = {
    path: ROUTE_BASE,
    async handler(req, res) {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
      const subpath = url.pathname.slice(ROUTE_BASE.length)

      try {
        if (req.method === 'GET' && (subpath === '/status' || subpath === '')) {
          sendJson(res, 200, {
            config: state.config,
            stats: state.stats,
            recentLogs: state.recentLogs,
            envSummary: {
              HTTP_PROXY: process.env.HTTP_PROXY || null,
              HTTPS_PROXY: process.env.HTTPS_PROXY || null,
              NO_PROXY: process.env.NO_PROXY || null,
            },
          })
          return
        }

        if (req.method === 'POST' && subpath === '/config') {
          const body = await readJson(req)
          await persistConfig({ ...state.config, ...body })
          await applyConfig(body, logger)
          sendJson(res, 200, {
            success: true,
            config: state.config,
          })
          return
        }

        if (req.method === 'POST' && subpath === '/test') {
          const body = await readJson(req)
          const targetUrl = body.targetUrl || 'https://cloudflare.com/cdn-cgi/trace'
          const proxyUrl = body.proxyUrl || state.config.proxyUrl
          const testResult = await testProxyConnection(targetUrl, proxyUrl)

          state.stats.lastTestedAt = new Date().toISOString()
          state.stats.lastTestResult = testResult

          sendJson(res, 200, testResult)
          return
        }

        sendJson(res, 404, { error: 'Not found' })
      } catch (error) {
        logger.warn?.(`local-proxy: HTTP handler error: ${error.message}`)
        sendJson(res, 500, { error: error.message })
      }
    },
  }

  ctx.effect(() => ctx.webServer.register(route), 'local-proxy: web-routes')

  // Cleanup on unload/reload
  ctx.effect(
    () => () => {
      state.disposed = true
      unpatchNativeHttp()
      // Restore Undici dispatcher
      if (state.previousDispatcher) {
        import('undici').then(undici => {
          undici.setGlobalDispatcher(state.previousDispatcher)
        }).catch(() => {})
      }
      if (state.activeDispatcher) {
        state.activeDispatcher.close?.().catch(() => {})
      }
      // Restore environment variables
      updateEnvironmentVariables({ enabled: false })
      logger.info?.('local-proxy: Disposed and restored original network dispatchers')
    },
    'local-proxy: state-cleanup'
  )
}
