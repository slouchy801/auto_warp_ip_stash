const crypto = require('crypto');
const https = require('https');

// ==========================================
// 🌟 1. 原生 Redis REST API 引擎（功能完全恢復）
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
            const options = { method: 'GET', headers: { 'Authorization': `Bearer ${token}` }, timeout: 2000 };
            const req = https.request(urlObj, options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(body).result); } catch(e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.end();
        } catch(e) { resolve(null); }
    });
}

const fallbackKey = { privateKey: "請點擊一鍵註冊獲取有效金鑰", publicKey: "CF...", reserved: [0, 0, 0], time: "系統打底安全鎖定" };

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
        { ip: 'engage.cloudflareclient.com', port: 2408 },
        { ip: '104.19.0.231', port: 51820 },
        { ip: '162.159.192.1', port: 51820 }
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
        await redisCommand('SET', ['auto_wis_config', encodeURIComponent(JSON.stringify(config))]);
    } catch(e){}
}

// 🎯 對標 EdgeTunnel 與 warp2clash 最底層穩定端點池，絕不盲猜死網
function getUltimateAnycastList(count) {
    const pool = [
        { ip: 'engage.cloudflareclient.com', port: 2408 },
        { ip: '104.19.0.231', port: 51820 },
        { ip: '162.159.192.1', port: 51820 },
        { ip: '162.159.193.1', port: 2408 },
        { ip: '162.159.195.1', port: 4500 }
    ];
    return pool.slice(0, count);
}

function cfPost(url, data) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const postData = JSON.stringify(data);
        const options = {
            hostname: u.hostname, path: u.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'okhttp/3.12.1', 'Content-Length': Buffer.byteLength(postData) }
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', e => reject(e));
        req.write(postData);
        req.end();
    });
}

async function registerWarpAccount() {
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
        return { privateKey: priv, publicKey: pub, reserved: resArr, time: new Date().toLocaleTimeString() };
    } catch (e) { return null; }
}

function getRotateMs(value, unit) {
    const val = parseInt(value) || 1;
    if (unit === 'm') return val * 60 * 1000;
    if (unit === 'h') return val * 60 * 60 * 1000;
    return val * 24 * 60 * 60 * 1000;
}

