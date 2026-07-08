// v2.1.0
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

// 動態讀取本檔案第一行版本號
let currentVersion = "v2.1.0";
try {
    const firstLine = fs.readFileSync(__filename, 'utf8').split('\n')[0];
    const match = firstLine.match(/\/\/\s*([^\s]+)/);
    if (match) currentVersion = match[1];
} catch(e) {}

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

const defaultRulesText = `# [Default Rules] 精細化網絡分流
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
    customRulesText: defaultRulesText,
    currentIPList: [{ ip: 'engage.cloudflareclient.com', port: 2408 }] 
};

async function loadConfig() {
    try {
        const data = await redisCommand('GET', ['auto_wis_config']);
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
// 🔑 2. 與 wgcf 100% 同源的 Curve25519 JWK 密鑰註冊
// ==========================================
async function registerWarpAccount() {
    try {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519', {});
        const jwkPriv = privateKey.export({ format: 'jwk' });
        
        const privBase64 = Buffer.from(jwkPriv.d, 'base64url').toString('base64');
        const pubBase64 = Buffer.from(jwkPriv.x, 'base64url').toString('base64');

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
// 🍏 3. 完美實現：8 節點矩陣 + 雙層策略組 YAML 構建器
// ==========================================
function buildStashYaml(finalKeyObj, customRulesText) {
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
    
    const endpoints = [
        { ip: "engage.cloudflareclient.com", label: "DNS" },
        { ip: "162.159.192.1", label: "IP1" },
        { ip: "162.159.193.1", label: "IP2" },
        { ip: "188.114.96.1",   label: "IP3" }
    ];
    const ports = [2408, 500];
    let warpProxyNames = [];

    endpoints.forEach(ep => {
        ports.forEach(port => {
            const name = `Warp-${ep.label}-${port}`;
            warpProxyNames.push(name);

            y += `  - name: ${name}\n`;
            y += `    type: wireguard\n`;
            y += `    server: ${ep.ip}\n`;
            y += `    port: ${port}\n`;
            y += `    ip: ${finalKeyObj.ipv4}\n`;          
            y += `    ipv6: ${finalKeyObj.ipv6}\n`;        
            y += `    private-key: ${finalKeyObj.privateKey}\n`; 
            y += `    public-key: ${finalKeyObj.peerPublicKey}\n`; 
            y += `    dns:\n`; 
            y += `      - 1.1.1.1\n`;
            y += `      - 1.0.0.1\n`;
            y += `    reserved: [${resArr.join(', ')}]\n`; 
            y += `    udp: true\n`;
            y += `    mtu: 1280\n\n`;
        });
    });

    y += "proxy-groups:\n";
    y += "  - name: WARP\n";
    y += "    type: url-test\n"; 
    y += "    url: https://cp.cloudflare.com/generate_204\n"; 
    y += "    interval: 600\n";        
    y += "    tolerance: 20\n";       
    y += "    lazy: true\n";          
    y += "    expected-status: 204\n"; 
    y += "    proxies:\n";
    warpProxyNames.forEach(name => { y += `      - ${name}\n`; });
    y += "\n";

    y += "  - name: FINAL\n";
    y += "    type: select\n";
    y += "    proxies:\n";
    y += "      - WARP\n";
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
    const typeParam = urlObj.searchParams.get('type');
    
    const hostUrl = `https://${request.headers.host}${urlStr.split('?')[0]}`;
    const isStash = userAgent.includes('stash') || userAgent.includes('clash') || typeParam === 'stash';

    const clientIp = request.headers['x-forwarded-for'] || request.socket.remoteAddress || '127.0.0.1';
    const clientCountry = request.headers['x-vercel-ip-country'] || 'UNKNOWN';
    const clientRegion = request.headers['x-vercel-ip-country-region'] || '';
    const clientCity = request.headers['x-vercel-ip-city'] || '';
    const geoInfo = `${clientCity}${clientCity && clientRegion ? ', ' : ''}${clientRegion} (${clientCountry})`;

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
                
                config.customRulesText = params.get('custom_rules') || defaultRulesText;
                config.useForceRotate = params.get('use_force') === 'true';
                config.rotateUnit = params.get('rotate_unit') || 'd';
                config.rotateValue = parseInt(params.get('rotate_value')) || 1;
            } 
            else if (action === 'make_safe_permanent_action') {
                const selectedId = params.get('active_key_id') || "safe";
                config.currentActiveId = selectedId;
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
            else if (action === 'click_register_new') {
                const newAcc = await registerWarpAccount();
                if (newAcc) {
                    if (config.latestRegisteredObj) config.keyHistoryPool.unshift(config.latestRegisteredObj);
                    config.latestRegisteredObj = newAcc;
                    config.currentActiveId = "latest";
                    if (config.keyHistoryPool.length > 10) config.keyHistoryPool = config.keyHistoryPool.slice(0, 10);
                }
            }
            else if (action === 'auto_rotate_trigger') {
                config.lastRotateTime = Date.now();
                const autoAcc = await registerWarpAccount();
                if (autoAcc) {
                    if (config.latestRegisteredObj) config.keyHistoryPool.unshift(config.latestRegisteredObj);
                    config.latestRegisteredObj = autoAcc;
                    if (config.useForceRotate) config.currentActiveId = "latest";
                    if (config.keyHistoryPool.length > 10) config.keyHistoryPool = config.keyHistoryPool.slice(0, 10);
                }
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

    const fullStashYaml = buildStashYaml(finalKeyObj, config.customRulesText);

    if (isStash) {
        response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        return response.status(200).send(fullStashYaml);
    }

    const nextRotateCountDown = Math.max(0, Math.round((duration - (now - config.lastRotateTime)) / 1000));

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>[Auto-WIS] (${currentVersion})</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d0e12; color: #e2e8f0; padding: 25px; margin: 0; }
            .container { max-width: 800px; margin: 0 auto; }
            .card { background: #151821; padding: 25px; border-radius: 14px; box-shadow: 0 8px 24px rgba(0,0,0,0.2); margin-bottom: 20px; border: 1px solid #222633; }
            .time-banner { background: #1a1d29; border: 1px solid #2d334a; color: #38bdf8; padding: 14px 20px; border-radius: 10px; font-weight: bold; margin-bottom: 20px; display: flex; justify-content: space-between; font-family: monospace; box-shadow: 0 0 15px rgba(56,189,248,0.1); align-items: center; }
            .time-banner .left-title { font-size: 15px; color: #38bdf8; letter-spacing: 0.5px; }
            .time-banner .right-time { color: #94a3b8; font-weight: normal; }
            h2 { margin-top: 0; color: #38bdf8; border-bottom: 1px solid #222633; padding-bottom: 12px; font-size: 20px; font-weight: 600; display: flex; align-items: center; justify-content: space-between; }
            .row { margin-bottom: 18px; }
            .action-row { display: flex; gap: 12px; align-items: flex-end; margin-bottom: 18px; width: 100%; }
            .action-row .select-container { flex: 1; }
            label { font-weight: 600; display: block; margin-bottom: 8px; color: #94a3b8; font-size: 14px; }
            input[type="number"], select, textarea { padding: 12px; background: #0d0e12; border: 1px solid #2d334a; border-radius: 8px; width: 100%; box-sizing: border-box; color: #e2e8f0; transition: border-color 0.2s; }
            input[type="number"]:focus, select:focus, textarea:focus { border-color: #38bdf8; outline: none; }
            textarea { height: 140px; font-family: "Fira Code", monospace; font-size: 13px; }
            button { background: #38bdf8; color: #0d0e12; border: none; padding: 12px 22px; border-radius: 8px; cursor: pointer; font-weight: bold; transition: all 0.2s; box-shadow: 0 4px 12px rgba(56,189,248,0.2); height: 43px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; white-space: nowrap; }
            button:hover { opacity: 0.9; transform: translateY(-1px); }
            .btn-orange { background: #fb923c; box-shadow: 0 4px 12px rgba(251,146,60,0.2); }
            .btn-green { background: #10b981; box-shadow: 0 4px 12px rgba(16,185,129,0.2); color: #0d0e12; }
            .ip-badge { background: #1e293b; color: #38bdf8; padding: 4px 10px; border-radius: 6px; font-family: monospace; font-weight: bold; border: 1px solid #2d334a; }
            .active-box { background: rgba(16,185,129,0.05); border-left: 4px solid #10b981; padding: 14px; border-radius: 6px; font-family: monospace; font-size: 13px; margin-top: 12px; color: #34d399; border-top: 1px solid rgba(16,185,129,0.1); border-right: 1px solid rgba(16,185,129,0.1); border-bottom: 1px solid rgba(16,185,129,0.1); line-height: 1.6; }
            .warn-box { background: rgba(239,68,68,0.05); border-left: 4px solid #ef4444; padding: 14px; border-radius: 6px; color: #f87171; margin-top: 12px; font-size: 14px; border-top: 1px solid rgba(239,68,68,0.1); border-right: 1px solid rgba(239,68,68,0.1); border-bottom: 1px solid rgba(239,68,68,0.1); }
            pre { background: #0d0e12; color: #34d399; padding: 18px; border-radius: 10px; overflow-x: auto; font-family: "Fira Code", monospace; font-size: 13px; border: 1px solid #222633; margin: 0; margin-top: 15px; }
            .yaml-header { cursor: pointer; user-select: none; }
            .yaml-header:hover { color: #60a5fa; }
            .arrow-icon { transition: transform 0.3s; display: inline-block; font-size: 16px; color: #64748b; }
            #yaml-toggle:checked ~ pre { display: block; }
            #yaml-toggle:checked ~ .yaml-header .arrow-icon { transform: rotate(180deg); color: #38bdf8; }
            #yaml-toggle { display: none; }
            .yaml-container pre { display: none; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="time-banner">
                <span class="left-title">[Auto-WIS] (${currentVersion})</span>
                <span class="right-time" id="live-clock">--/--/---- --:--:--</span>
            </div>

            <div class="card">
                <h2>🌐 物理防禦端點狀態</h2>
                <p>📡 當前 Browser IP：<span class="ip-badge">${clientIp}</span></p>
                <p>📍 地理位置資訊：<span class="ip-badge" style="background:#1a2333; color:#60a5fa; border-color:#2b3b54;">${geoInfo}</span></p>
            </div>

            <div class="card" style="background: linear-gradient(135deg, #1e293b, #111827); border-color: #38bdf8;">
                <h2 style="color: #38bdf8;">⚡ 免手動金鑰生成器 (一鍵註冊)</h2>
                <form method="POST">
                    <input type="hidden" name="action" value="click_register_new">
                    <button type="submit" class="btn-orange" style="width:100%; padding:15px; font-size:16px; height:auto;">⚡ 獲取全新合規安全 Warp 密鑰</button>
                </form>
            </div>

            <div class="card">
                <h2>⚙️ 密鑰池與完整路由控制面版</h2>
                
                <form id="main-config-form" method="POST">
                    <input type="hidden" name="action" value="save_settings">
                    
                    <div class="action-row">
                        <div class="select-container">
                            <label>🎯 選擇套用金鑰（支持永久鎖定與歷史緩衝池）：</label>
                            <select id="active_key_select" name="active_key_id" style="font-family: monospace; font-size: 13px;" onchange="autoSaveConfig()">
                                <option value="safe" ${config.currentActiveId==='safe'?'selected':''}>🌟 [Safe Key] ${config.safeKey.isFallback ? '⚠️未設定打底賬戶' : `永久打底 [IP:${config.safeKey.ipv4}] [Res:${config.safeKey.reserved.join(',')}]`} (${config.safeKey.time})</option>
                                ${config.latestRegisteredObj ? `<option value="latest" ${config.currentActiveId==='latest'?'selected':''}>🆕 [最新一鍵獲取] - IP: ${config.latestRegisteredObj.ipv4} | Res: [${config.latestRegisteredObj.reserved.join(',')}] | (${config.latestRegisteredObj.time})</option>` : ''}
                                ${config.keyHistoryPool.map((k, idx) => `
                                    <option value="history_${idx}" ${config.currentActiveId===`history_${idx}`?'selected':''}>📜 [歷史備份池 ${idx+1}] - IP: ${k.ipv4} | Res: [${k.reserved.join(',')}] | (${k.time})</option>
                                `).join('')}
                            </select>
                        </div>
                        <button type="button" class="btn-green" onclick="lockAsSafeKey()">💾 覆蓋為永久 Safe Key</button>
                    </div>

                    ${finalKeyObj.isFallback ? `
                        <div class="warn-box">
                            <strong>⚠️ 提示：</strong> 目前載入的是初始安全密鑰，Stash 訂閱已被暫時鎖定保護。請立刻點擊上方橘色按鈕進行【一鍵註冊】激活。
                        </div>
                    ` : `
                        <div class="active-box">
                            <strong>🟢 Stash 目前即時載入的金鑰詳情：</strong><br>
                            • WireGuard PrivateKey: ${finalKeyObj.privateKey}<br>
                            • Server PublicKey: ${finalKeyObj.peerPublicKey}<br>
                            • Allocated IPv4: ${finalKeyObj.ipv4}<br>
                            • Allocated IPv6: ${finalKeyObj.ipv6}<br>
                            • Reserved: [${finalKeyObj.reserved.join(', ')}]
                        </div>
                    `}

                    <div class="row" style="margin-top:20px;">
                        <label>✍️ 配置分流 Rules 路由規則：</label>
                        <textarea name="custom_rules" onchange="autoSaveConfig()">${config.customRulesText}</textarea>
                    </div>

                    <div class="row" style="background: #1a1d29; padding: 15px; border-radius: 8px; border: 1px solid #2d334a;">
                        <label style="margin-bottom:10px;">⏱️ 定時交棒刷新週期：</label>
                        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                            <span>每</span> 
                            <input type="number" name="rotate_value" value="${config.rotateValue}" style="width:70px; display:inline-block; padding:8px;" onchange="autoSaveConfig()">
                            <select name="rotate_unit" style="width:100px; display:inline-block; padding:8px;" onchange="autoSaveConfig()">
                                <option value="m" ${config.rotateUnit==='m'?'selected':''}>分鐘</option>
                                <option value="h" ${config.rotateUnit==='h'?'selected':''}>小時</option>
                                <option value="d" ${config.rotateUnit==='d'?'selected':''}>天</option>
                            </select>
                            <input type="checkbox" id="use_force" name="use_force" value="true" ${config.useForceRotate?'checked':''} style="width:auto; cursor:pointer; margin-left:10px;" onchange="autoSaveConfig()">
                            <label for="use_force" style="display:inline; font-weight:normal; color:#e2e8f0; cursor:pointer; margin:0;">時間到強制交棒</label>
                        </div>
                    </div>
                </form>

                <form id="lock-safe-form" method="POST" style="display:none;">
                    <input type="hidden" name="action" value="make_safe_permanent_action">
                    <input type="hidden" id="lock_safe_key_id" name="active_key_id" value="">
                </form>

                <form id="auto-rotate-form" method="POST" style="display:none;">
                    <input type="hidden" name="action" value="auto_rotate_trigger">
                </form>

                <p style="font-size:13px; color:#64748b; margin-top:12px; font-family:monospace;">⏳ 距離下一次自動交棒剩餘：<span style="color:#fb923c; font-weight:bold;" id="countdown-timer">--</span> 秒</p>
            </div>

            <div class="card" style="border: 1px dashed #38bdf8; background: rgba(56,189,248,0.02);">
                <h2>🔗 手機 Stash 雙層分流專用訂閱網址</h2>
                <div style="background:#0d0e12; padding:14px; border-radius:8px; font-family:monospace; font-size:13px; cursor:pointer; border:1px solid #222633; color:#38bdf8;" onclick="navigator.clipboard.writeText('${hostUrl}?type=stash');alert('已複製訂閱網址！');">👉 點擊複製：${hostUrl}?type=stash</div>
            </div>

            <div class="card yaml-container">
                <input type="checkbox" id="yaml-toggle">
                <label for="yaml-toggle" class="yaml-header">
                    <h2>📄 當前純淨 YAML 預覽（8節點矩陣架構） <span class="arrow-icon">▼</span></h2>
                </label>
                <pre>${fullStashYaml.replace(/</g, '&lt;')}</pre>
            </div>
        </div>

        <script>
            // 1. 右上角動態時鐘
            function updateClock() {
                const d = new Date();
                const pad = (n) => String(n).padStart(2, '0');
                const timeStr = '[' + pad(d.getDate()) + '/' + pad(d.getMonth()+1) + '/' + d.getFullYear() + '][' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ']';
                document.getElementById('live-clock').innerText = timeStr;
            }
            setInterval(updateClock, 1000);
            updateClock();

            // 2. 倒數秒數動態計時
            let timeLeft = parseInt("${nextRotateCountDown}") || 0;
            const countdownEl = document.getElementById('countdown-timer');
            
            function updateCountdown() {
                if (timeLeft <= 0) {
                    countdownEl.innerText = "0";
                    // 倒數歸零時，全自動提交表單觸發刷新
                    document.getElementById('auto-rotate-form').submit();
                } else {
                    countdownEl.innerText = timeLeft;
                    timeLeft--;
                }
            }
            setInterval(updateCountdown, 1000);
            updateCountdown();

            // 3. 獨立按鈕動作：點擊將選中 Key 覆蓋為永久 Safe Key
            function lockAsSafeKey() {
                const currentSelected = document.getElementById('active_key_select').value;
                if (currentSelected === 'safe') {
                    alert('當前選中的已經是永久打底密鑰，無需覆蓋。');
                    return;
                }
                document.getElementById('lock_safe_key_id').value = currentSelected;
                document.getElementById('lock-safe-form').submit();
            }

            // 4. 自動儲存機制：當規則或定時設定改變時，直接向後端提交儲存
            function autoSaveConfig() {
                document.getElementById('main-config-form').submit();
            }
        </script>
    </body>
    </html>
    `;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.status(200).send(html);
}
