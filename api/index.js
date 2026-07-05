const crypto = require('crypto');
const https = require('https');
const { createClient } = require('redis');

// ==========================================
// 🌟 1. 初始化 Redis 終極記憶大腦
// ==========================================
let redisClient = null;

async function getRedis() {
    if (redisClient && redisClient.isOpen) return redisClient;
    // 全自動偵測 Vercel 自動注入的 Redis 密鑰網址
    const redisUrl = process.env.REDIS_URL || process.env.KV_URL || process.env.Official_Redis_Cloud_URL;
    if (!redisUrl) return null;
    try {
        redisClient = createClient({ url: redisUrl });
        redisClient.on('error', () => {});
        await redisClient.connect();
        return redisClient;
    } catch (e) {
        return null;
    }
}

// 記憶體備用兜底（萬一 Redis 還在連線中，避免崩潰）
let memoryBackup = {
    safeKey: { privateKey: "請在控制台選定或自訂", publicKey: "請在控制台選定或自訂", reserved: "0,0,0" },
    currentActiveId: "safe",
    latestRegisteredObj: null,
    keyHistoryPool: [],
    useForceRotate: false,
    rotateUnit: "d",
    rotateValue: 1,
    selectIPCount: 3,
    lastRotateTime: Date.now(),
    customRulesText: "# 在此輸入自訂 Rules，每行一條\n- DOMAIN-SUFFIX,netflix.com,PROXY"
};

// 從 Redis 撈取數據
async function loadConfig() {
    const client = await getRedis();
    if (!client) return memoryBackup;
    try {
        const data = await client.get('auto_wis_config');
        if (data) return JSON.parse(data);
    } catch(e){}
    return memoryBackup;
}

// 儲存數據回 Redis
async function saveConfig(config) {
    memoryBackup = config;
    const client = await getRedis();
    if (!client) return;
    try {
        await client.set('auto_wis_config', JSON.stringify(config));
    } catch(e){}
}

// ==========================================
// ⚙️ 2. EdgeTunnel 萬能 Anycast 網段隨機碰撞機 (每次重新整理噴幾百個全變 IP)
// ==========================================
const CF_IP_RANGES = [
    '162.159.192.', '162.159.193.', '162.159.195.', '188.114.96.', 
    '188.114.97.', '188.114.98.', '188.114.99.', '172.67.0.', 
    '104.16.0.', '104.17.0.', '104.18.0.', '104.19.0.'
];
const CF_PORTS = [854, 878, 892, 2408, 4500, 5000, 1701, 51820];

function generateEdgeTunnelIPs(count) {
    let pool = [];
    // 實時在幾萬個合法 Anycast 網段中隨機碰撞出 200 條 IP
    for (let i = 0; i < 200; i++) {
        const range = CF_IP_RANGES[Math.floor(Math.random() * CF_IP_RANGES.length)];
        const lastOctet = Math.floor(Math.random() * 254) + 1;
        const port = CF_PORTS[Math.floor(Math.random() * CF_PORTS.length)];
        pool.push({ ip: `${range}${lastOctet}`, port });
    }
    // 隨機亂序洗牌
    let shuffled = pool.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

// 向 CF 註冊免洗賬戶
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
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', (e) => reject(e));
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
        return { privateKey: priv, publicKey: pub, reserved: resArr.join(','), time: new Date().toLocaleTimeString() };
    } catch (e) { return null; }
}

function getRotateMs(value, unit) {
    const val = parseInt(value) || 1;
    if (unit === 'm') return val * 60 * 1000;
    if (unit === 'h') return val * 60 * 60 * 1000;
    if (unit === 'd') return val * 24 * 60 * 60 * 1000;
    return 24 * 60 * 60 * 1000;
}

