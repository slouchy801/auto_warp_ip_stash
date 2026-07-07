const crypto = require('crypto');
const https = require('https');

// ==========================================
// 🌟 1. 原生 Redis REST API 引擎
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

const fallbackKey = { 
    privateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", 
    publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=", 
    peerPublicKey: "ccccccccccccccccccccccccccccccccccccccccccc=",
    ipv4: "172.16.0.2/32",
    ipv6: "2606:4700:110:8283::2/128",
    reserved: [0, 0, 0], 
    time: "未註冊打底鎖定",
    isFallback: true 
};

// 🍏 乾淨俐落的精細化 Default Rules（徹底刪除 cloudflare / vercel 的 DIRECT 規則）
const defaultRulesText = `# [Default Rules] 精細化網絡分流機制
- GEOSITE,CN,DIRECT
- GEOIP,CN,DIRECT
- GEOIP,PRIVATE,DIRECT`;

let memoryBackup = {
    safeKey: fallbackKey,
    currentActiveId: "safe",
    latestRegisteredObj: null,
    keyHistoryPool: [],
    useForceRotate: true, 
    rotateUnit: "d",
    rotateValue: 1,
    lastRotateTime: Date.now(),
    customRulesText: defaultRulesText
};

async function loadConfig() {
    try {
        const data = await redisCommand('GET', ['auto_wis_config_v3']);
        if (data) {
            let cfg = JSON.parse(data);
            if (!cfg.safeKey || !cfg.safeKey.privateKey) cfg.safeKey = fallbackKey;
            if (!cfg.keyHistoryPool) cfg.keyHistoryPool = [];
            if (!cfg.customRulesText) cfg.customRulesText = defaultRulesText;
            return cfg;
        }
    } catch(e){}
    return memoryBackup;
}