// 🍏 第一性原理嚴格對齊：剔除致命參數，保證握手成功
function buildStashYaml(finalIPList, finalKeyObj, customRulesText) {
    let resArr = [0, 0, 0];
    if (Array.isArray(finalKeyObj.reserved)) {
        resArr = finalKeyObj.reserved;
    } else if (typeof finalKeyObj.reserved === 'string') {
        resArr = finalKeyObj.reserved.split(',').map(num => parseInt(num.trim()) || 0);
    }

    let y = "proxies:\n";
    let proxyNames = [];

    finalIPList.forEach((item, index) => {
        const nodeName = `Warp-節點-${String(index + 1).padStart(2, '0')}`;
        proxyNames.push(nodeName);

        y += `  - name: ${nodeName}\n`;
        y += `    type: wireguard\n`;
        y += `    server: ${item.ip}\n`;
        y += `    port: ${item.port}\n`;
        y += `    ip: 172.16.0.2/32\n`; 
        y += `    ipv6: 2606:4700:110:8283:195e:d7a5:b12b:7e98/128\n`; 
        y += `    private-key: ${finalKeyObj.privateKey}\n`; 
        y += `    public-key: ${finalKeyObj.publicKey}\n`;   
        y += `    reserved: [${resArr.join(', ')}]\n`; 
        y += `    udp: true\n`;
        y += `    mtu: 1280\n`; // 🍏 防止網絡分片丟包
        y += `    remote-dns-resolve: false\n\n`; 
    });

    y += "proxy-groups:\n";
    y += "  - name: PROXY\n";
    y += "    type: select\n";
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
// 🚀 2. 主路由與完整控制台邏輯（全部滿血回歸）
// ==========================================
export default async function handler(request, response) {
    const userAgent = (request.headers['user-agent'] || '').toLowerCase();
    const { method, query } = request;
    const clientCountry = request.headers['x-vercel-ip-country'] || 'HK';
    const hostUrl = `https://${request.headers.host}${request.url.split('?')[0]}`;
    const isStash = userAgent.includes('stash') || userAgent.includes('clash') || query.type === 'stash';

    let config = await loadConfig();

    // 處理手動切換與歷史池讀取
    let finalKeyObj = config.safeKey;
    if (config.currentActiveId === "latest" && config.latestRegisteredObj) {
        finalKeyObj = config.latestRegisteredObj;
    } else if (config.currentActiveId.startsWith("history_") && config.keyHistoryPool) {
        const idx = parseInt(config.currentActiveId.split("_")[1]);
        if (config.keyHistoryPool[idx]) finalKeyObj = config.keyHistoryPool[idx];
    }

    // ==========================================
    // ⚙️ 3. POST 表單處理（恢復永久鎖定、手動交棒、設定變更）
    // ==========================================
    if (method === 'POST') {
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
                
                // 永久覆蓋打底密鑰邏輯
                if (params.get('make_safe_permanent') === 'true') {
                    if (selectedId === "latest" && config.latestRegisteredObj) {
                        config.safeKey = JSON.parse(JSON.stringify(config.latestRegisteredObj));
                        config.safeKey.time = "鎖定覆蓋 (" + new Date().toLocaleTimeString() + ")";
                        config.currentActiveId = "safe";
                    } else if (selectedId.startsWith("history_")) {
                        const idx = parseInt(selectedId.split("_")[1]);
                        if (config.keyHistoryPool && config.keyHistoryPool[idx]) {
                            config.safeKey = JSON.parse(JSON.stringify(config.keyHistoryPool[idx]));
                            config.safeKey.time = "鎖定覆蓋 (" + new Date().toLocaleTimeString() + ")";
                            config.currentActiveId = "safe";
                        }
                    }
                }

                config.customRulesText = params.get('custom_rules') || "";
                config.useForceRotate = params.get('use_force') === 'true';
                config.rotateUnit = params.get('rotate_unit') || 'd';
                config.rotateValue = parseInt(params.get('rotate_value')) || 1;
                config.selectIPCount = Math.max(1, Math.min(5, parseInt(params.get('ip_count')) || 3));
                config.currentIPList = getUltimateAnycastList(config.selectIPCount);
            } 
            else if (action === 'click_register_new') {
                // 一鍵免洗獲取全新密鑰
                const newAcc = await registerWarpAccount();
                if (newAcc) {
                    if (config.latestRegisteredObj) config.keyHistoryPool.unshift(config.latestRegisteredObj);
                    config.latestRegisteredObj = newAcc;
                    config.currentActiveId = "latest";
                    if (config.keyHistoryPool.length > 10) config.keyHistoryPool = config.keyHistoryPool.slice(0, 10);
                }
            }
            else if (action === 'force_rotate_now') {
                config.currentIPList = getUltimateAnycastList(config.selectIPCount);
                config.lastRotateTime = Date.now();
            }
            await saveConfig(config);
        } catch (e) {}
        response.writeHead(302, { Location: request.url });
        return response.end();
    }

    // ==========================================
    // ⏱️ 4. 自動定時刷新金鑰池生命週期
    // ==========================================
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

    if (isStash) {
        response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        return response.status(200).send(fullStashYaml);
    }

    // ==========================================
    // 🌐 5. 滿血回歸的 100% 完整網頁 GUI 控制台
    // ==========================================
    const nextRotateCountDown = Math.max(0, Math.round((duration - (now - config.lastRotateTime)) / 1000));
    const currentTimeString = new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' });

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
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
            pre { background: #1e1e1e; color: #4af626; padding: 15px; border-radius: 10px; overflow-x: auto; font-family: monospace; font-size: 13px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="time-banner">
                <span>⚡ Auto-WIS 滿血完全體 (v1.7.0)</span>
                <span>實時時間: ${currentTimeString}</span>
            </div>

            <div class="card">
                <h2>🌐 物理防禦端點狀態</h2>
                <p>📍 請求來源地區：<span class="ip-badge">${clientCountry}</span></p>
                <p>📡 輸出端點：<span class="ip-badge" style="background:#fff3e0; color:#e65100;">${config.currentIPList[0].ip}:${config.currentIPList[0].port}</span></p>
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
                            <option value="safe" ${config.currentActiveId==='safe'?'selected':''}>🌟 [Safe Key] 永久打底賬戶 (${config.safeKey.time})</option>
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
                        • PrivateKey: ${finalKeyObj.privateKey}<br>
                        • PublicKey: ${finalKeyObj.publicKey}<br>
                        • Reserved: [${Array.isArray(finalKeyObj.reserved)?finalKeyObj.reserved.join(', '):finalKeyObj.reserved}]
                    </div>

                    <div class="row" style="margin-top:15px;">
                        <label>✍️ 自訂額外 Rules 路由規則：</label>
                        <textarea name="custom_rules">${config.customRulesText}</textarea>
                    </div>

                    <div class="row">
                        <label>⚡ 輸出優選端點數量：</label>
                        <input type="number" name="ip_count" value="${config.selectIPCount}" min="1" max="5" style="width:70px;">
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