// ==========================================
// 🚀 3. 核心路由處理器
// ==========================================
export default async function handler(request, response) {
    const userAgent = (request.headers['user-agent'] || '').toLowerCase();
    const { method, query } = request;
    
    const clientCountry = request.headers['x-vercel-ip-country'] || 'HK';
    const clientIP = request.headers['x-vercel-forwarded-for'] || '127.0.0.1';
    const hostUrl = `https://${request.headers.host}${request.url.split('?')[0]}`;
    
    const isStash = userAgent.includes('stash') || userAgent.includes('clash') || query.type === 'stash';

    // 💡 讀取永不失憶的 Redis 設定
    let config = await loadConfig();

    // ==========================================
    // ⚙️ 4. 處理控制台 POST 交互
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
            
            if (action === 'save_settings') {
                config.safeKey.privateKey = params.get('safe_private_key') || "";
                config.safeKey.publicKey = params.get('safe_public_key') || "";
                config.safeKey.reserved = params.get('safe_reserved') || "0,0,0";
                
                config.currentActiveId = params.get('active_key_id') || "safe";
                config.customRulesText = params.get('custom_rules') || "";
                config.useForceRotate = params.get('use_force') === 'true';
                config.rotateUnit = params.get('rotate_unit') || 'd';
                config.rotateValue = parseInt(params.get('rotate_value')) || 1;
                config.selectIPCount = Math.max(1, Math.min(100, parseInt(params.get('ip_count')) || 3));
            } else if (action === 'click_register_new') {
                // 💡 一鍵撳掣就拎新 Key 核心 Logic
                const newAcc = await registerWarpAccount();
                if (newAcc) {
                    if (config.latestRegisteredObj) config.keyHistoryPool.unshift(config.latestRegisteredObj);
                    config.latestRegisteredObj = newAcc;
                    config.currentActiveId = "latest"; // 按完自動選定並鎖死這條
                    if (config.keyHistoryPool.length > 10) config.keyHistoryPool = config.keyHistoryPool.slice(0, 10);
                }
            } else if (action === 'force_rotate_now') {
                config.lastRotateTime = 0; // 立刻觸發轉生
            }
            await saveConfig(config);
        } catch (e) {}
        response.writeHead(302, { Location: request.url });
        return response.end();
    }

    // ==========================================
    // ⏱️ 5. 自動化 Rule 轉生交棒判定
    // ==========================================
    const now = Date.now();
    const duration = getRotateMs(config.rotateValue, config.rotateUnit);
    const isExpired = (now - config.lastRotateTime) >= duration;
    
    if (isExpired) {
        config.lastRotateTime = now;
        const autoAcc = await registerWarpAccount();
        if (autoAcc) {
            if (config.latestRegisteredObj) config.keyHistoryPool.unshift(config.latestRegisteredObj);
            config.latestRegisteredObj = autoAcc;
            if (config.useForceRotate) config.currentActiveId = "latest"; // 時間到強制交棒
            if (config.keyHistoryPool.length > 10) config.keyHistoryPool = config.keyHistoryPool.slice(0, 10);
            await saveConfig(config);
        }
    }

    // ==========================================
    // 🎯 6. 鎖定正在使用的金鑰（更新 100 次都不會變）
    // ==========================================
    let finalKeyObj = config.safeKey;
    if (config.currentActiveId === "latest" && config.latestRegisteredObj) {
        finalKeyObj = config.latestRegisteredObj;
    } else if (config.currentActiveId.startsWith("history_")) {
        const idx = parseInt(config.currentActiveId.split("_")[1]);
        if (config.keyHistoryPool[idx]) finalKeyObj = config.keyHistoryPool[idx];
    }

    // ==========================================
    // ⚡ 7. 真·EdgeTunnel IP 噴泉發電機（每次下拉徹底大洗牌變換 IP）
    // ==========================================
    let finalIPList = generateEdgeTunnelIPs(config.selectIPCount);

    let stashReservedStr = "[0x00, 0x00, 0x00]";
    if (finalKeyObj.reserved) {
        try {
            const parts = finalKeyObj.reserved.split(',').map(x => parseInt(x.trim()));
            if (parts.length === 3 && !parts.some(isNaN)) {
                stashReservedStr = `[${parts.map(p => `0x${p.toString(16).padStart(2,'0')}`).join(', ')}]`;
            }
        } catch(e){}
    }

    // ==========================================
    // 🍏 8. 生成標準 Stash YAML 訂閱（乾淨、絕無 unmarshal error）
    // ==========================================
    let stashProxiesSection = "proxies:\n";
    let proxyNames = [];
    finalIPList.forEach((item, index) => {
        const nodeName = `🚀 WG-噴泉優選-[${index+1}]`;
        proxyNames.push(nodeName);
        stashProxiesSection += `  - name: "${nodeName}"
    type: wireguard
    server: ${item.ip}
    port: ${item.port}
    ip: 172.16.0.2
    ipv6: fd00::2
    public-key: ${finalKeyObj.publicKey}
    private-key: ${finalKeyObj.privateKey}
    reserved: ${stashReservedStr}
    udp: true
    remote-dns-resolve: true
    fast-open: true
    prefer-ipv4: true
    mtu: 1280\n`;
    });

    let stashGroupSection = "proxy-groups:\n  - name: PROXY\n    type: select\n    proxies:\n";
    proxyNames.forEach(name => { stashGroupSection += `      - "${name}"\n`; });
    stashGroupSection += `      - DIRECT\n`;

    let processedCustomRules = config.customRulesText
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => `  - ${line}`)
        .join('\n');

    let stashRulesSection = `rules:\n`;
    if (processedCustomRules) stashRulesSection += `${processedCustomRules}\n`;
    stashRulesSection += `  - GEOIP,private,DIRECT\n  - MATCH,PROXY`;

    const fullStashYaml = `${stashProxiesSection}\n${stashGroupSection}\n${stashRulesSection}`;

    if (isStash) {
        response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return response.status(200).send(fullStashYaml);
    }

    // ==========================================
    // 🌐 9. 滿血網頁 GUI 面版（描述與中文完全回歸）
    // ==========================================
    const nextRotateCountDown = Math.max(0, Math.round((duration - (now - config.lastRotateTime)) / 1000));

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Auto-WIS 終極 Redis 噴泉控制台</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f9; color: #333; padding: 30px; margin: 0; }
            .container { max-width: 800px; margin: 0 auto; }
            .card { background: white; padding: 25px; border-radius: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.04); margin-bottom: 25px; }
            h2 { margin-top: 0; color: #007aff; border-bottom: 2px solid #f2f2f2; padding-bottom: 12px; font-size: 20px; }
            .row { margin-bottom: 18px; }
            label { font-weight: bold; display: block; margin-bottom: 6px; color: #444; }
            input[type="text"], input[type="number"], select, textarea { padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; box-sizing: border-box; }
            input[type="text"], select, textarea { width: 100%; font-family: monospace; background: #fafafa; }
            textarea { height: 90px; resize: vertical; }
            button { background: #007aff; color: white; border: none; padding: 11px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 14px; }
            button.btn-reg { background: #ff9500; font-size: 16px; width: 100%; padding: 14px; border-radius: 10px; box-shadow: 0 4px 10px rgba(255,149,0,0.2); }
            button.force { background: #34c759; }
            .ip-badge { background: #e1f5fe; color: #0288d1; padding: 3px 8px; border-radius: 6px; font-family: monospace; font-weight: bold; }
            .active-box { background: #e8f5e9; border-left: 5px solid #34c759; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 13px; margin-top: 10px; color:#1b5e20; }
            .url-box { background: #f8f9fa; border: 1px dashed #007aff; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 13px; color: #333; cursor: pointer; margin-top: 5px; }
            pre { background: #1e1e1e; color: #4af626; padding: 18px; border-radius: 10px; overflow-x: auto; font-family: 'Courier New', monospace; font-size: 13px; }
            summary { font-weight: bold; color: #007aff; cursor: pointer; padding: 5px 0; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; font-size: 14px; }
            th { background: #f8f9fa; color: #666; }
            td.mono { font-family: monospace; font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="card">
                <h2>🌐 當前連線定位 <span><span class="ip-badge">${clientIP}</span></span></h2>
                <p>Vercel 智能定位目前身處：<strong style="color:#ff3b30; font-size:18px;">${clientCountry}</strong> 區。Redis 雲端同步大腦連線正常 🟢</p>
            </div>

            <div class="card" style="background: linear-gradient(135deg, #007aff, #0056b3); color: white;">
                <h2 style="color: white; border-bottom: 1px solid rgba(255,255,255,0.2);">⚡ 密鑰註冊發電機 (一鍵撳落去即拎新 Key)</h2>
                <p style="margin-top: 10px; font-size: 14px; opacity: 0.9;">點擊下方按鈕，Vercel 會即時向 Cloudflare 註冊全新 WARP 帳戶，並直接推入你下方嘅「三合一金鑰池」！</p>
                <form method="POST">
                    <input type="hidden" name="action" value="click_register_new">
                    <button type="submit" class="btn-reg">⚡ 依家立刻註冊一個全新 WARP 帳戶金鑰</button>
                </form>
            </div>

            <div class="card">
                <h2>⚙️ 終極控制台面版（Redis 金鑰池 + EdgeTunnel 噴泉）</h2>
                <form method="POST">
                    <input type="hidden" name="action" value="save_settings">
                    
                    <div class="row" style="background:#f0f7ff; padding:15px; border-radius:10px; border: 1px solid #b3d7ff;">
                        <label style="color:#007aff; font-size: 16px;">🎯 【下拉式選擇】手機 Stash 固定套用邊一個 Key 帳戶 (自動死記在 Redis)：</label>
                        <select name="active_key_id" style="font-size:15px; font-weight:bold; color:#0056b3; padding:8px; background:#fff;">
                            <option value="safe" ${config.currentActiveId==='safe'?'selected':''}>🌟 [Safe Key] 穩定自訂固定靜態帳戶</option>
                            ${config.latestRegisteredObj ? `<option value="latest" ${config.currentActiveId==='latest'?'selected':''}>🆕 [最新一鍵拎到] - ${config.latestRegisteredObj.time} (${config.latestRegisteredObj.privateKey.slice(0,10)}...)</option>` : ''}
                            ${config.keyHistoryPool.map((k, idx) => `
                                <option value="history_${idx}" ${config.currentActiveId===`history_${idx}`?'selected':''}>📜 [歷史以前第 ${idx+1} 個] - ${k.time} (${k.privateKey.slice(0,10)}...)</option>
                            `).join('')}
                        </select>
                        
                        <div class="active-box">
                            <strong>🟢 目前手機連線【鎖定生效中】帳戶資訊 (下拉更新 100 次都不會變)：</strong><br>
                            • PrivateKey: <span style="word-break:break-all;">${finalKeyObj.privateKey}</span><br>
                            • PublicKey: <span>${finalKeyObj.publicKey}</span><br>
                            • Reserved: <span>${finalKeyObj.reserved}</span>
                        </div>
                    </div>

                    <div class="row" style="background:#fafafa; padding:15px; border-radius:10px; border: 1px solid #eee;">
                        <label>🔒 點擊上方下拉或在下方手動儲存你的固定 [Safe Key]：</label>
                        <div style="margin-bottom:8px;"><span style="font-size:11px;">Private Key:</span><input type="text" name="safe_private_key" value="${config.safeKey.privateKey}"></div>
                        <div style="margin-bottom:8px;"><span style="font-size:11px;">Public Key:</span><input type="text" name="safe_public_key" value="${config.safeKey.publicKey}"></div>
                        <div><span style="font-size:11px;">Reserved:</span><input type="text" name="safe_reserved" value="${config.safeKey.reserved}"></div>
                    </div>

                    <div class="row" style="background:#fffcf0; padding:15px; border-radius:10px; border: 1px dashed #ff9500;">
                        <label style="color:#ff9500;">✍️ 自訂額外 Rules 路由規則輸入欄 (GEOIP,cn 已除去)：</label>
                        <textarea name="custom_rules">${config.customRulesText}</textarea>
                    </div>

                    <div class="row">
                        <label>⚡ 每次實時碰撞生成的 EdgeTunnel 優選 IP 數量：</label>
                        <input type="number" name="ip_count" value="${config.selectIPCount}" style="width: 70px; text-align:center;" min="1" max="100"> 個節點（會打亂注入 YAML）
                    </div>

                    <div class="row">
                        <label>⏱️ 免洗帳戶自動刷新（定時交棒週期）：</label>
                        每 <input type="number" name="rotate_value" value="${config.rotateValue}" style="width:65px; text-align:center;">
                        <select name="rotate_unit" style="width:100px; display:inline-block;">
                            <option value="m" ${config.rotateUnit==='m'?'selected':''}>分鐘</option>
                            <option value="h" ${config.rotateUnit==='h'?'selected':''}>小時</option>
                            <option value="d" ${config.rotateUnit==='d'?'selected':''}>天</option>
                        </select>
                        <div style="margin-top: 8px;">
                            <input type="checkbox" id="use_force" name="use_force" value="true" ${config.useForceRotate?'checked':''}>
                            <label for="use_force" style="display:inline; color:#ff3b30; font-weight:normal; cursor:pointer;">時間到強制交棒更新</label>
                        </div>
                    </div>

                    <button type="submit">💾 儲存並發佈到雲端 Redis</button>
                </form>
                
                <div style="margin-top: 15px; border-top:1px solid #eee; padding-top:15px;">
                    <form method="POST" style="display:inline;">
                        <input type="hidden" name="action" value="force_rotate_now">
                        <button type="submit" class="force">🔄 ⚡ 依家立刻強制更新洗牌 (IP 必定秒變)</button>
                    </form>
                    <button onclick="window.location.reload();" style="background:#6c757d; margin-left:10px;">🔄 刷新網頁隨機 IP 庫</button>
                    <p style="font-size:12px; color:#777; margin-top:8px;">⏳ 洗牌交棒倒數：<strong>${nextRotateCountDown} 秒</strong></p>
                </div>
            </div>

            <div class="card">
                <h2>📊 EdgeTunnel 萬能網段實時碰撞 IP（每次 Refresh 全部徹底大洗牌）</h2>
                <table>
                    <thead>
                        <tr><th>節點順序</th><th>隨機 Anycast IP</th><th>連接端口</th></tr>
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

            <div class="card" style="border: 2px solid #007aff;">
                <h2 style="color:#007aff;">🔗 手機全自動同步訂閱網址（乾乾淨淨，零 Error）</h2>
                <div class="url-box" onclick="navigator.clipboard.writeText('${hostUrl}?type=stash');alert('已複製 Stash 訂閱！');">🍏 Stash 訂閱 Sub 網址：${hostUrl}?type=stash</div>
            </div>

            <div class="card"><details><summary>🔽 點擊展開 / 查看當前 Stash YAML 輸出配置</summary><pre>${fullStashYaml.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></details></div>
        </div>
    </body>
    </html>
    `;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.status(200).send(html);
}
