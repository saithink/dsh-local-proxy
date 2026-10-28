/**
 * Browser half of `@local/dsh-local-proxy`.
 *
 * Provides a management panel embedded directly in the Plugin Details page:
 * - Real-time proxy status indicator & toggle
 * - Proxy server address & bypass configuration
 * - Presets for Clash (7890), v2rayN (10809), Sing-box (2080), Surge (6152)
 * - One-click connectivity & exit IP tester
 * - Live request routing audit logs
 */
window.__ModuleLoader__.load({
  id: 'dsh-local-proxy',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'dsh-local-proxy'
    const ROUTE = '/api/local-proxy'
    const BUNDLE_KEY = 'dsh-local-proxy'
    const ROW_KEY = 'dsh-local-proxy#local-proxy'

    // Built-in presets for popular proxy software
    const PRESETS = [
      { name: 'Clash Verge', port: '7897' },
      { name: 'Clash / Mihomo', port: '7890' },
      { name: 'v2rayN / Xray', port: '10809' },
      { name: 'Sing-box', port: '2080' },
      { name: 'Surge / SS', port: '6152' },
    ]

    const TEST_TARGETS = [
      { label: 'Cloudflare Trace (测速 + 出口 IP 探测)', url: 'https://cloudflare.com/cdn-cgi/trace' },
      { label: 'DeepSeek 官方 API (api.deepseek.com)', url: 'https://api.deepseek.com' },
      { label: 'GitHub API (api.github.com)', url: 'https://api.github.com' },
      { label: 'HttpBin IP (httpbin.org/ip)', url: 'https://httpbin.org/ip' },
    ]

    /**
     * Styles for the proxy panel (Auto adapts to Light and Dark modes).
     */
    const STYLES = `
      .lp-container {
        display: flex;
        flex-direction: column;
        width: 100%;
        box-sizing: border-box;
        font-family: inherit;
        color: var(--dsh-color-text, #1e293b);
        margin: 12px 0 24px 0;
        padding: 0;
      }
      .lp-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        background: var(--dsh-color-surface, rgba(125, 125, 125, 0.04));
        border: 1px solid var(--dsh-color-border, rgba(125, 125, 125, 0.15));
        border-radius: 10px;
        margin-bottom: 20px;
      }
      .lp-title-group h2 {
        margin: 0 0 4px 0;
        font-size: 16px;
        font-weight: 600;
        letter-spacing: -0.01em;
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--dsh-color-text, #0f172a);
      }
      .lp-title-group p {
        margin: 0;
        font-size: 13px;
        color: var(--dsh-color-text-muted, #64748b);
      }
      .lp-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 10px;
        border-radius: 9999px;
        font-size: 12px;
        font-weight: 500;
      }
      .lp-badge-active {
        background: rgba(34, 197, 94, 0.12);
        color: #16a34a;
        border: 1px solid rgba(34, 197, 94, 0.3);
      }
      .lp-badge-disabled {
        background: rgba(100, 116, 139, 0.12);
        color: var(--dsh-color-text-muted, #64748b);
        border: 1px solid rgba(100, 116, 139, 0.25);
      }
      .lp-badge-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
      }
      .lp-badge-active .lp-badge-dot {
        background: #22c55e;
        box-shadow: 0 0 6px rgba(34, 197, 94, 0.6);
      }
      .lp-badge-disabled .lp-badge-dot {
        background: #94a3b8;
      }
      .lp-grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 18px;
        margin-bottom: 18px;
      }
      @media (max-width: 860px) {
        .lp-grid-2 {
          grid-template-columns: 1fr;
        }
      }
      .lp-card {
        background: var(--dsh-color-surface, rgba(125, 125, 125, 0.03));
        border: 1px solid var(--dsh-color-border, rgba(125, 125, 125, 0.14));
        border-radius: 10px;
        padding: 18px;
        box-sizing: border-box;
      }
      .lp-card-header {
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        color: var(--dsh-color-text, #0f172a);
        border-bottom: 1px solid var(--dsh-color-border, rgba(125, 125, 125, 0.08));
        padding-bottom: 8px;
      }
      .lp-form-item {
        margin-bottom: 14px;
      }
      .lp-label {
        display: block;
        font-size: 12px;
        font-weight: 600;
        margin-bottom: 6px;
        color: var(--dsh-color-text, #334155);
      }
      .lp-input {
        width: 100%;
        padding: 8px 12px;
        border-radius: 6px;
        border: 1px solid var(--dsh-color-border, rgba(125, 125, 125, 0.22));
        background: var(--dsh-color-surface-input, rgba(125, 125, 125, 0.05));
        color: var(--dsh-color-text, #0f172a);
        font-size: 13px;
        box-sizing: border-box;
        outline: none;
        transition: all 0.2s;
      }
      .lp-input:focus {
        border-color: #2563eb;
        background: var(--dsh-color-surface-input, rgba(255, 255, 255, 0.9));
        box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
      }
      .lp-presets {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
      }
      .lp-preset-btn {
        background: rgba(125, 125, 125, 0.08);
        border: 1px solid rgba(125, 125, 125, 0.16);
        color: var(--dsh-color-text, #334155);
        border-radius: 6px;
        padding: 3px 8px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .lp-preset-btn:hover {
        background: rgba(37, 99, 235, 0.1);
        color: #2563eb;
        border-color: rgba(37, 99, 235, 0.3);
      }
      .lp-checkbox-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        margin-bottom: 12px;
        cursor: pointer;
        user-select: none;
      }
      .lp-checkbox-desc {
        font-size: 12px;
        color: var(--dsh-color-text-muted, #64748b);
        margin-top: 2px;
        line-height: 1.4;
      }
      .lp-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        border: none;
        transition: all 0.2s;
      }
      .lp-btn-primary {
        background: #2563eb;
        color: #ffffff;
      }
      .lp-btn-primary:hover {
        background: #1d4ed8;
      }
      .lp-btn-secondary {
        background: rgba(125, 125, 125, 0.1);
        color: var(--dsh-color-text, #334155);
        border: 1px solid rgba(125, 125, 125, 0.2);
      }
      .lp-btn-secondary:hover {
        background: rgba(125, 125, 125, 0.16);
      }
      .lp-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .lp-stat-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 10px;
        margin-bottom: 14px;
      }
      .lp-stat-box {
        background: rgba(125, 125, 125, 0.05);
        padding: 10px;
        border-radius: 6px;
        text-align: center;
        border: 1px solid rgba(125, 125, 125, 0.1);
      }
      .lp-stat-val {
        font-size: 16px;
        font-weight: 700;
        color: #2563eb;
      }
      .lp-stat-label {
        font-size: 11px;
        color: var(--dsh-color-text-muted, #64748b);
        margin-top: 2px;
      }
      .lp-test-res {
        margin-top: 14px;
        padding: 12px;
        border-radius: 6px;
        font-size: 12px;
        line-height: 1.5;
      }
      .lp-test-res.success {
        background: rgba(34, 197, 94, 0.08);
        border: 1px solid rgba(34, 197, 94, 0.3);
        color: #15803d;
      }
      .lp-test-res.error {
        background: rgba(239, 68, 68, 0.08);
        border: 1px solid rgba(239, 68, 68, 0.3);
        color: #b91c1c;
      }
      .lp-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .lp-table th {
        text-align: left;
        padding: 8px 12px;
        color: var(--dsh-color-text-muted, #64748b);
        border-bottom: 1px solid var(--dsh-color-border, rgba(125, 125, 125, 0.12));
      }
      .lp-table td {
        padding: 8px 12px;
        border-bottom: 1px solid var(--dsh-color-border, rgba(125, 125, 125, 0.06));
        color: var(--dsh-color-text, #1e293b);
      }
      .lp-route-tag {
        display: inline-block;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 600;
      }
      .lp-route-proxy {
        background: rgba(37, 99, 235, 0.12);
        color: #2563eb;
      }
      .lp-route-direct {
        background: rgba(100, 116, 139, 0.12);
        color: #64748b;
      }
    `

    /**
     * Main Proxy Configuration Panel.
     * Embedded directly inside the Plugin Details page.
     */
    function LocalProxyPanel(props) {
      const isInitialLoaded = useRef(false)
      const [config, setConfig] = useState({
        enabled: true,
        proxyUrl: 'http://127.0.0.1:7897',
        bypass: 'localhost, 127.0.0.1, ::1, 192.168.*',
        interceptHttp: true,
        injectEnv: true,
      })
      const [stats, setStats] = useState({ proxiedRequests: 0, directRequests: 0 })
      const [recentLogs, setRecentLogs] = useState([])
      const [saving, setSaving] = useState(false)
      const [saveMessage, setSaveMessage] = useState('')
      const [testTarget, setTestTarget] = useState(TEST_TARGETS[0].url)
      const [customTestTarget, setCustomTestTarget] = useState('')
      const [testing, setTesting] = useState(false)
      const [testResult, setTestResult] = useState(null)

      // Helper to extract port from URL
      const currentPort = (() => {
        try {
          const u = new URL(config.proxyUrl)
          return u.port || (u.protocol === 'https:' ? '443' : '80')
        } catch {
          const m = String(config.proxyUrl).match(/:(\d+)/)
          return m ? m[1] : '7897'
        }
      })()

      // Fetch live status without stomping on user-edited drafts
      const fetchStatus = useCallback(async () => {
        try {
          const res = await fetch(ROUTE + '/status')
          if (res.ok) {
            const data = await res.json()
            if (!isInitialLoaded.current && data.config) {
              setConfig(data.config)
              isInitialLoaded.current = true
            }
            if (data.stats) setStats(data.stats)
            if (data.recentLogs) setRecentLogs(data.recentLogs)
          }
        } catch (err) {
          console.warn('[local-proxy] failed to fetch status', err)
        }
      }, [])

      useEffect(() => {
        fetchStatus()
        const timer = setInterval(fetchStatus, 4000)
        return () => clearInterval(timer)
      }, [fetchStatus])

      // Handle config save
      const handleSave = async (overrideConfig) => {
        const payload = overrideConfig || config
        setSaving(true)
        setSaveMessage('')
        try {
          const res = await fetch(ROUTE + '/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
          if (res.ok) {
            const data = await res.json()
            setConfig(data.config)
            setSaveMessage(`✓ 已保存 ${payload.proxyUrl} (${payload.enabled ? '已启用' : '已停用'}) 并立即生效！`)
            setTimeout(() => setSaveMessage(''), 4000)
          } else {
            setSaveMessage('保存失败，请检查配置格式')
          }
        } catch (err) {
          setSaveMessage('保存出错: ' + err.message)
        } finally {
          setSaving(false)
        }
      }

      // Handle Quick Toggle
      const handleToggle = () => {
        const next = { ...config, enabled: !config.enabled }
        setConfig(next)
        handleSave(next)
      }

      // Apply port change specifically
      const handlePortChange = (newPort) => {
        try {
          const u = new URL(config.proxyUrl)
          u.port = newPort
          setConfig({ ...config, proxyUrl: u.href })
        } catch {
          setConfig({ ...config, proxyUrl: `http://127.0.0.1:${newPort}` })
        }
      }

      // Run connection test
      const handleRunTest = async () => {
        setTesting(true)
        setTestResult(null)
        try {
          const target = customTestTarget.trim() || testTarget
          const res = await fetch(ROUTE + '/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              targetUrl: target,
              proxyUrl: config.proxyUrl,
            }),
          })
          const data = await res.json()
          setTestResult(data)
        } catch (err) {
          setTestResult({
            success: false,
            error: '测试请求失败: ' + err.message,
          })
        } finally {
          setTesting(false)
        }
      }

      return h('div', { className: 'lp-container' }, [
        // Inject styles
        h('style', { key: 'styles' }, STYLES),

        // Header Section (Controls bar)
        h('div', { className: 'lp-header', key: 'header' }, [
          h('div', { className: 'lp-title-group' }, [
            h('h2', null, [
              '代理配置与管理',
              h(
                'span',
                {
                  className: `lp-badge ${config.enabled ? 'lp-badge-active' : 'lp-badge-disabled'}`,
                },
                [
                  h('span', { className: 'lp-badge-dot' }),
                  config.enabled ? '全局代理已开启' : '代理未启用 (直连模式)',
                ]
              ),
            ]),
            h('p', null, '设置后 DSH 全进程的大模型 API 请求、网络检索与工具访问将统一经由此代理转发'),
          ]),
          h('div', null, [
            h(
              'button',
              {
                className: `lp-btn ${config.enabled ? 'lp-btn-secondary' : 'lp-btn-primary'}`,
                onClick: handleToggle,
              },
              config.enabled ? '暂停 / 停用代理' : '立即启用代理'
            ),
          ]),
        ]),

        // Two-column layout: Left Settings | Right Test
        h('div', { className: 'lp-grid-2', key: 'grid' }, [
          // Left Card: Settings
          h('div', { className: 'lp-card' }, [
            h('div', { className: 'lp-card-header' }, [
              '代理服务器配置',
              saveMessage && h('span', { style: { fontSize: '12px', color: '#16a34a', fontWeight: 600 } }, saveMessage),
            ]),

            // Enable Switch Checkbox
            h('label', { className: 'lp-checkbox-item' }, [
              h('input', {
                type: 'checkbox',
                checked: config.enabled,
                onChange: (e) => setConfig({ ...config, enabled: e.target.checked }),
              }),
              h('div', null, [
                h('span', { style: { fontSize: '13px', fontWeight: 600, color: 'inherit' } }, '启用全局出站代理'),
                h('div', { className: 'lp-checkbox-desc' }, '开启后全进程 HTTP/HTTPS 访问统一走代理'),
              ]),
            ]),

            // Proxy Server Address & Port
            h('div', { className: 'lp-form-item' }, [
              h('div', { style: { display: 'flex', gap: '10px' } }, [
                h('div', { style: { flex: 1 } }, [
                  h('label', { className: 'lp-label' }, '代理地址 (完整 URL)'),
                  h('input', {
                    className: 'lp-input',
                    value: config.proxyUrl,
                    placeholder: 'http://127.0.0.1:7897',
                    onChange: (e) => setConfig({ ...config, proxyUrl: e.target.value }),
                  }),
                ]),
                h('div', { style: { width: '110px' } }, [
                  h('label', { className: 'lp-label' }, '快捷端口'),
                  h('input', {
                    className: 'lp-input',
                    style: { textAlign: 'center', fontWeight: 600 },
                    value: currentPort,
                    placeholder: '7897',
                    onChange: (e) => handlePortChange(e.target.value),
                  }),
                ]),
              ]),
              // Presets
              h('div', { className: 'lp-presets' }, [
                h('span', { style: { fontSize: '11px', color: 'var(--dsh-color-text-muted, #64748b)', lineHeight: '24px' } }, '常用快捷端口：'),
                ...PRESETS.map((p) =>
                  h(
                    'button',
                    {
                      key: p.name,
                      type: 'button',
                      className: 'lp-preset-btn',
                      style: currentPort === p.port ? { borderColor: '#2563eb', color: '#2563eb', fontWeight: 600, background: 'rgba(37, 99, 235, 0.1)' } : {},
                      onClick: () => {
                        const newUrl = `http://127.0.0.1:${p.port}`
                        const next = { ...config, proxyUrl: newUrl }
                        setConfig(next)
                        handleSave(next)
                      },
                    },
                    `${p.name} (:${p.port})`
                  )
                ),
              ]),
            ]),

            // Bypass list
            h('div', { className: 'lp-form-item' }, [
              h('label', { className: 'lp-label' }, '绕过白名单 (No Proxy)'),
              h('input', {
                className: 'lp-input',
                value: config.bypass,
                placeholder: 'localhost, 127.0.0.1, ::1',
                onChange: (e) => setConfig({ ...config, bypass: e.target.value }),
              }),
              h('div', { className: 'lp-checkbox-desc', style: { marginTop: '4px' } },
                '始终自动绕过本机环回地址（localhost, 127.0.0.1），保证 Web GUI 与本地 RPC 通信不受影响'
              ),
            ]),

            // Sub-options
            h('label', { className: 'lp-checkbox-item' }, [
              h('input', {
                type: 'checkbox',
                checked: config.interceptHttp,
                onChange: (e) => setConfig({ ...config, interceptHttp: e.target.checked }),
              }),
              h('div', null, [
                h('span', { style: { fontSize: '13px', color: 'inherit' } }, '拦截 Node 原生 http/https 模块'),
                h('div', { className: 'lp-checkbox-desc' }, '通过 CONNECT 隧道无损代理第三方库的底层请求'),
              ]),
            ]),

            h('label', { className: 'lp-checkbox-item' }, [
              h('input', {
                type: 'checkbox',
                checked: config.injectEnv,
                onChange: (e) => setConfig({ ...config, injectEnv: e.target.checked }),
              }),
              h('div', null, [
                h('span', { style: { fontSize: '13px', color: 'inherit' } }, '同步更新进程环境变量'),
                h('div', { className: 'lp-checkbox-desc' }, '设置 HTTP_PROXY / HTTPS_PROXY，让子进程命令（curl/git）同步走代理'),
              ]),
            ]),

            // Action Button
            h(
              'button',
              {
                className: 'lp-btn lp-btn-primary',
                style: { width: '100%', marginTop: '6px' },
                disabled: saving,
                onClick: () => handleSave(),
              },
              saving ? '正在保存并热重载...' : '保存配置并立即生效'
            ),
          ]),

          // Right Card: Test & Live Statistics
          h('div', { className: 'lp-card' }, [
            h('div', { className: 'lp-card-header' }, '运行监控与连通性测试'),

            // Metrics
            h('div', { className: 'lp-stat-grid' }, [
              h('div', { className: 'lp-stat-box' }, [
                h('div', { className: 'lp-stat-val' }, stats.proxiedRequests || 0),
                h('div', { className: 'lp-stat-label' }, '累计代理请求'),
              ]),
              h('div', { className: 'lp-stat-box' }, [
                h('div', { className: 'lp-stat-val', style: { color: 'var(--dsh-color-text-muted, #64748b)' } }, stats.directRequests || 0),
                h('div', { className: 'lp-stat-label' }, '累计直连请求'),
              ]),
              h('div', { className: 'lp-stat-box' }, [
                h('div', { className: 'lp-stat-val', style: { color: config.enabled ? '#16a34a' : '#ef4444' } },
                  config.enabled ? 'ACTIVE' : 'OFF'
                ),
                h('div', { className: 'lp-stat-label' }, '当前模式'),
              ]),
            ]),

            // Test form
            h('div', { className: 'lp-form-item' }, [
              h('label', { className: 'lp-label' }, '测试目标'),
              h(
                'select',
                {
                  className: 'lp-input',
                  style: { cursor: 'pointer' },
                  value: testTarget,
                  onChange: (e) => setTestTarget(e.target.value),
                },
                TEST_TARGETS.map((t) => h('option', { key: t.url, value: t.url }, t.label))
              ),
            ]),

            h('div', { className: 'lp-form-item' }, [
              h('label', { className: 'lp-label' }, '或自定义测试 URL'),
              h('input', {
                className: 'lp-input',
                placeholder: '留空则使用上述选中的测试目标',
                value: customTestTarget,
                onChange: (e) => setCustomTestTarget(e.target.value),
              }),
            ]),

            h(
              'button',
              {
                className: 'lp-btn lp-btn-secondary',
                style: { width: '100%' },
                disabled: testing,
                onClick: handleRunTest,
              },
              testing ? '正在通过代理探测网络...' : '立即测试代理连通性'
            ),

            // Test Result Banner
            testResult &&
              h(
                'div',
                {
                  className: `lp-test-res ${testResult.success ? 'success' : 'error'}`,
                },
                [
                  h('div', { style: { fontWeight: 600, marginBottom: '4px' } },
                    testResult.success ? '✓ 代理连接测试成功！' : '✗ 代理连接失败'
                  ),
                  testResult.latencyMs !== undefined &&
                    h('div', null, `往返延迟：${testResult.latencyMs} ms`),
                  testResult.statusCode &&
                    h('div', null, `HTTP 状态码：${testResult.statusCode}`),
                  testResult.ip &&
                    h('div', { style: { fontWeight: 600 } }, `检测到的出口公网 IP：${testResult.ip}`),
                  testResult.error &&
                    h('div', { style: { marginTop: '4px', wordBreak: 'break-all' } }, `错误信息：${testResult.error}`),
                ]
              ),
          ]),
        ]),

        // Audit Logs Card
        h('div', { className: 'lp-card', key: 'logs' }, [
          h('div', { className: 'lp-card-header' }, [
            '近期网络请求路由审计 (最近 25 条)',
            h(
              'button',
              {
                className: 'lp-preset-btn',
                onClick: fetchStatus,
              },
              '刷新审计记录'
            ),
          ]),
          recentLogs && recentLogs.length > 0
            ? h(
                'table',
                { className: 'lp-table' },
                [
                  h('thead', null, [
                    h('tr', null, [
                      h('th', { style: { width: '120px' } }, '时间'),
                      h('th', null, '目标域名 / Host'),
                      h('th', { style: { width: '140px' } }, '路由方式'),
                    ]),
                  ]),
                  h(
                    'tbody',
                    null,
                    recentLogs.map((log) =>
                      h('tr', { key: log.id }, [
                        h('td', { style: { color: 'var(--dsh-color-text-muted, #64748b)' } }, log.time),
                        h('td', { style: { fontFamily: 'monospace' } }, log.host),
                        h('td', null, [
                          h(
                            'span',
                            {
                              className: `lp-route-tag ${log.route === 'proxy' ? 'lp-route-proxy' : 'lp-route-direct'}`,
                            },
                            log.route === 'proxy' ? '🛡 代理转发 (PROXY)' : '⚡ 直连 (DIRECT)'
                          ),
                        ]),
                      ])
                    )
                  ),
                ]
              )
            : h('div', { style: { textAlign: 'center', padding: '16px', color: 'var(--dsh-color-text-muted, #64748b)', fontSize: '13px' } },
                '暂无近期请求记录。当 DSH 发起 API 请求、大模型调用或网页访问时，将在此处实时显示。'
              ),
        ]),
      ])
    }

    /**
     * Plug into Bundle config slot (rendered between description and rows on the Bundle Details page).
     */
    function BundleConfigRenderer(props) {
      if (props && props.view === 'summary') {
        return h('div', { style: { fontSize: '13px', color: 'var(--dsh-color-text-muted, #64748b)' } }, '本地网络代理配置已就绪')
      }
      return h(LocalProxyPanel, { embedded: true })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        if (!ctx || !ctx.slots) {
          console.warn('[local-proxy] ctx.slots is not available');
          return;
        }

        // 1. Core: Render directly in the Plugin Details page
        try {
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              { name: 'plugins.bundle.config', key: BUNDLE_KEY, locale: NS },
              BundleConfigRenderer
            )
          )
        } catch (e) {
          console.warn('[local-proxy] inject plugins.bundle.config failed:', e);
        }

        // 2. Also register for the row config
        try {
          ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register(
              { name: 'plugins.row.config', key: ROW_KEY, locale: NS },
              BundleConfigRenderer
            )
          )
        } catch (e) {
          console.warn('[local-proxy] inject plugins.row.config failed:', e);
        }
      },
    }
  },
})
