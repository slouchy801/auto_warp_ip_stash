const crypto = require('crypto');
const https = require('https');

// ==========================================
// 🌟 1. 原生 Redis REST API 引擎（修正雙重編碼 Bug）
// ==========================================
function redisCommand(cmd, args = []) {
    return new Promise((resolve) => {
        const rawUrl = process.env.KV_REST_API_URL || process.env.REDIS_URL || "";
        const token = process.env.KV_REST_API_TOKEN || "";
        if (!rawUrl) return resolve(null);
        try {
            let cleanUrl = rawUrl.replace('redis://', 'https://').replace('rediss://', 'https://');
            if (cleanUrl.includes('@')) {
                const hostPart = cleanUrl.split('@')[1];
                cleanUrl = `https://${hostPart}`;
            }
            const urlObj = new URL(`${cleanUrl}/${cmd}/${args.join('/')}`);
            const options = { method: 'GET', headers: { 'Authorization': `Bearer ${token}` }, timeout: 3000 };
            const req = https.request(urlObj, options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try { 
                        const result = JSON.parse(body).result;
                        if (result && typeof result === 'string' && result.startsWith('%7B')) {
                            resolve(decodeURIComponent(result));
                        }
                        resolve(result); 
                    } catch(e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.end();
        } catch(e) { resolve(null); }
    });
}

// 🍏 修正：Fallback Key 必須是合法的 44 字符 Base64，防止 Stash 解析報錯 (Unmarshal Error)
const fallbackKey = { 
    privateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", 
    publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=", 
    peerPublicKey: "ccccccccccccccccccccccccccccccccccccccccccc=",
    ipv4: "172.16.0.2/32",
    ipv6: "2606:4700:110:8283::2/128",
    reserved: [0, 0, 0], 
    time: "未註冊打底鎖定",
    isFallback: true // 標記為未激活狀態
};

let memoryBackup = {
    safeKey: fallbackKey,
    currentActiveId: "safe",
    latestRegisteredObj: null,
    keyHistoryPool: [],
    useForceRotate: true, 
    rotateUnit: "d",
    rotateValue: 1,
    selectIPCount: 3,
    lastRotateTime: Date.now(),
    customRulesText: "# 在此輸入自訂 Rules，每行一條\n- DOMAIN-SUFFIX,netflix.com,PROXY",
    currentIPList: [
        { ip: 'engage.cloudflareclient.com', port: 2408 }
    ] 
};

async function loadConfig() {
    try {
        const data = await redisCommand('GET', ['auto_wis_config']);
        if (data) {
            let cfg = JSON.parse(data);
            if (!cfg.safeKey || !cfg.safeKey.privateKey) cfg.safeKey = fallbackKey;
            if (!cfg.keyHistoryPool) cfg.keyHistoryPool = [];
            if (!cfg.currentIPList || cfg.currentIPList.length === 0) cfg.currentIPList = memoryBackup.currentIPList;
            return cfg;
        }
    } catch(e){}
    return memoryBackup;
}

async function saveConfig(config) {
    memoryBackup = config;
    try {
        await redisCommand('SET', ['auto_wis_config', JSON.stringify(config)]);
    } catch(e){}
}

function cfPost(url, data) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const postData = JSON.stringify(data);
        const options = {
            hostname: u.hostname, path: u.pathname, method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'User-Agent': 'okhttp/3.12.1', 
                'CF-Client-Version': 'a-6.11-2152', // 🍏 補上客戶端版本頭，確保 API 穩定
                'Content-Length': Buffer.byteLength(postData) 
            }
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
            });
        });
        req.on('error', e => reject(e));
        req.write(postData);
        req.end();
    });
}

