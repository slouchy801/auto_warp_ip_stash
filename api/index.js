const crypto = require('crypto');
const https = require('https');

// ==========================================
// 🌟 1. 原生 Redis REST API 讀寫引擎
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

const fallbackKey = { privateKey: "GE0...", publicKey: "CF...", reserved: "0,0,0", time: "系統自動初始化" };

let memoryBackup = {
    safeKey: fallbackKey,
    currentActiveId: "safe",
    latestRegisteredObj: null,
    keyHistoryPool: [],
    useForceRotate: true, 
    rotateUnit: "d",
    rotateValue: 1,
    selectIPCount: 5,
    lastRotateTime: Date.now(),
    customRulesText: "# 在此輸入自訂 Rules，每行一條\n- DOMAIN-SUFFIX,netflix.com,PROXY"
};

async function loadConfig() {
    try {
        const data = await redisCommand('GET', ['auto_wis_config']);
        if (data) {
            let cfg = JSON.parse(data);
            if (!cfg.safeKey || !cfg.safeKey.privateKey) cfg.safeKey = fallbackKey;
            if (!cfg.keyHistoryPool) cfg.keyHistoryPool = [];
            if (cfg.useForceRotate === undefined) cfg.useForceRotate = true;
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

// ==========================================
// ⚙️ 2. EdgeTunnel 萬能 Anycast 網段隨機發電機
// ==========================================
const CF_IP_RANGES = [
    '162.159.192.', '162.159.193.', '162.159.195.', '188.114.96.', 
    '188.114.97.', '188.114.98.', '188.114.99.', '172.67.0.', 
    '104.16.0.', '104.17.0.', '104.18.0.', '104.19.0.'
];
const CF_PORTS = [854, 878, 892, 2408, 4500, 5000, 51820];

function generateEdgeTunnelIPs(count) {
    let pool = [];
    for (let i = 0; i < 150; i++) {
        const range = CF_IP_RANGES[Math.floor(Math.random() * CF_IP_RANGES.length)];
        const lastOctet = Math.floor(Math.random() * 254) + 1;
        const port = CF_PORTS[Math.floor(Math.random() * CF_PORTS.length)];
        pool.push({ ip: `${range}${lastOctet}`, port });
    }
    return pool.sort(() => 0.5 - Math.random()).slice(0, count);
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
        return { privateKey: priv, publicKey: pub, reserved: resArr.join(','), time: new Date().toLocaleTimeString() };
    } catch (e) { return null; }
}

function getRotateMs(value, unit) {
    const val = parseInt(value) || 1;
    if (unit === 'm') return val * 60 * 1000;
    if (unit === 'h') return val * 60 * 60 * 1000;
    return val * 24 * 60 * 60 * 1000;
}

// Helper: 用來單獨打包生成 YAML 文本，供主路由和 AJAX 接口共用
function buildStashYaml(finalIPList, finalKeyObj, customRulesText) {
    let reservedYamlArray = "[0, 0, 0]";
    if (finalKeyObj && finalKeyObj.reserved) {
        try {
            const cleanNums = finalKeyObj.reserved.split(',').map(num => parseInt(num.trim()) || 0);
            reservedYamlArray = `[${cleanNums.join(', ')}]`;
        } catch(e) {
            reservedYamlArray = "[0, 0, 0]";
        }
    }

    let localIPv6 = "2606:4700:110:860a:defb:f7c2:ef4f:9bce/128";
    let stashProxiesSection = "proxies:\n";
    let proxyNames = [];
    
    finalIPList.forEach((item, index) => {
        const nodeName = `🚀 WG-噴泉優選-[${index+1}]`;
        proxyNames.push(nodeName);
        
        stashProxiesSection += `  - name: "${nodeName}"\n` +
                               `    type: wireguard\n` +
                               `    server: ${item.ip}\n` +
                               `    port: ${item.port}\n` +
                               `    ip: 172.16.0.2/32\n` +
                               `    ipv6: ${localIPv6}\n` +
                               `    public-key: "${finalKeyObj.publicKey}"\n` +
                               `    private-key: "${finalKeyObj.privateKey}"\n` +
                               `    reserved: ${reservedYamlArray}\n` +
                               `    udp: true\n` +
                               `    mtu: 1420\n`;
    });

    let stashGroupSection = "proxy-groups:\n  - name: PROXY\n    type: select\n    proxies:\n";
    proxyNames.forEach(name => { stashGroupSection += `    - "${name}"\n`; });
    stashGroupSection += `    - DIRECT\n`;

    let processedCustomRules = customRulesText
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => `  - ${line}`)
        .join('\n');

    let stashRulesSection = `rules:\n`;
    if (processedCustomRules) stashRulesSection += `${processedCustomRules}\n`;
    stashRulesSection += `  - GEOIP,private,DIRECT\n  - MATCH,PROXY`;

    return `${stashProxiesSection}\n${stashGroupSection}\n${stashRulesSection}`;
}

// ==========================================
// 🚀 3. 主路由邏輯
// ==========================================
export default async function handler(request, response) {
    const userAgent = (request.headers['user-agent'] || '').toLowerCase();
    const { method, query } = request;
    
    const clientCountry = request.headers['x-vercel-ip-country'] || 'HK';
    const hostUrl = `https://${request.headers.host}${request.url.split('?')[0]}`;
    const isStash = userAgent.includes('stash') || userAgent.includes('clash') || query.type === 'stash';

    let config = await loadConfig();

    if (config.safeKey.privateKey === "請在控制台選定或自訂" || config.safeKey.privateKey === "GE0...") {
        const initAcc = await registerWarpAccount();
        if (initAcc) {
            config.safeKey = initAcc;
            await saveConfig(config);
        }
    }

    // 取得當前鎖定套用中嘅 Key
    let finalKeyObj = config.safeKey;
    if (config.currentActiveId === "latest" && config.latestRegisteredObj) {
        finalKeyObj = config.latestRegisteredObj;
    } else if (config.currentActiveId.startsWith("history_") && config.keyHistoryPool) {
        const idx = parseInt(config.currentActiveId.split("_")[1]);
        if (config.keyHistoryPool[idx]) finalKeyObj = config.keyHistoryPool[idx];
    }

    // ==========================================
    // ⚙️ 4. 處理控制台提交
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
            
            // 🔄 核心局部刷新優化：如果只是要立刻更換 IP 池
            if (action === 'force_rotate_now') {
                const freshIPList = generateEdgeTunnelIPs(config.selectIPCount);
                const freshYaml = buildStashYaml(freshIPList, finalKeyObj, config.customRulesText);
                
                // 直接向前端回傳純 JSON 數據，不重整網頁、不影響計時器和金鑰
                response.setHeader('Content-Type', 'application/json');
                return response.status(200).send(JSON.stringify({
                    success: true,
                    ipList: freshIPList,
                    yaml: freshYaml
                }));
            }
            
            if (action === 'save_settings') {
                const selectedId = params.get('active_key_id') || "safe";
                config.currentActiveId = selectedId;
                
                if (params.get('make_safe_permanent') === 'true') {
                    if (selectedId === "latest" && config.latestRegisteredObj) {
                        config.safeKey = JSON.parse(JSON.stringify(config.latestRegisteredObj));
                        config.safeKey.time = "選單鎖定覆蓋 (" + new Date().toLocaleTimeString() + ")";
                        config.currentActiveId = "safe"; 
                    } else if (selectedId.startsWith("history_")) {
                        const idx = parseInt(selectedId.split("_")[1]);
                        if (config.keyHistoryPool && config.keyHistoryPool[idx]) {
                            config.safeKey = JSON.parse(JSON.stringify(config.keyHistoryPool[idx]));
                            config.safeKey.time = "選單鎖定覆蓋 (" + new Date().toLocaleTimeString() + ")";
                            config.currentActiveId = "safe";
                        }
                    }
                }

                config.customRulesText = params.get('custom_rules') || "";
                config.useForceRotate = params.get('use_force') === 'true';
                config.rotateUnit = params.get('rotate_unit') || 'd';
                config.rotateValue = parseInt(params.get('rotate_value')) || 1;
                config.selectIPCount = Math.max(1, Math.min(50, parseInt(params.get('ip_count')) || 5));
            } else if (action === 'click_register_new') {
                const newAcc = await registerWarpAccount();
                if (newAcc) {
                    if (config.latestRegisteredObj) config.keyHistoryPool.unshift(config.latestRegisteredObj);
                    config.latestRegisteredObj = newAcc;
                    config.currentActiveId = "latest"; 
                    if (config.keyHistoryPool.length > 10) config.keyHistoryPool = config.keyHistoryPool.slice(0, 10);
                }
            }
            await saveConfig(config);
        } catch (e) {}
        response.writeHead(302, { Location: request.url });
        return response.end();
    }

    // ==========================================
    // ⏱️ 5. 自動定時生命週期 (定時交棒計時器 - 只負責換 Key)
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
        // 換完 Key 後重新對齊對象
        if (config.currentActiveId === "latest") finalKeyObj = config.latestRegisteredObj;
    }

    // ==========================================
    // 🍏 6. 構造 Stash YAML
    // ==========================================
    let finalIPList = generateEdgeTunnelIPs(config.selectIPCount);
    const fullStashYaml = buildStashYaml(finalIPList, finalKeyObj, config.customRulesText);

    if (isStash) {
        response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return response.status(200).send(fullStashYaml);
    }

    // ==========================================
    // 🌐 7. 控制台網頁 GUI 面版
    // ==========================================
    const nextRotateCountDown = Math.max(0, Math.round((duration - (now - config.lastRotateTime)) / 1000));
    const currentTimeString = new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' });

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Auto-WIS 終極密鑰池控制台</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f9; color: #333; padding: 30px; margin: 0; }
            .container { max-width: 800px; margin: 0 auto; }
            .card { background: white; padding: 25px; border-radius: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.04); margin-bottom: 25px; }
            .time-banner { background: #1e1e24; color: #fff; padding: 12px 20px; border-radius: 10px; font-weight: bold; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; font-family: monospace; font-size: 14px; box-shadow: inset 0 0 10px rgba(0,0,0,0.5); }
            h2 { margin-top: 0; color: #007aff; border-bottom: 2px solid #f2f2f2; padding-bottom: 12px; font-size: 20px; }
            .row { margin-bottom: 18px; }
            label { font-weight: bold; display: block; margin-bottom: 6px; color: #444; }
            input[type="number"], select, textarea { padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; box-sizing: border-box; }
            select, textarea { width: 100%; font-family: monospace; background: #fafafa; }
            textarea { height: 90px; resize: vertical; }
            button { background: #007aff; color: white; border: none; padding: 11px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 14px; }
            button.btn-reg { background: #ff9500; font-size: 16px; width: 100%; padding: 14px; border-radius: 10px; box-shadow: 0 4px 10px rgba(255,149,0,0.2); border: none; color:white; font-weight:bold; }
            button.force { background: #34c759; }
            .ip-badge { background: #e1f5fe; color: #0288d1; padding: 3px 8px; border-radius: 6px; font-family: monospace; font-weight: bold; }
            .active-box { background: #e8f5e9; border-left: 5px solid #34c759; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 13px; margin-top: 10px; color:#1b5e20; }
            .url-box { background: #f8f9fa; border: 1px dashed #007aff; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 13px; color: #333; cursor: pointer; margin-top: 5px; }
            pre { background: #1e1e1e; color: #4af626; padding: 18px; border-radius: 10px; overflow-x: auto; font-family: 'Courier New', monospace; font-size: 13px; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; font-size: 14px; }
            th { background: #f8f9fa; color: #666; }
            td.mono { font-family: monospace; font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="container">
            
            <div class="time-banner">
                <span>⏰ <span style="color:#ff9500; margin-right:8px;">Version 1.0.2</span> 系統實時時間 (HKT)：<span id="live-clock">${currentTimeString}</span></span>
                <span style="color: #34c759;">🟢 頁面已同步更新</span>
            </div>

            <div class="card">
                <h2>🌐 系統連線狀態</h2>
                <p>Redis 雲端同步大腦連線正常 🟢 手機定位目前身處：<span class="ip-badge">${clientCountry}</span></p>
            </div>

            <div class="card" style="background: linear-gradient(135deg, #007aff, #0056b3); color: white;">
                <h2>⚡ 一鍵免手動金鑰生成器</h2>
                <p style="margin-top: 10px; font-size: 14px; opacity: 0.9;">直接向 Cloudflare 申請一條全新 WARP 金鑰，生成後可在下方下拉選單直接鎖定！</p>
                <form method="POST">
                    <input type="hidden" name="action" value="click_register_new">
                    <button type="submit" class="btn-reg">⚡ 依家立刻獲取全新金鑰</button>
                </form>
            </div>

            <div class="card">
                <h2>⚙️ 智能密鑰池管理面版 (100% 零人手輸入)</h2>
                <form method="POST">
                    <input type="hidden" name="action" value="save_settings">
                    
                    <div class="row" style="background:#f0f7ff; padding:15px; border-radius:10px; border: 1px solid #b3d7ff;">
                        <label style="color:#007aff; font-size: 16px;">🎯 【下拉選單】揀一條你中意嘅金鑰入去：</label>
                        <select name="active_key_id" style="font-size:15px; font-weight:bold; color:#0056b3; padding:8px; background:#fff;">
                            <option value="safe" ${config.currentActiveId==='safe'?'selected':''}>🌟 [Safe Key] 永久固定打底賬戶 (${config.safeKey.time})</option>
                            ${config.latestRegisteredObj ? `<option value="latest" ${config.currentActiveId==='latest'?'selected':''}>🆕 [最新一鍵拎到] - ${config.latestRegisteredObj.time}</option>` : ''}
                            ${config.keyHistoryPool ? config.keyHistoryPool.map((k, idx) => `
                                <option value="history_${idx}" ${config.currentActiveId===`history_${idx}`?'selected':''}>📜 [歷史池第 ${idx+1} 個] - ${k.time}</option>
                            `).join('') : ''}
                        </select>
                        
                        <div style="margin-top:10px;">
                            <input type="checkbox" id="make_safe" name="make_safe_permanent" value="true">
                            <label for="make_safe" style="display:inline; color:#007aff; font-weight:bold; cursor:pointer;">💾 剔呢度：直接將選中嘅 Key 覆蓋並鎖定為「永久 Safe Key」打底</label>
                        </div>

                        <div class="active-box">
                            <strong>🟢 當前 Stash 連線【鎖定套用中】金鑰詳情：</strong><br>
                            • PrivateKey: <span style="word-break:break-all;">${finalKeyObj.privateKey}</span><br>
                            • PublicKey: <span>${finalKeyObj.publicKey}</span>
                        </div>
                    </div>

                    <div class="row" style="background:#fffcf0; padding:15px; border-radius:10px; border: 1px dashed #ff9500;">
                        <label style="color:#ff9500;">✍️ 自訂額外 Rules 路由規則欄：</label>
                        <textarea name="custom_rules">${config.customRulesText}</textarea>
                    </div>

                    <div class="row">
                        <label>⚡ 每次實時碰撞生成的 EdgeTunnel 隨機 IP 數量：</label>
                        <input type="number" name="ip_count" value="${config.selectIPCount}" style="width: 70px; text-align:center;" min="1" max="50"> 個節點
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

                    <button type="submit">💾 儲存並同步到 Redis</button>
                </form>
                
                <div style="margin-top: 15px; border-top:1px solid #eee; padding-top:15px;">
                    <button type="button" class="force" id="btn-async-rotate">🔄 ⚡ 依家立刻強制更換隨機 IP池</button>
                    <p style="font-size:12px; color:#777; margin-top:8px;">⏳ 距離下一次自動交棒剩餘：<strong>${nextRotateCountDown} 秒</strong></p>
                </div>
            </div>

            <div class="card">
                <h2>📊 EdgeTunnel 實時網段隨機生成 IP (刷新即全變)</h2>
                <table>
                    <thead><tr><th>順序</th><th>隨機 Anycast IP</th><th>Port</th></tr></thead>
                    <tbody id="ip-table-body">
                        ${finalIPList.map((item, index) => `
                            <tr><td># ${index + 1}</td><td class="mono" style="color:#0288d1;">${item.ip}</td><td class="mono">${item.port}</td></tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>

            <div class="card" style="border: 2px solid #007aff;">
                <h2>🔗 乾淨的手機 Stash 訂閱網址</h2>
                <div class="url-box" onclick="navigator.clipboard.writeText('${hostUrl}?type=stash');alert('已複製 Stash 訂閱網址！');">🍏 點擊複製：${hostUrl}?type=stash</div>
            </div>

            <div class="card"><details><summary>🔽 點擊展開 / 查看當前純淨 YAML 配置</summary><pre id="yaml-preview">${fullStashYaml.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></details></div>
        </div>
        
        <script>
            // 網頁端動態時鐘
            setInterval(() => {
                const now = new Date();
                document.getElementById('live-clock').innerText = now.toLocaleString('zh-HK');
            }, 1000);

            // 💡 異步局部刷新邏輯：只更新 IP 表格和 YAML 預覽，不刷新網頁
            document.getElementById('btn-async-rotate').addEventListener('click', async function() {
                const btn = this;
                btn.disabled = true;
                btn.innerText = "⏳ 正在洗牌更換中...";
                
                try {
                    const response = await fetch('', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: 'action=force_rotate_now'
                    });
                    
                    if (response.ok) {
                        const data = await response.json();
                        if (data.success) {
                            // 1. 動態重組並更新 IP 列表表格
                            let tableHtml = '';
                            data.ipList.forEach((item, index) => {
                                tableHtml += \`<tr><td># \${index + 1}</td><td class="mono" style="color:#0288d1;">\${item.ip}</td><td class="mono">\${item.port}</td></tr>\`;
                            });
                            document.getElementById('ip-table-body').innerHTML = tableHtml;
                            
                            // 2. 動態更新下方展開的 YAML 代碼框
                            const escapedYaml = data.yaml.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                            document.getElementById('yaml-preview').innerHTML = escapedYaml;
                        }
                    }
                } catch (e) {
                    console.error("局部刷新失敗: ", e);
                } finally {
                    btn.disabled = false;
                    btn.innerText = "🔄 ⚡ 依家立刻強制更換隨機 IP池";
                }
            });
        </script>
    </body>
    </html>
    `;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.status(200).send(html);
}