async function saveConfig(config) {
    memoryBackup = config;
    try {
        await redisCommand('SET', ['auto_wis_config_v3', JSON.stringify(config)]);
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
                'CF-Client-Version': 'a-6.11-2152', 
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
// 🔑 2. 與 wgcf 100% 同源的 Curve25519 JWK 密鑰註冊機制
// ==========================================
async function registerWarpAccount() {
    try {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519', {});
        const jwkPriv = privateKey.export({ format: 'jwk' });
        
        const privBase64 = Buffer.from(jwkPriv.d, 'base64url').toString('base64');
        const pubBase64 = Buffer.from(jwkPriv.x, 'base64url').toString('base64');

        // 遞交真實的 Public Key 進行建交
        const regData = await cfPost('https://api.cloudflareclient.com/v0a/reg', {
            "key": pubBase64, "install_id": "", "fcm_token": ""
        });

        if (!regData || !regData.config) return null;

        const peerPubKey = regData.config.peers[0].public_key; 
        const cid = regData.config.client_id || "";
        
        let ipv4Address = "172.16.0.2/32";
        let ipv6Address = "2606:4700:110:8283::2/128";
        if (regData.config.interface && regData.config.interface.addresses) {
            const v4 = regData.config.interface.addresses.v4;
            const v6 = regData.config.interface.addresses.v6;
            if (v4) ipv4Address = v4.includes('/') ? v4 : `${v4}/32`;
            if (v6) ipv6Address = v6.includes('/') ? v6 : `${v6}/128`;
        }

        let resArr = [0, 0, 0];
        if (cid) {
            try {
                let buf = cid.length === 6 ? Buffer.from(cid, 'hex') : Buffer.from(cid, 'base64');
                if (buf.length >= 3) resArr = [buf[0], buf[1], buf[2]];
            } catch(e){}
        }

        return { 
            privateKey: privBase64,   
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
// 🍏 3. 動態地理分流矩陣 YAML 構建器
// ==========================================
function buildStashYaml(finalKeyObj, customRulesText, targetRegion = "all") {
    if (finalKeyObj.isFallback) {
        return `# [Auto-WIS] ⚠️ 請先訪問控制台網頁並點擊「一鍵註冊」生成有效的 Cloudflare 金鑰對。`;
    }

    let resArr = [0, 0, 0];
    if (Array.isArray(finalKeyObj.reserved)) resArr = finalKeyObj.reserved;

    // 🍏 大數據 Anycast 傾向性高容錯端點矩陣池
    const geoPool = {
        hk: [
            { ip: "engage.cloudflareclient.com", port: 2408 },
            { ip: "engage.cloudflareclient.com", port: 500 },
            { ip: "162.159.192.1", port: 2408 },
            { ip: "162.159.192.5", port: 500 }
        ],
        jp: [
            { ip: "162.159.193.1", port: 2408 },
            { ip: "162.159.193.5", port: 500 },
            { ip: "141.101.91.12", port: 2408 },
            { ip: "141.101.91.15", port: 500 }
        ],
        us: [
            { ip: "188.114.96.1", port: 2408 },
            { ip: "188.114.97.2", port: 500 },
            { ip: "188.114.98.3", port: 2408 },
            { ip: "188.114.99.4", port: 500 }
        ]
    };

    let y = "proxies:\n";
    let groupMapping = { hk: [], jp: [], us: [] };

    // 生成底層 WireGuard 代理節點
    Object.keys(geoPool).forEach(reg => {
        geoPool[reg].forEach((node, idx) => {
            const proxyName = `Warp-${reg.toUpperCase()}-${idx + 1}`;
            groupMapping[reg].push(proxyName);

            y += `  - name: ${proxyName}\n`;
            y += `    type: wireguard\n`;
            y += `    server: ${node.ip}\n`;
            y += `    port: ${node.port}\n`;
            y += `    ip: ${finalKeyObj.ipv4}\n`;          
            y += `    ipv6: ${finalKeyObj.ipv6}\n`;        
            y += `    private-key: ${finalKeyObj.privateKey}\n`; 
            y += `    public-key: ${finalKeyObj.peerPublicKey}\n`; 
            y += `    dns:\n      - 1.1.1.1\n      - 1.0.0.1\n`;
            y += `    reserved: [${resArr.join(', ')}]\n`; 
            y += `    udp: true\n`;
            y += `    mtu: 1280\n\n`;
        });
    });

    y += "proxy-groups:\n";

    // 🍏 依據 url-test 規範生成各區域獨立的 url-test 組
    Object.keys(groupMapping).forEach(reg => {
        y += `  - name: 📦 ${reg.toUpperCase()}-WARP池\n`;
        y += `    type: url-test\n`;
        y += `    url: https://cp.cloudflare.com/generate_204\n`;
        y += `    interval: 600\n`;
        y += `    tolerance: 20\n`;
        y += `    lazy: true\n`;
        y += `    expected-status: 204\n`;
        y += `    proxies:\n`;
        groupMapping[reg].forEach(p => { y += `      - ${p}\n`; });
        y += "\n";
    });

    // 🍏 核心控制：FINAL 節點選擇組（根據 ?region= 參數動態重組）
    y += "  - name: FINAL\n";
    y += "    type: select\n";
    y += "    proxies:\n";

    if (targetRegion === "hk") {
        y += "      - 📦 HK-WARP池\n";
    } else if (targetRegion === "jp") {
        y += "      - 📦 JP-WARP池\n";
    } else if (targetRegion === "us") {
        y += "      - 📦 US-WARP池\n";
    } else {
        // all 模式：將三者全部列出，預設走最快的池
        y += "      - 📦 HK-WARP池\n";
        y += "      - 📦 JP-WARP池\n";
        y += "      - 📦 US-WARP池\n";
    }
    y += "      - DIRECT\n\n";

    // 規則鏈
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
    y += "  - MATCH,FINAL";
    return y;
}

// ==========================================
// 🚀 4. 主路由與控制台邏輯面
// ==========================================
export default async function handler(request, response) {
    const userAgent = (request.headers['user-agent'] || '').toLowerCase();
    const urlStr = request.url || '';
    const urlObj = new URL(urlStr, `https://${request.headers.host || 'localhost'}`);
    
    // 🍏 精確抓取用戶指定的地區篩選參數
    const regionParam = (urlObj.searchParams.get('region') || 'all').toLowerCase();
    const typeParam = urlObj.searchParams.get('type');
    
    const clientCountry = request.headers['x-vercel-ip-country'] || 'HK';
    const baseUrl = `https://${request.headers.host}${urlStr.split('?')[0]}`;
    const isStash = userAgent.includes('stash') || userAgent.includes('clash') || typeParam === 'stash';

    let config = await loadConfig();

    let finalKeyObj = config.safeKey;
    if (config.currentActiveId === "latest" && config.latestRegisteredObj) {
        finalKeyObj = config.latestRegisteredObj;
    } else if (config.currentActiveId.startsWith("history_") && config.keyHistoryPool) {
        const idx = parseInt(config.currentActiveId.split("_")[1]);
        if (config.keyHistoryPool[idx]) finalKeyObj = config.keyHistoryPool[idx];
    }

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

                config.customRulesText = params.get('custom_rules') || defaultRulesText;
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

    const fullStashYaml = buildStashYaml(finalKeyObj, config.customRulesText, regionParam);

    if (isStash) {
        response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        return response.status(200).send(fullStashYaml);
    }

    const nextRotateCountDown = Math.max(0, Math.round((duration - (now - config.lastRotateTime)) / 1000));
    const currentTimeString = new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' });

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Auto-WIS 地理分流控制台</title>
        <style>
            body { font-family: -apple-system, system-ui, sans-serif; background: #f4f6f9; color: #333; padding: 25px; margin: 0; }
            .container { max-width: 800px; margin: 0 auto; }
            .card { background: white; padding: 25px; border-radius: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.04); margin-bottom: 20px; }
            .time-banner { background: #1e1e24; color: #fff; padding: 12px 20px; border-radius: 10px; font-weight: bold; margin-bottom: 20px; display: flex; justify-content: space-between; }
            h2 { margin-top: 0; color: #007aff; border-bottom: 2px solid #f2f2f2; padding-bottom: 10px; }
            .row { margin-bottom: 15px; }
            label { font-weight: bold; display: block; margin-bottom: 5px; }
            input[type="number"], select, textarea { padding: 10px; border: 1px solid #ddd; border-radius: 8px; width: 100%; box-sizing: border-box; }
            textarea { height: 110px; font-family: monospace; }
            button { background: #007aff; color: white; border: none; padding: 12px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; }
            .ip-badge { background: #e1f5fe; color: #0288d1; padding: 3px 8px; border-radius: 6px; font-family: monospace; font-weight: bold; }
            .url-link { background: #f8f9fa; padding: 10px; border-radius: 8px; font-family: monospace; font-size: 12px; margin-top: 5px; border: 1px dashed #ccc; cursor: pointer; color: #007aff; }
            .active-box { background: #e8f5e9; border-left: 5px solid #34c759; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 13px; margin-top: 10px; color:#1b5e20; }
            pre { background: #1e1e1e; color: #4af626; padding: 15px; border-radius: 10px; overflow-x: auto; font-family: monospace; font-size: 13px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="time-banner">
                <span>⚡ Auto-WIS 滿血分區分流版 (v2.3.0)</span>
                <span>實時時間: ${currentTimeString}</span>
            </div>

            <div class="card">
                <h2>🌐 當前分區狀態</h2>
                <p>📍 請求來源地區：<span class="ip-badge">${clientCountry}</span></p>
                <p>🎯 當前控制台預覽模式：<span class="ip-badge" style="background:#fff3e0; color:#e65100;">${regionParam.toUpperCase()} 組</span></p>
            </div>

            <div class="card" style="background: linear-gradient(135deg, #007aff, #0056b3); color: white;">
                <h2>⚡ 免手動金鑰生成器 (一鍵註冊)</h2>
                <form method="POST">
                    <input type="hidden" name="action" value="click_register_new">
                    <button type="submit" style="background:#ff9500; width:100%; padding:15px; font-size:16px;">⚡ 獲取全新合規安全 Warp 密鑰</button>
                </form>
            </div>

            <div class="card">
                <h2>⚙️ 路由與密鑰管理面版</h2>
                <form method="POST">
                    <input type="hidden" name="action" value="save_settings">
                    
                    <div class="row">
                        <label>🎯 選擇套用金鑰：</label>
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

                    <div class="active-box">
                        <strong>🟢 Stash 目前即時載入的金鑰詳情：</strong><br>
                        • WireGuard PrivateKey: ${finalKeyObj.privateKey}<br>
                        • Server PublicKey: ${finalKeyObj.peerPublicKey}
                    </div>

                    <div class="row" style="margin-top:15px;">
                        <label>✍️ 配置分流 Rules 路由規則：</label>
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
                    </div>

                    <button type="submit">💾 儲存並同步至雲端 Redis</button>
                </form>
            </div>

            <div class="card" style="border: 2px solid #007aff;">
                <h2>🔗 手機 Stash 專用「分區訂閱網址」</h2>
                <p style="font-size: 13px; color:#555;">複製下方對應網址填入 Stash，Warp 節點就會嚴格鎖定在該地區：</p>
                
                <label>🌐 全球動態優選組 (All Region):</label>
                <div class="url-link" onclick="navigator.clipboard.writeText('${baseUrl}?type=stash&region=all');alert('已複製 All 網址！');">${baseUrl}?type=stash&region=all</div>
                
                <label style="margin-top:10px;">🇯🇵 嚴格鎖定日本組 (Japan Only):</label>
                <div class="url-link" onclick="navigator.clipboard.writeText('${baseUrl}?type=stash&region=jp');alert('已複製 JP 網址！');">${baseUrl}?type=stash&region=jp</div>
                
                <label style="margin-top:10px;">🇭🇰 嚴格鎖定香港組 (Hong Kong Only):</label>
                <div class="url-link" onclick="navigator.clipboard.writeText('${baseUrl}?type=stash&region=hk');alert('已複製 HK 網址！');">${baseUrl}?type=stash&region=hk</div>
            </div>

            <div class="card">
                <h2>📄 當前 YAML 預覽 (?region=${regionParam})</h2>
                <pre>${fullStashYaml.replace(/</g, '&lt;')}</pre>
            </div>
        </div>
    </body>
    </html>
    `;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.status(200).send(html);
}