// ==========================================
// 🔑 2. 真正生成 X25519 (Curve25519) 金鑰對與註冊邏輯
// ==========================================
async function registerWarpAccount() {
    try {
        // 🍏 生成真實合法的 Curve25519 金鑰對
        const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519', {
            publicKeyEncoding: { type: 'spki', format: 'der' },
            privateKeyEncoding: { type: 'pkcs8', format: 'der' }
        });
        
        // 提取原始 32 骨幹 Bytes 並轉為標準 WireGuard Base64 格式
        const privBase64 = privateKey.slice(-32).toString('base64');
        const pubBase64 = publicKey.slice(-32).toString('base64');

        // 將生成的 Public Key 發送給 Cloudflare 註冊
        const regData = await cfPost('https://api.cloudflareclient.com/v0a/reg', {
            "key": pubBase64, "install_id": "", "fcm_token": ""
        });

        if (!regData || !regData.config) return null;

        // 🍏 完美抽取對齊所有專屬參數
        const peerPubKey = regData.config.peers[0].public_key; 
        const cid = regData.config.client_id || "";
        
        // 提取分配的動態專屬內網 IP 位址
        let ipv4Address = "172.16.0.2/32";
        let ipv6Address = "2606:4700:110:8283::2/128";
        if (regData.config.interface && regData.config.interface.addresses) {
            const v4 = regData.config.interface.addresses.v4;
            const v6 = regData.config.interface.addresses.v6;
            if (v4) ipv4Address = v4.includes('/') ? v4 : `${v4}/32`;
            if (v6) ipv6Address = v6.includes('/') ? v6 : `${v6}/128`;
        }

        // 處理 Reserved / Client ID
        let resArr = [0, 0, 0];
        if (cid) {
            try {
                let buf = cid.length === 6 ? Buffer.from(cid, 'hex') : Buffer.from(cid, 'base64');
                if (buf.length >= 3) resArr = [buf[0], buf[1], buf[2]];
            } catch(e){}
        }

        return { 
            privateKey: privBase64,   
            publicKey: pubBase64,     
            peerPublicKey: peerPubKey, 
            ipv4: ipv4Address,
            ipv6: ipv6Address,
            reserved: resArr, 
            time: new Date().toLocaleTimeString('zh-HK'),
            isFallback: false
        };
    } catch (e) { return null; }
}

function getRotateMs(value, unit) {
    const val = parseInt(value) || 1;
    if (unit === 'm') return val * 60 * 1000;
    if (unit === 'h') return val * 60 * 60 * 1000;
    return val * 24 * 60 * 60 * 1000;
}

// ==========================================
// 🍏 3. 完美適配 Stash 的 WireGuard YAML 構建器（官方域名端口跳躍優化版）
// ==========================================
function buildStashYaml(finalIPList, finalKeyObj, customRulesText) {
    if (finalKeyObj.isFallback) {
        return `# [Auto-WIS] 系統檢測到您尚未成功生成有效的 Cloudflare 金鑰對。\n# 請先訪問控制台網頁並點擊「一鍵註冊」生成。`;
    }

    let resArr = [0, 0, 0];
    if (Array.isArray(finalKeyObj.reserved)) {
        resArr = finalKeyObj.reserved;
    } else if (typeof finalKeyObj.reserved === 'string') {
        resArr = finalKeyObj.reserved.split(',').map(num => parseInt(num.trim()) || 0);
    }

    let y = "proxies:\n";
    let proxyNames = [];

    // 🍏 使用官方最穩定的通用 Anycast 域名，配合 Cloudflare 官方允許的 4 大 WireGuard 端口進行 Port-Hopping
    const officialEndpoints = [
        { name: "⚡ Warp-官方預設 (2408)", port: 2408 },
        { name: "🛡️ Warp-相容模式 (500)",  port: 500  },
        { name: "🍂 Warp-繞過分流 (1701)", port: 1701 },
        { name: "🚀 Warp-穿透模式 (4500)", port: 4500 }
    ];

    officialEndpoints.forEach((endpoint) => {
        proxyNames.push(endpoint.name);

        y += `  - name: ${endpoint.name}\n`;
        y += `    type: wireguard\n`;
        y += `    server: engage.cloudflareclient.com\n`; // 👈 統一使用官方 Anycast 域名，避免死網與 Anycast 路由超時問題
        y += `    port: ${endpoint.port}\n`;
        y += `    ip: ${finalKeyObj.ipv4}\n`;          
        y += `    ipv6: ${finalKeyObj.ipv6}\n`;        
        y += `    private-key: ${finalKeyObj.privateKey}\n`; 
        y += `    public-key: ${finalKeyObj.peerPublicKey}\n`; // 真正對齊的 Peer 公鑰
        y += `    dns: [1.1.1.1, 8.8.8.8]\n`;          // 補上必要 DNS 機制
        y += `    reserved: [${resArr.join(', ')}]\n`; 
        y += `    udp: true\n`;
        y += `    mtu: 1280\n\n`; // 剔除高風險、具版本不相容隱患的 remote-dns-resolve
    });

    // 🍏 自動健康檢查策略組：讓 Stash 在這 4 個端口中秒選通的那一個（如 7ms 的 2408）
    y += "proxy-groups:\n";
    y += "  - name: PROXY\n";
    y += "    type: url-test\n"; 
    y += "    url: http://cp.cloudflare.com/generate_204\n"; // 使用 Cloudflare 自己的 204 機制優化握手
    y += "    interval: 180\n";  
    y += "    tolerance: 30\n";  
    y += "    proxies:\n";
    proxyNames.forEach(name => { y += `      - ${name}\n`; });
    y += "      - DIRECT\n\n";

    y += "rules:\n";
    if (customRulesText) {
        customRulesText.split('\n').forEach(line => {
            let l = line.trim();
            if (l && !l.startsWith('#')) {
                if (!l.startsWith('-')) l = `- ${l}`;
                y += `  ${l}\n`;
            }
        });
    }
    y += "  - GEOIP,private,DIRECT\n  - MATCH,PROXY";
    return y;
}

