const crypto = require('crypto');
const https = require('https');

// ==========================================
// 🌟 1. 全局記憶體與控制變數（完美功能核心，死記不忘）
// ==========================================
let recentKeys = [];
let lastRotateTime = Date.now();

let useForceRotate = false;
let rotateUnit = "d"; 
let rotateValue = 1;  
let selectIPCount = 3; // 預設撈取 3 條優選 IP

// 💡 核心修正：固定你的 WARP 賬戶資訊，拒絕每次動態註冊！
let lockedPrivateKey = "你的_WARP_PRIVATE_KEY_請在控制台修改"; 
let lockedPublicKey = "你的_WARP_PUBLIC_KEY_請在控制台修改";
let lockedReserved = "0,0,0"; // 支援 3x-ui 格式的 0,0,0 或 hex

// 💡 新增功能：自訂 Rules 儲存變數
let customRulesText = "# 在此輸入自訂 Rules，每行一條\n# 例如：\n# - DOMAIN-SUFFIX,google.com,PROXY";

// 封裝 GET 請求（支援超時，用於從 GitHub 撈取海量優選大數據）
function httpGet(url) {
    return new Promise((resolve) => {
        const options = {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 3000
        };
        https.get(url, options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve(body));
        }).on('error', () => resolve(''));
    });
}

function getRotateMs(value, unit) {
    const val = parseInt(value) || 1;
    switch(unit) {
        case 's': return val * 1000;
        case 'm': return val * 60 * 1000;
        case 'h': return val * 60 * 60 * 1000;
        case 'd': return val * 24 * 60 * 60 * 1000;
        case 'w': return val * 7 * 24 * 60 * 60 * 1000;
        case 'y': return val * 365 * 24 * 60 * 60 * 1000;
        default: return 24 * 60 * 60 * 1000;
    }
}

