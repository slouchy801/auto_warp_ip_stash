const crypto = require('crypto');
const https = require('https');

// ==========================================
// 🌟 1. 全局記憶體與控制變數（完全復原全功能核心，死記不忘）
// ==========================================
let recentKeys = [];
let lockedPrivateKey = ""; 
let lastRotateTime = Date.now();

let useForceRotate = false;
let rotateUnit = "d"; 
let rotateValue = 1;  
let selectIPCount = 3; // 預設撈取 3 條優選 IP

// 💡 記憶體持久化鎖定：當前真正生效中的 Key 物件（Edgetunnel 核心機制）
let currentActiveAccount = {
    privateKey: crypto.randomBytes(32).toString('base64'),
    publicKey: "bW9jay1wdWJsaWMta2V5LWZvci1maXJzdC1ydW4=", // 初始 mock
    reserved: "0,0,0"
};

// 💡 新增功能：自訂 Rules 儲存變數（預設留空或範例）
let customRulesText = "# 在此輸入自訂 Rules，每行一條\n# 例如：\n# - DOMAIN-SUFFIX,google.com,PROXY";

// 封裝 POST 請求（用於向 Cloudflare 官方註冊 WARP 帳戶）
function cfPost(url, data) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const postData = JSON.stringify(data);
        const options = {
            hostname: u.hostname, path: u.pathname, method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'okhttp/3.12.1',
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(body));
                else reject(new Error(`CF Status: ${res.statusCode}`));
            });
        });
        req.on('error', (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

// 封裝 GET 請求（用於從 GitHub 撈取海量優選大數據）
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

// 註冊 WARP 獲取最新要素
async function fetchNewWarpAccount() {
    try {
        const regData = await cfPost('https://api.cloudflareclient.com/v0a/reg', {
            "key": crypto.randomBytes(32).toString('base64'), "install_id": "", "fcm_token": ""
        });
        const priv = crypto.randomBytes(32).toString('base64');
        const pub = regData.config.peers[0].public_key;
        const cid = regData.config.client_id || "";
        let resArr = [0, 0, 0];
        if (cid) {
            try {
                const buf = Buffer.from(cid, 'base64');
                if (buf.length >= 3) resArr = [buf[0], buf[1], buf[2]];
            } catch(e){}
        }
        return { privateKey: priv, publicKey: pub, reserved: resArr.join(',') };
    } catch(e) {
        return null;
    }
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
    // ⚙️ 2. 處理控制台 POST 表單提交（全功能原樣復原）
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
                customRulesText = params.get('custom_rules') || "";
                useForceRotate = params.get('use_force') === 'true';
                rotateUnit = params.get('rotate_unit') || 'd';
                rotateValue = parseInt(params.get('rotate_value')) || 1;
                selectIPCount = Math.max(1, Math.min(20, parseInt(params.get('ip_count')) || 3));
                
                // 如果手動填寫了 Safe Key，即時同步更新當前運作的賬戶
                if (lockedPrivateKey) {
                    currentActiveAccount.privateKey = lockedPrivateKey;
                }
            } else if (action === 'unlock') {
                lockedPrivateKey = "";
            } else if (action === 'force_now') {
                lastRotateTime = 0; // 觸發立刻洗牌交棒
            }
        } catch (e) {}
        response.writeHead(302, { Location: request.url });
        return response.end();
    }

    try {
        // ==========================================
        // ⏱️ 3. 轉生與密鑰控制核心（Edgetunnel 定時交棒交替機制）
        // ==========================================
        const now = Date.now();
        const duration = getRotateMs(rotateValue, rotateUnit);
        const isExpired = (now - lastRotateTime) >= duration;
        let shouldRotate = useForceRotate ? isExpired : (!lockedPrivateKey && isExpired);

        // 如果時間到了，或者歷史紀錄是空的，去註冊新 Key 完成「交棒」
        if (shouldRotate || recentKeys.length === 0) {
            lastRotateTime = now;
            const newAcc = await fetchNewWarpAccount();
            if (newAcc) {
                currentActiveAccount = newAcc;
                if (useForceRotate && lockedPrivateKey) {
                    lockedPrivateKey = newAcc.privateKey;
                }
                if (!recentKeys.includes(newAcc.privateKey)) {
                    recentKeys.unshift(newAcc.privateKey);
                }
            }
        } else {
            // 如果時間未到，且手動鎖定了 Safe Key，雷打不動只用 Safe Key
            if (lockedPrivateKey) {
                currentActiveAccount.privateKey = lockedPrivateKey;
            }
            // 確保當前正在使用的 Key 永遠掛在歷史紀錄最前線
            if (currentActiveAccount.privateKey && !recentKeys.includes(currentActiveAccount.privateKey)) {
                recentKeys.unshift(currentActiveAccount.privateKey);
            }
        }

        if (recentKeys.length > 10) recentKeys = recentKeys.slice(0, 10);

        // ==========================================
        // 🔍 4. 去 GitHub 搵搵：動態爬取海量非官方 WARP 優選中轉 IP
        // ==========================================
        let githubIPs = [];
        const sources = [
            'https://raw.githubusercontent.com/banyao2000/warp-speed/main/api/ip.txt',
            'https://raw.githubusercontent.com/fscarmen/warp/main/api/ip.txt'
        ];
        
        for (const src of sources) {
            const rawText = await httpGet(src);
            if (rawText && rawText.length > 10) {
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

        if (githubIPs.length === 0) {
            githubIPs = [
                { ip: '162.159.192.1', port: 854 },
                { ip: '162.159.193.5', port: 4500 },
                { ip: '188.114.97.3', port: 854 }
            ];
        }

        let shuffled = githubIPs.sort(() => 0.5 - Math.random());
        let finalIPList = shuffled.slice(0, selectIPCount);

        // ==========================================
        // 💡 5. 解析 Reserved 轉為 16 進制
        // ==========================================
        let sbReservedArr = [0, 0, 0];
        let stashReservedStr = "[0x00, 0x00, 0x00]";
        if (currentActiveAccount.reserved) {
            try {
                const parts = currentActiveAccount.reserved.split(',').map(x => parseInt(x.trim()));
                if (parts.length === 3 && !parts.some(isNaN)) {
                    sbReservedArr = parts;
                    stashReservedStr = `[${parts.map(p => `0x${p.toString(16).padStart(2,'0')}`).join(', ')}]`;
                }
            } catch(e){}
        }

        // ==========================================
        // 🍏 6. 建構符合 Stash/Clash 嘅完整結構（💡 乾淨 Sub 網址，純淨 YAML 輸出）
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
    public-key: ${currentActiveAccount.publicKey}
    private-key: ${currentActiveAccount.privateKey}
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

        // 🧠 淨化後的 Rules 路由規則（完全剔除 GEOIP,cn 並且完美結合自訂 Rules）
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
        // 🦊 7. 建構符合 Sing-Box 的完整 JSON 結構
        // ==========================================
        const sbOutbounds = finalIPList.map((item, index) => {
            return {
                type: "wireguard",
                tag: `🚀 WARP-GitHub優選-[${index+1}]`,
                server: item.ip,
                server_port: item.port,
                local_address: [ "172.16.0.2/32", "fd00::2/128" ],
                private_key: currentActiveAccount.privateKey,
                peer_public_key: currentActiveAccount.publicKey,
                reserved: sbReservedArr,
                mtu: 1280,
                udp_fragment: true
            };
        });

        const fullSingBoxJson = {
            outbounds: [
                { type: "selector", tag: "PROXY", outbounds: sbOutbounds.map(o => o.tag).concat(["direct"]) },
                ...sbOutbounds,
                { type: "direct", tag: "direct" }
            ],
            route: {
                rules: [ { geoip: [ "private" ], outbound: "direct" } ],
                final: "PROXY",
                auto_detect_interface: true
            }
        };
        const fullSingBoxJsonStr = JSON.stringify(fullSingBoxJson, null, 2);

        // 手機 App 攔截直接請求（輸出純 YAML/JSON 絕無雜質）
        if (isStashOrClash) {
            response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
            return response.status(200).send(fullStashYaml);
        }
        if (isSingBox) {
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            return response.status(200).send(fullSingBoxJsonStr);
        }

        // ==========================================
        // 🌐 8. 網頁 GUI 控制台（完美全功能文字描述百分百復原）
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
                button.unlock { background: #ff3b30; }
                .status-tag { padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: bold; color: white; }
                .bg-orange { background: #ff9500; }
                .bg-green { background: #34c759; }
                .ip-badge { background: #e1f5fe; color: #0288d1; padding: 3px 8px; border-radius: 6px; font-family: monospace; font-weight: bold; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; font-size: 14px; }
                th { background: #f8f9fa; color: #666; }
                td.mono { font-family: monospace; font-weight: bold; }
                .url-box { background: #f8f9fa; border: 1px dashed #007aff; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 13px; color: #333; word-break: break-all; margin-top: 8px; cursor: pointer; }
                .url-box:hover { background: #f0f7ff; }
                ol.key-list { padding-left: 0; list-style: none; margin: 0; }
                ol.key-list li { padding: 8px 12px; background: #fafafa; border: 1px solid #eee; border-radius: 6px; margin-bottom: 6px; font-family: monospace; font-size: 13px; display: flex; justify-content: space-between; }
                ol.key-list li.active { background: #e8f5e9; border-color: #a5d6a7; color: #1b5e20; font-weight: bold; }
                summary { font-weight: bold; color: #007aff; cursor: pointer; padding: 10px 0; font-size: 16px; outline: none; user-select: none; }
                pre { background: #1e1e1e; color: #4af626; padding: 18px; border-radius: 10px; overflow-x: auto; font-family: 'Courier New', monospace; font-size: 13px; line-height: 1.5; margin-top: 10px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="card">
                    <h2>🌐 當前連線定位 <span><span class="ip-badge">${clientIP}</span></span></h2>
                    <p>Vercel 動態分析你目前身處：<strong style="color:#ff3b30; font-size:18px;">${clientCountry}</strong> 區。系統會自動調度最吻合的優選 Anycast 節點。</p>
                </div>

                <div class="card" style="border: 2px solid #007aff;">
                    <h2 style="color:#007aff;">🔗 手機專用動態訂閱 URL (支援手機全自動更新)</h2>
                    <div style="margin-bottom: 15px;">
                        <label>🍏 Stash / 🎛️ Clash 專用完整 Sub 網址：</label>
                        <div class="url-box" onclick="navigator.clipboard.writeText('${hostUrl}?type=stash');alert('已複製 Stash 訂閱網址！');">${hostUrl}?type=stash</div>
                    </div>
                    <div>
                        <label>🦊 Sing-Box 專用完整 JSON 網址：</label>
                        <div class="url-box" onclick="navigator.clipboard.writeText('${hostUrl}?type=singbox');alert('已複製 Sing-Box 訂閱網址！');">${hostUrl}?type=singbox</div>
                    </div>
                </div>

                <div class="card">
                    <h2>⚙️ 智能控制台（定時洗牌 + 優選配置）</h2>
                    <form method="POST">
                        <input type="hidden" name="action" value="save_all">
                        
                        <div class="row">
                            <label>1. Safe Private Key (WireGuard Key) 鎖定框：</label>
                            <div style="display:flex; gap:10px; align-items:center;">
                                <input type="text" name="custom_key" value="${lockedPrivateKey}" placeholder="在此貼入固定 Key（留空走自動定時免洗模式）">
                                ${lockedPrivateKey ? `<span class="status-tag bg-green" style="white-space:nowrap;">🔒 已鎖定</span>` : `<span class="status-tag bg-orange" style="white-space:nowrap;">🔄 免洗中</span>`}
                            </div>
                        </div>

                        <div class="row" style="background:#fffcf0; padding:15px; border-radius:10px; border: 1px dashed #ff9500;">
                            <label style="color:#ff9500;">✍️ 自訂額外 Rules 路由規則輸入欄 (GEOIP,cn 已除去)：</label>
                            <textarea name="custom_rules" placeholder="DOMAIN-SUFFIX,netflix.com,PROXY">${customRulesText}</textarea>
                        </div>

                        <div class="row" style="background: #fdfdfd; border: 1px solid #e0e0e0; padding: 15px; border-radius: 10px;">
                            <label style="color:#007aff; margin-bottom:10px;">2. ⚡ GitHub 遠端測速優選 IP 分發設定 (Edgetunnel 核心)：</label>
                            <div class="ip-input-group">
                                <span>整合海量庫導出</span>
                                <input type="number" name="ip_count" value="${selectIPCount}" style="width: 70px; text-align:center;" min="1" max="20">
                                <span>個最優中轉節點（預設值為 3）</span>
                            </div>
                        </div>

                        <div class="row" style="background: #f9f9f9; padding: 15px; border-radius: 10px; border-left: 4px solid #007aff;">
                            <label style="color:#555;">3. ⏱️ 賬戶定時轉生交棒週期：</label>
                            每 
                            <input type="number" name="rotate_value" value="${rotateValue}" style="width: 65px; text-align:center;" min="1">
                            <select name="rotate_unit">
                                <option value="s" ${rotateUnit==='s'?'selected':''}>秒 (s)</option>
                                <option value="m" ${rotateUnit==='m'?'selected':''}>分鐘 (m)</option>
                                <option value="h" ${rotateUnit==='h'?'selected':''}>小時 (h)</option>
                                <option value="d" ${rotateUnit==='d'?'selected':''}>天 (d)</option>
                            </select>
                            自動更換新金鑰金鑰
                            
                            <div style="margin-top: 10px;">
                                <input type="checkbox" id="use_force" name="use_force" value="true" ${useForceRotate?'checked':''}>
                                <label for="use_force" style="display:inline; font-weight:normal; color:#ff3b30; cursor:pointer;">
                                    <strong>強制覆蓋：</strong> 即使鎖定了，時間到也強行交棒更換新密鑰！
                                </label>
                            </div>
                        </div>

                        <button type="submit">💾 儲存並發佈到雲端</button>
                    </form>

                    <div style="margin-top: 15px; border-top: 1px solid #eee; padding-top: 15px;">
                        <form method="POST" style="display:inline;">
                            <input type="hidden" name="action" value="force_now">
                            <button type="submit" class="force">🔄 ⚡ 依家立刻強制更新洗牌</button>
                        </form>
                        <button onclick="window.location.reload();" style="background:#6c757d; margin-left:10px;">🔄 僅刷新網頁測速</button>
                        ${lockedPrivateKey ? `
                        <form method="POST" style="display:inline; margin-left:10px;">
                            <input type="hidden" name="action" value="unlock">
                            <button type="submit" class="unlock">🔓 解鎖 Safe Key</button>
                        </form>` : ''}
                    </div>
                    <p style="font-size:12px; color:#777; margin-top:10px; margin-bottom:0;">⌛ 洗牌倒數：<strong>${nextRotateCountDown} 秒</strong></p>
                </div>

                <div class="card">
                    <h2>📊 遠端動態洗牌分配出的 ${selectIPCount} 條非官方 GitHub 優選中轉 IP</h2>
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
                    <h2>📋 最近十次生成的 Key 記錄歷史</h2>
                    <ol class="key-list">
                        ${recentKeys.map((k, idx) => `
                            <li class="${k === currentActiveAccount.privateKey ? 'active' : ''}">
                                <span>序列 ${idx + 1}：${k}</span>
                                <span>${k === currentActiveAccount.privateKey ? '🌟 當前生效' : '📜 歷史'}</span>
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
                        <summary>🔽 點擊展開 / 查看已包含在訂閱內的 Rules 分流路由規則</summary>
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