// ==========================================
// 🚀 4. 主路由與控制台邏輯面
// ==========================================
export default async function handler(request, response) {
    const userAgent = (request.headers['user-agent'] || '').toLowerCase();
    const urlStr = request.url || '';
    const urlObj = new URL(urlStr, `https://${request.headers.host || 'localhost'}`);
    const typeParam = urlObj.searchParams.get('type');
    
    const clientCountry = request.headers['x-vercel-ip-country'] || 'HK';
    const hostUrl = `https://${request.headers.host}${urlStr.split('?')[0]}`;
    const isStash = userAgent.includes('stash') || userAgent.includes('clash') || typeParam === 'stash';

    let config = await loadConfig();

    let finalKeyObj = config.safeKey;
    if (config.currentActiveId === "latest" && config.latestRegisteredObj) {
        finalKeyObj = config.latestRegisteredObj;
    } else if (config.currentActiveId.startsWith("history_") && config.keyHistoryPool) {
        const idx = parseInt(config.currentActiveId.split("_")[1]);
        if (config.keyHistoryPool[idx]) finalKeyObj = config.keyHistoryPool[idx];
    }

    // 表單 POST 控制處理
    if (request.method === 'POST') {
        let body = '';
        await new Promise(resolve => {
            request.on('data', chunk => body += chunk);
            request.on('end', resolve);
        });
        try {
            const params = new URLSearchParams(body);
            const action = params.get('action');

            if (action === 'save_settings') {
                const selectedId = params.get('active_key_id') || "safe";
                config.currentActiveId = selectedId;
                
                if (params.get('make_safe_permanent') === 'true') {
                    if (selectedId === "latest" && config.latestRegisteredObj) {
                        config.safeKey = JSON.parse(JSON.stringify(config.latestRegisteredObj));
                        config.safeKey.time = "鎖定覆蓋 (" + new Date().toLocaleTimeString('zh-HK') + ")";
                        config.currentActiveId = "safe";
                    } else if (selectedId.startsWith("history_")) {
                        const idx = parseInt(selectedId.split("_")[1]);
                        if (config.keyHistoryPool && config.keyHistoryPool[idx]) {
                            config.safeKey = JSON.parse(JSON.stringify(config.keyHistoryPool[idx]));
                            config.safeKey.time = "鎖定覆蓋 (" + new Date().toLocaleTimeString('zh-HK') + ")";
                            config.currentActiveId = "safe";
                        }
                    }
                }

                config.customRulesText = params.get('custom_rules') || "";
                config.useForceRotate = params.get('use_force') === 'true';
                config.rotateUnit = params.get('rotate_unit') || 'd';
                config.rotateValue = parseInt(params.get('rotate_value')) || 1;
            } 
            else if (action === 'click_register_new') {
                const newAcc = await registerWarpAccount();
                if (newAcc) {
                    if (config.latestRegisteredObj) config.keyHistoryPool.unshift(config.latestRegisteredObj);
                    config.latestRegisteredObj = newAcc;
                    config.currentActiveId = "latest";
                    if (config.keyHistoryPool.length > 10) config.keyHistoryPool = config.keyHistoryPool.slice(0, 10);
                }
            }
            else if (action === 'force_rotate_now') {
                config.lastRotateTime = Date.now();
            }
            await saveConfig(config);
        } catch (e) {}
        response.writeHead(302, { Location: request.url });
        return response.end();
    }

    // 自動刷新定時器
    const now = Date.now();
    const duration = getRotateMs(config.rotateValue, config.rotateUnit);
    if ((now - config.lastRotateTime) >= duration) {
        config.lastRotateTime = now;
        const autoAcc = await registerWarpAccount();
        if (autoAcc) {
            if (config.latestRegisteredObj) config.keyHistoryPool.unshift(config.latestRegisteredObj);
            config.latestRegisteredObj = autoAcc;
            if (config.useForceRotate) config.currentActiveId = "latest";
            if (config.keyHistoryPool.length > 10) config.keyHistoryPool = config.keyHistoryPool.slice(0, 10);
            await saveConfig(config);
        }
        if (config.currentActiveId === "latest") finalKeyObj = config.latestRegisteredObj;
    }

    const fullStashYaml = buildStashYaml(config.currentIPList, finalKeyObj, config.customRulesText);

    // 發送相容性完美的 YAML 給手機 Stash / Clash 核心
    if (isStash) {
        response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        return response.status(200).send(fullStashYaml);
    }

    // GUI 控制台網頁渲染
    const nextRotateCountDown = Math.max(0, Math.round((duration - (now - config.lastRotateTime)) / 1000));
    const currentTimeString = new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' });

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Auto-WIS 滿血恢復控制台</title>
        <style>
            body { font-family: -apple-system, system-ui, sans-serif; background: #f4f6f9; color: #333; padding: 25px; margin: 0; }
            .container { max-width: 800px; margin: 0 auto; }
            .card { background: white; padding: 25px; border-radius: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.04); margin-bottom: 20px; }
            .time-banner { background: #1e1e24; color: #fff; padding: 12px 20px; border-radius: 10px; font-weight: bold; margin-bottom: 20px; display: flex; justify-content: space-between; }
            h2 { margin-top: 0; color: #007aff; border-bottom: 2px solid #f2f2f2; padding-bottom: 10px; }
            .row { margin-bottom: 15px; }
            label { font-weight: bold; display: block; margin-bottom: 5px; }
            input[type="number"], select, textarea { padding: 10px; border: 1px solid #ddd; border-radius: 8px; width: 100%; box-sizing: border-box; }
            textarea { height: 80px; font-family: monospace; }
            button { background: #007aff; color: white; border: none; padding: 12px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; }
            .ip-badge { background: #e1f5fe; color: #0288d1; padding: 3px 8px; border-radius: 6px; font-family: monospace; font-weight: bold; }
            .active-box { background: #e8f5e9; border-left: 5px solid #34c759; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 13px; margin-top: 10px; color:#1b5e20; }
            .warn-box { background: #ffebee; border-left: 5px solid #ff3b30; padding: 12px; border-radius: 6px; color: #c62828; margin-top: 10px; font-size: 14px; }
            pre { background: #1e1e1e; color: #4af626; padding: 15px; border-radius: 10px; overflow-x: auto; font-family: monospace; font-size: 13px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="time-banner">
                <span>⚡ Auto-WIS 滿血完全體 (v1.9.0)</span>
                <span>實時時間: ${currentTimeString}</span>
            </div>

            <div class="card">
                <h2>🌐 物理防禦端點狀態</h2>
                <p>📍 請求來源地區：<span class="ip-badge">${clientCountry}</span></p>
                <p>📡 輸出端點：<span class="ip-badge" style="background:#fff3e0; color:#e65100;">engage.cloudflareclient.com</span></p>
            </div>

            <div class="card" style="background: linear-gradient(135deg, #007aff, #0056b3); color: white;">
                <h2>⚡ 免手動金鑰生成器 (一鍵註冊)</h2>
                <form method="POST">
                    <input type="hidden" name="action" value="click_register_new">
                    <button type="submit" style="background:#ff9500; width:100%; padding:15px; font-size:16px;">⚡ 獲取全新 Cloudflare 帳戶密鑰</button>
                </form>
            </div>

            <div class="card">
                <h2>⚙️ 密鑰池與完整路由控制面版</h2>
                <form method="POST">
                    <input type="hidden" name="action" value="save_settings">
                    
                    <div class="row">
                        <label>🎯 選擇套用金鑰（支持永久鎖定與歷史緩衝池）：</label>
                        <select name="active_key_id">
                            <option value="safe" ${config.currentActiveId==='safe'?'selected':''}>🌟 [Safe Key] ${finalKeyObj.isFallback ? '⚠️未設定打底賬戶' : '永久打底賬戶'} (${config.safeKey.time})</option>
                            ${config.latestRegisteredObj ? `<option value="latest" ${config.currentActiveId==='latest'?'selected':''}>🆕 [最新一鍵獲取] - ${config.latestRegisteredObj.time}</option>` : ''}
                            ${config.keyHistoryPool.map((k, idx) => `
                                <option value="history_${idx}" ${config.currentActiveId===`history_${idx}`?'selected':''}>📜 [歷史備份池 ${idx+1}] - ${k.time}</option>
                            `).join('')}
                        </select>
                    </div>

                    <div class="row">
                        <input type="checkbox" id="make_safe" name="make_safe_permanent" value="true">
                        <label for="make_safe" style="display:inline; color:#007aff; cursor:pointer;">💾 將選中金鑰覆蓋並鎖定為「永久 Safe Key」</label>
                    </div>

                    ${finalKeyObj.isFallback ? `
                        <div class="warn-box">
                            <strong>⚠️ 提示：</strong> 目前載入的是初始安全密鑰，Stash 訂閱已被暫時鎖定保護。請立刻點擊上方黃色按鈕進行【一鍵註冊】激活。
                        </div>
                    ` : `
                        <div class="active-box">
                            <strong>🟢 Stash 目前即時載入的金鑰詳情：</strong><br>
                            • Client PrivateKey: ${finalKeyObj.privateKey}<br>
                            • Server PublicKey: ${finalKeyObj.peerPublicKey}<br>
                            • Allocated IPv4: ${finalKeyObj.ipv4}<br>
                            • Allocated IPv6: ${finalKeyObj.ipv6}<br>
                            • Reserved: [${finalKeyObj.reserved.join(', ')}]
                        </div>
                    `}

                    <div class="row" style="margin-top:15px;">
                        <label>✍️ 自訂額外 Rules 路由規則：</label>
                        <textarea name="custom_rules">${config.customRulesText}</textarea>
                    </div>

                    <div class="row">
                        <label>⏱️ 定時交棒刷新週期：</label>
                        每 <input type="number" name="rotate_value" value="${config.rotateValue}" style="width:60px; display:inline-block;">
                        <select name="rotate_unit" style="width:100px; display:inline-block;">
                            <option value="m" ${config.rotateUnit==='m'?'selected':''}>分鐘</option>
                            <option value="h" ${config.rotateUnit==='h'?'selected':''}>小時</option>
                            <option value="d" ${config.rotateUnit==='d'?'selected':''}>天</option>
                        </select>
                        <input type="checkbox" id="use_force" name="use_force" value="true" ${config.useForceRotate?'checked':''}>
                        <label for="use_force" style="display:inline; font-weight:normal;">時間到強制交棒</label>
                    </div>

                    <button type="submit">💾 儲存並同步至雲端 Redis</button>
                </form>

                <form method="POST" style="margin-top:10px;">
                    <input type="hidden" name="action" value="force_rotate_now">
                    <button type="submit" style="background:#34c759;">🔄 立即手動刷新定時器</button>
                </form>
                <p style="font-size:12px; color:#666;">⏳ 距離下一次自動交棒剩餘：${nextRotateCountDown} 秒</p>
            </div>

            <div class="card" style="border: 2px solid #007aff;">
                <h2>🔗 手機 Stash 穩定訂閱網址</h2>
                <div style="background:#f8f9fa; padding:12px; border-radius:8px; font-family:monospace; font-size:13px; cursor:pointer;" onclick="navigator.clipboard.writeText('${hostUrl}?type=stash');alert('已複製！');">👉 點擊複製：${hostUrl}?type=stash</div>
            </div>

            <div class="card">
                <h2>📄 當前純淨 YAML 預覽</h2>
                <pre>${fullStashYaml.replace(/</g, '&lt;')}</pre>
            </div>
        </div>
    </body>
    </html>
    `;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.status(200).send(html);
}