export default async function handler(request, response) {
    const userAgent = (request.headers['user-agent'] || '').toLowerCase();
    const { method, query } = request;

    const clientCountry = request.headers['x-vercel-ip-country'] || 'HK';
    const clientIP = request.headers['x-vercel-forwarded-for'] || '127.0.0.1';
    const hostUrl = `https://${request.headers.host}${request.url.split('?')[0]}`;
    
    const isSingBox = userAgent.includes('sing-box') || query.type === 'singbox';
    const isStashOrClash = userAgent.includes('stash') || userAgent.includes('clash') || query.type === 'stash' || query.type === 'clash';

    // ==========================================
    // ⚙️ 2. 處理控制台 POST 表單提交（原功能 + 賬戶鎖定 + 自訂 Rules）
    // ==========================================
    if (method === 'POST') {
        let body = '';
        await new Promise((resolve) => {
            request.on('data', chunk => body += chunk);
            request.on('end', resolve);
        });
        try {
            const params = new URLSearchParams(body);
            const action = params.get('action');
            
            if (action === 'save_all') {
                lockedPrivateKey = params.get('custom_key') || "";
                lockedPublicKey = params.get('public_key') || "";
                lockedReserved = params.get('reserved_val') || "0,0,0";
                customRulesText = params.get('custom_rules') || "";
                
                useForceRotate = params.get('use_force') === 'true';
                rotateUnit = params.get('rotate_unit') || 'd';
                rotateValue = parseInt(params.get('rotate_value')) || 1;
                selectIPCount = Math.max(1, Math.min(20, parseInt(params.get('ip_count')) || 3));
            } else if (action === 'force_now') {
                lastRotateTime = 0;
            }
        } catch (e) {}
        response.writeHead(302, { Location: request.url });
        return response.end();
    }

    try {
        // ==========================================
        // ⏱️ 3. 轉生與密鑰歷史控制核心（Edgetunnel 洗牌模式）
        // ==========================================
        const now = Date.now();
        const duration = getRotateMs(rotateValue, rotateUnit);
        const isExpired = (now - lastRotateTime) >= duration;

        // 歷史記錄器：記錄每次成功更換優選 IP 的時間點與當前 PrivateKey
        if (isExpired || recentKeys.length === 0) {
            lastRotateTime = now;
            const logEntry = `${new Date().toLocaleTimeString()} - 使用 Key: ${lockedPrivateKey.slice(0,8)}...`;
            if (!recentKeys.includes(logEntry)) recentKeys.unshift(logEntry);
        }
        if (recentKeys.length > 10) recentKeys = recentKeys.slice(0, 10);

        // ==========================================
        // 🔍 4. 去 GitHub 搵搵：動態爬取海量非官方 WARP 優選中轉 IP
        // ==========================================
        let githubIPs = [];
        // 爬取市面上最主流的幾個每日優選大數據更新源
        const sources = [
            'https://raw.githubusercontent.com/banyao2000/warp-speed/main/api/ip.txt',
            'https://raw.githubusercontent.com/fscarmen/warp/main/api/ip.txt'
        ];
        
        for (const src of sources) {
            const rawText = await httpGet(src);
            if (rawText && rawText.length > 10) {
                // 解析格式如 "162.159.192.1:2408" 或 "ip" 的行
                const lines = rawText.split('\n');
                lines.forEach(line => {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith('#')) {
                        let ip = trimmed.split(':')[0];
                        let port = trimmed.split(':')[1] || "854";
                        if (ip && /^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
                            githubIPs.push({ ip, port: parseInt(port) });
                        }
                    }
                });
            }
            if (githubIPs.length > 0) break; 
        }

        // 如果 GitHub 暫時抽風，走備用高穿透 IP 段
        if (githubIPs.length === 0) {
            githubIPs = [
                { ip: '162.159.192.1', port: 854 },
                { ip: '162.159.193.5', port: 4500 },
                { ip: '162.159.195.12', port: 854 },
                { ip: '188.114.97.3', port: 854 }
            ];
        }

        // 🧠 隨機洗牌洗出你要的數量，達到真正的動態高強穿透
        let shuffled = githubIPs.sort(() => 0.5 - Math.random());
        let finalIPList = shuffled.slice(0, selectIPCount);

        // ==========================================
        // 💡 5. 解析 3x-ui 格式的 Reserved
        // ==========================================
        let sbReservedArr = [0, 0, 0];
        let stashReservedStr = "[0x00, 0x00, 0x00]";
        if (lockedReserved) {
            try {
                const parts = lockedReserved.split(',').map(x => parseInt(x.trim()));
                if (parts.length === 3 && !parts.some(isNaN)) {
                    sbReservedArr = parts;
                    stashReservedStr = `[${parts.map(p => `0x${p.toString(16).padStart(2,'0')}`).join(', ')}]`;
                }
            } catch(e){}
        }

        // ==========================================
        // 🍏 6. 建構符合 Stash/Clash 嘅真·WireGuard 完整結構（淨化 Rules + 寫入自訂 Rules）
        // ==========================================
        let stashProxiesSection = "proxies:\n";
        let proxyNames = [];
        
        finalIPList.forEach((item, index) => {
            const nodeName = `🚀 WARP-GitHub優選-[${index+1}]`;
            proxyNames.push(nodeName);
            
            stashProxiesSection += `  - name: "${nodeName}"
    type: wireguard
    server: ${item.ip}
    port: ${item.port}
    ip: 172.16.0.2
    ipv6: fd00::2
    public-key: ${lockedPublicKey}
    private-key: ${lockedPrivateKey}
    reserved: ${stashReservedStr}
    udp: true
    remote-dns-resolve: true
    fast-open: true
    prefer-ipv4: true
    mtu: 1280\n`;
        });

        // 策略組配置
        let stashGroupSection = "proxy-groups:\n  - name: PROXY\n    type: select\n    proxies:\n";
        proxyNames.forEach(name => {
            stashGroupSection += `      - "${name}"\n`;
        });
        stashGroupSection += `      - DIRECT\n`;

        // 🧠 淨化後的 Rules 路由規則（精準寫入自訂 Rules）
        let processedCustomRules = customRulesText
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'))
            .map(line => `  - ${line}`)
            .join('\n');

        let stashRulesSection = `rules:\n`;
        if (processedCustomRules) {
            stashRulesSection += `${processedCustomRules}\n`;
        }
        stashRulesSection += `  - GEOIP,private,DIRECT\n  - MATCH,PROXY`;

        const fullStashYaml = `${stashProxiesSection}\n${stashGroupSection}\n${stashRulesSection}`;

        // ==========================================
        // 🦊 7. 建構符合 Sing-Box 的完整 JSON 結構（同步寫入自訂 Rules）
        // ==========================================
        const sbOutbounds = finalIPList.map((item, index) => {
            return {
                type: "wireguard",
                tag: `🚀 WARP-GitHub優選-[${index+1}]`,
                server: item.ip,
                server_port: item.port,
                local_address: [ "172.16.0.2/32", "fd00::2/128" ],
                private_key: lockedPrivateKey,
                peer_public_key: lockedPublicKey,
                reserved: sbReservedArr,
                mtu: 1280,
                udp_fragment: true
            };
        });

        // 簡易解析自訂 Rules 放入 Sing-box (僅作結構對齊)
        let sbCustomRulesArr = [];
        customRulesText.split('\n').forEach(line => {
            const t = line.trim();
            if (t && !t.startsWith('#')) {
                const p = t.split(',');
                if (p.length >= 3) {
                    if (p[0] === 'DOMAIN-SUFFIX') sbCustomRulesArr.push({ domain_suffix: [p[1]], outbound: p[2].toLowerCase() });
                    if (p[0] === 'DOMAIN') sbCustomRulesArr.push({ domain: [p[1]], outbound: p[2].toLowerCase() });
                }
            }
        });

        const fullSingBoxJson = {
            outbounds: [
                { type: "selector", tag: "PROXY", outbounds: sbOutbounds.map(o => o.tag).concat(["direct"]) },
                ...sbOutbounds,
                { type: "direct", tag: "direct" }
            ],
            route: {
                rules: [
                    ...sbCustomRulesArr,
                    { geoip: [ "private" ], outbound: "direct" }
                ],
                final: "PROXY",
                auto_detect_interface: true
            }
        };
        const fullSingBoxJsonStr = JSON.stringify(fullSingBoxJson, null, 2);

        // 手機 App 攔截直接請求
        if (isStashOrClash) {
            response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
            return response.status(200).send(fullStashYaml);
        }
        if (isSingBox) {
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            return response.status(200).send(fullSingBoxJsonStr);
        }

        // ==========================================
        // 🌐 8. 網頁 GUI 控制台（原本詳細描述 + 新功能完整合一）
        // ==========================================
        const nextRotateCountDown = Math.max(0, Math.round((duration - (now - lastRotateTime)) / 1000));

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Auto-WIS 智能定時優選控制台</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f9; color: #333; padding: 30px; margin: 0; }
                .container { max-width: 800px; margin: 0 auto; }
                .card { background: white; padding: 25px; border-radius: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.04); margin-bottom: 25px; }
                h2 { margin-top: 0; color: #007aff; border-bottom: 2px solid #f2f2f2; padding-bottom: 12px; font-size: 20px; }
                .row { margin-bottom: 18px; }
                label { font-weight: bold; display: block; margin-bottom: 6px; color: #444; }
                input[type="text"], input[type="number"], select, textarea { padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; box-sizing: border-box; }
                input[type="text"], textarea { width: 100%; font-family: monospace; background: #fafafa; }
                textarea { height: 100px; resize: vertical; }
                .ip-input-group { display: flex; align-items: center; gap: 10px; }
                button { background: #007aff; color: white; border: none; padding: 11px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; }
                button.force { background: #34c759; }
                .ip-badge { background: #e1f5fe; color: #0288d1; padding: 3px 8px; border-radius: 6px; font-family: monospace; font-weight: bold; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; font-size: 14px; }
                th { background: #f8f9fa; color: #666; }
                td.mono { font-family: monospace; font-weight: bold; }
                .url-box { background: #f8f9fa; border: 1px dashed #007aff; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 13px; color: #333; word-break: break-all; margin-top: 8px; cursor: pointer; }
                .url-box:hover { background: #f0f7ff; }
                ol.key-list { padding-left: 0; list-style: none; margin: 0; }
                ol.key-list li { padding: 8px 12px; background: #fafafa; border: 1px solid #eee; border-radius: 6px; margin-bottom: 6px; font-family: monospace; font-size: 13px; }
                summary { font-weight: bold; color: #007aff; cursor: pointer; padding: 10px 0; font-size: 16px; outline: none; user-select: none; }
                pre { background: #1e1e1e; color: #4af626; padding: 18px; border-radius: 10px; overflow-x: auto; font-family: 'Courier New', monospace; font-size: 13px; line-height: 1.5; margin-top: 10px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="card">
                    <h2>🌐 網絡連線狀態：<span class="ip-badge">${clientIP} (${clientCountry})</span></h2>
                    <p>已停用每次更新時的動態帳戶註冊，改為<strong>固定 WARP 帳戶 + 遠端動態爬取 GitHub 萬人測速優選 IP</strong> 模式！</p>
                </div>

                <div class="card" style="border: 2px solid #007aff;">
                    <h2 style="color:#007aff;">🔗 手機專用動態訂閱 URL (支援手機全自動更新)</h2>
                    <div style="margin-bottom: 15px;">
                        <label>🍏 Stash / 🎛️ Clash 專用 Sub 網址：</label>
                        <div class="url-box" onclick="navigator.clipboard.writeText('${hostUrl}?type=stash');alert('已複製 Stash 訂閱網址！');">${hostUrl}?type=stash</div>
                    </div>
                    <div>
                        <label>🦊 Sing-Box 專用 JSON 網址：</label>
                        <div class="url-box" onclick="navigator.clipboard.writeText('${hostUrl}?type=singbox');alert('已複製 Sing-Box 訂閱網址！');">${hostUrl}?type=singbox</div>
                    </div>
                </div>

                <div class="card">
                    <h2>⚙️ 終極控制台（固定帳戶 + GitHub 爬取）</h2>
                    <form method="POST">
                        <input type="hidden" name="action" value="save_all">
                        
                        <div class="row" style="background:#f0f7ff; padding:15px; border-radius:10px;">
                            <label style="color:#007aff;">🔑 1. 鎖定你的 3x-ui / 官方 WARP 帳戶金鑰：</label>
                            <div style="margin-bottom:10px;">
                                <span style="font-size:12px; color:#666;">Private Key:</span>
                                <input type="text" name="custom_key" value="${lockedPrivateKey}">
                            </div>
                            <div style="margin-bottom:10px;">
                                <span style="font-size:12px; color:#666;">Public Key:</span>
                                <input type="text" name="public_key" value="${lockedPublicKey}">
                            </div>
                            <div>
                                <span style="font-size:12px; color:#666;">Reserved (例如 0,0,0 或 12,34,56):</span>
                                <input type="text" name="reserved_val" value="${lockedReserved}">
                            </div>
                        </div>

                        <div class="row" style="background:#fffcf0; padding:15px; border-radius:10px; border: 1px dashed #ff9500;">
                            <label style="color:#ff9500;">✍️ 2. 自訂 Rules 路由規則輸入欄 (GEOIP,cn 已除去)：</label>
                            <textarea name="custom_rules" placeholder="DOMAIN-SUFFIX,google.com,PROXY">${customRulesText}</textarea>
                            <span style="font-size:11px; color:#777;">* 請遵守 Stash 標準語法，系統會自動將其置於 Rules 的最頂層優先執行。</span>
                        </div>

                        <div class="row" style="background: #fdfdfd; border: 1px solid #e0e0e0; padding: 15px; border-radius: 10px;">
                            <label style="color:#34c759;">3. ⚡ GitHub 優選 IP 撈取分發數量：</label>
                            <div class="ip-input-group">
                                <span>每次洗牌分發出</span>
                                <input type="number" name="ip_count" value="${selectIPCount}" style="width: 70px; text-align:center;" min="1" max="20">
                                <span>個非官方優選中轉節點</span>
                            </div>
                        </div>

                        <div class="row" style="background: #f9f9f9; padding: 15px; border-radius: 10px;">
                            <label style="color:#555;">4. ⏱️ 遠端優選 IP 定時洗牌週期：</label>
                            每 
                            <input type="number" name="rotate_value" value="${rotateValue}" style="width: 65px; text-align:center;" min="1">
                            <select name="rotate_unit">
                                <option value="s" ${rotateUnit==='s'?'selected':''}>秒 (s)</option>
                                <option value="m" ${rotateUnit==='m'?'selected':''}>分鐘 (m)</option>
                                <option value="h" ${rotateUnit==='h'?'selected':''}>小時 (h)</option>
                                <option value="d" ${rotateUnit==='d'?'selected':''}>天 (d)</option>
                            </select>
                            自動去 GitHub 重新洗牌
                        </div>

                        <button type="submit">💾 儲存所有變更並發佈到雲端</button>
                    </form>

                    <div style="margin-top: 15px; border-top: 1px solid #eee; padding-top: 15px;">
                        <form method="POST" style="display:inline;">
                            <input type="hidden" name="action" value="force_now">
                            <button type="submit" class="force">🔄 ⚡ 依家立刻去 GitHub 爬取新 IP 進行強制洗牌</button>
                        </form>
                    </div>
                    <p style="font-size:12px; color:#777; margin-top:10px; margin-bottom:0;">⌛ 優選洗牌倒數：<strong>${nextRotateCountDown} 秒</strong></p>
                </div>

                <div class="card">
                    <h2>📊 當前隨機分配出的 ${selectIPCount} 條非官方 GitHub 優選中轉 IP</h2>
                    <table>
                        <thead>
                            <tr><th>節點順序</th><th>優選 IP</th><th>連接端口</th></tr>
                        </thead>
                        <tbody>
                            ${finalIPList.map((item, index) => `
                                <tr>
                                    <td># ${index + 1}</td>
                                    <td class="mono" style="color:#0288d1;">${item.ip}</td>
                                    <td class="mono">${item.port}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>

                <div class="card">
                    <h2>📋 定時洗牌更新歷史（最近 10 次事件記錄）</h2>
                    <ol class="key-list">
                        ${recentKeys.map((log, idx) => `
                            <li style="${idx === 0 ? 'background:#e8f5e9; font-weight:bold; color:#1b5e20;' : ''}">
                                ${log} ${idx === 0 ? ' 🌟 (當前生效中)' : ''}
                            </li>
                        `).join('')}
                    </ol>
                </div>

                <div class="card">
                    <details>
                        <summary>🔽 點擊展開 / 收起最終 Stash YAML 輸出配置 (真·WireGuard 協議)</summary>
                        <pre>${fullStashYaml.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                    </details>
                </div>

                <div class="card">
                    <details>
                        <summary>🔽 點擊展開 / 收起最終 Sing-Box JSON 輸出配置</summary>
                        <pre>${fullSingBoxJsonStr.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                    </details>
                </div>

                <div class="card" style="border: 1px dashed #ff9500;">
                    <details>
                        <summary>🔽 點擊展開 / 查看整合了自訂規則的單獨 Rules</summary>
                        <pre>${stashRulesSection}</pre>
                    </details>
                </div>
            </div>
        </body>
        </html>
        `;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.status(200).send(html);

    } catch (error) {
        response.status(500).send(`核心出錯: ${error.message}`);
    }
}
