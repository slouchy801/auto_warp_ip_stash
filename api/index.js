const crypto = require('crypto');
const https = require('https');

// ==========================================
// 🌟 1. 全局記憶體與控制變數
// ==========================================
let safeKeyObj = { privateKey: "請在下方自訂", publicKey: "請在下方自訂", reserved: "0,0,0" };
let latestRegisteredObj = null; 
let keyHistoryPool = []; 

let useForceRotate = false;
let rotateUnit = "d"; 
let rotateValue = 1;  
let selectIPCount = 3; 
let lastRotateTime = Date.now();

// 自訂 Rules（GEOIP,cn 已除去）
let customRulesText = "# 在此輸入自訂 Rules\n- DOMAIN-SUFFIX,netflix.com,PROXY";

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

function httpGet(url) {
    return new Promise((resolve) => {
        const options = { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3000 };
        https.get(url, options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve(body));
        }).on('error', () => resolve(''));
    });
}

async function registerNewWarpAccount() {
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

export default async function handler(request, response) {
    const userAgent = (request.headers['user-agent'] || '').toLowerCase();
    const { method, query } = request;

    const clientCountry = request.headers['x-vercel-ip-country'] || 'HK';
    const hostUrl = `https://${request.headers.host}${request.url.split('?')[0]}`;
    
    const isStash = userAgent.includes('stash') || userAgent.includes('clash') || query.type === 'stash';

    // ==========================================
    // ⚙️ 2. 處理控制台 POST 表單提交
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
                safeKeyObj.privateKey = params.get('safe_private_key') || "";
                safeKeyObj.publicKey = params.get('safe_public_key') || "";
                safeKeyObj.reserved = params.get('safe_reserved') || "0,0,0";
                
                customRulesText = params.get('custom_rules') || "";
                useForceRotate = params.get('use_force') === 'true';
                rotateUnit = params.get('rotate_unit') || 'd';
                rotateValue = parseInt(params.get('rotate_value')) || 1;
                selectIPCount = Math.max(1, Math.min(20, parseInt(params.get('ip_count')) || 3));
            } else if (action === 'click_register_new') {
                const newAcc = await registerNewWarpAccount();
                if (newAcc) {
                    if (latestRegisteredObj) keyHistoryPool.unshift(latestRegisteredObj);
                    latestRegisteredObj = newAcc;
                    if (keyHistoryPool.length > 10) keyHistoryPool = keyHistoryPool.slice(0, 10);
                }
            } else if (action === 'force_rotate_now') {
                lastRotateTime = 0;
            }
        } catch (e) {}
        response.writeHead(302, { Location: request.url });
        return response.end();
    }

    // ==========================================
    // ⏱️ 3. 🧠 定時轉生交棒邏輯
    // ==========================================
    const now = Date.now();
    const duration = getRotateMs(rotateValue, rotateUnit);
    const isExpired = (now - lastRotateTime) >= duration;
    
    if (isExpired) {
        lastRotateTime = now;
        const autoAcc = await registerNewWarpAccount();
        if (autoAcc) {
            if (latestRegisteredObj) keyHistoryPool.unshift(latestRegisteredObj);
            latestRegisteredObj = autoAcc;
            if (keyHistoryPool.length > 10) keyHistoryPool = keyHistoryPool.slice(0, 10);
        }
    }

    // ==========================================
    // 🎯 4. 🚀 實作「就算更新 100 次都不會變」的持久化鎖定選定 Key
    // ==========================================
    // 網址參數優先（Stash 拉取時帶入固定參數，確保 Serverless 重啟或生了新 Key 都不會變動當前這條 sub）
    let finalPriv = query.pk || safeKeyObj.privateKey;
    let finalPub = query.pub || safeKeyObj.publicKey;
    let finalRes = query.res || safeKeyObj.reserved;

    // 如果是網頁控制台直讀，展示用
    if (!query.pk && latestRegisteredObj) {
        finalPriv = latestRegisteredObj.privateKey;
        finalPub = latestRegisteredObj.publicKey;
        finalRes = latestRegisteredObj.reserved;
    }

    // ==========================================
    // 🔍 5. 去 GitHub 撈取非官方動態優選 IP
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
        githubIPs = [{ ip: '162.159.192.1', port: 854 }, { ip: '162.159.193.5', port: 4500 }];
    }
    let shuffled = githubIPs.sort(() => 0.5 - Math.random());
    let finalIPList = shuffled.slice(0, selectIPCount);

    // 解析 Reserved 轉為 16 進制
    let stashReservedStr = "[0x00, 0x00, 0x00]";
    if (finalRes) {
        try {
            const parts = finalRes.split(',').map(x => parseInt(x.trim()));
            if (parts.length === 3 && !parts.some(isNaN)) {
                stashReservedStr = `[${parts.map(p => `0x${p.toString(16).padStart(2,'0')}`).join(', ')}]`;
            }
        } catch(e){}
    }

    // ==========================================
    // 🍏 6. 建構 Stash YAML（完美淨化 Rules）
    // ==========================================
    let stashProxiesSection = "proxies:\n";
    let proxyNames = [];
    finalIPList.forEach((item, index) => {
        const nodeName = `🚀 WARP-持久鎖定選定-[${index+1}]`;
        proxyNames.push(nodeName);
        stashProxiesSection += `  - name: "${nodeName}"
    type: wireguard
    server: ${item.ip}
    port: ${item.port}
    ip: 172.16.0.2
    ipv6: fd00::2
    public-key: ${finalPub}
    private-key: ${finalPriv}
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

    let processedCustomRules = customRulesText
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
        return response.status(200).send(fullStashYaml);
    }

    // ==========================================
    // 🌐 7. 網頁 GUI 控制台（完美鎖定選定版本）
    // ==========================================
    const nextRotateCountDown = Math.max(0, Math.round((duration - (now - lastRotateTime)) / 1000));

    // 動態生成帶有選定 Key 的持久化手機 Sub 連結（這就是任憑後台怎麼變，手機都鎖死不變的關鍵！）
    const lockedSubUrl = `${hostUrl}?type=stash&pk=${encodeURIComponent(finalPriv)}&pub=${encodeURIComponent(finalPub)}&res=${encodeURIComponent(finalRes)}`;

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Auto-WIS 持久鎖定金鑰控制台</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f9; color: #333; padding: 30px; margin: 0; }
            .container { max-width: 800px; margin: 0 auto; }
            .card { background: white; padding: 25px; border-radius: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.04); margin-bottom: 25px; }
            h2 { margin-top: 0; color: #007aff; border-bottom: 2px solid #f2f2f2; padding-bottom: 12px; font-size: 20px; }
            .row { margin-bottom: 18px; }
            label { font-weight: bold; display: block; margin-bottom: 6px; color: #444; }
            input[type="text"], input[type="number"], select, textarea { padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; box-sizing: border-box; width: 100%; font-family: monospace; background: #fafafa; }
            input[type="number"], select { width: auto; }
            textarea { height: 80px; resize: vertical; }
            button { background: #007aff; color: white; border: none; padding: 12px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 14px; }
            button.btn-reg { background: #ff9500; width: 100%; padding: 14px; border-radius: 10px; font-size: 16px; }
            .url-box { background: #e8f5e9; border: 2px dashed #2e7d32; padding: 15px; border-radius: 8px; font-family: monospace; font-size: 13px; color: #1b5e20; word-break: break-all; cursor: pointer; font-weight: bold; }
            pre { background: #1e1e1e; color: #4af626; padding: 18px; border-radius: 10px; overflow-x: auto; font-family: 'Courier New', monospace; font-size: 13px; }
            summary { font-weight: bold; color: #007aff; cursor: pointer; padding: 5px 0; }
            .pool-item { background: #f8f9fa; border: 1px solid #eee; padding: 10px; border-radius: 6px; margin-bottom: 8px; font-size: 12px; font-family: monospace; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="card" style="background: linear-gradient(135deg, #ff9500, #ff8000); color: white;">
                <h2 style="color: white; border-bottom: 1px solid rgba(255,255,255,0.2);">⚡ 密鑰生產線</h2>
                <p>點擊下方按鈕可生成無數條新 Key。你可以將屬意的 Key 其 Sub 複製到 Stash，手機就會對該條 Key 鎖死不變！</p>
                <form method="POST">
                    <input type="hidden" name="action" value="click_register_new">
                    <button type="submit" class="btn-reg">⚡ 點擊一鍵生成全新 WARP 帳戶金鑰</button>
                </form>
            </div>

            <div class="card" style="border: 2px solid #2e7d32;">
                <h2 style="color:#2e7d32;">🎯 當前選定·持久鎖定不變的 Stash 訂閱 Sub (就算後台更新 100 次此網址也絕不跳變)</h2>
                <p style="font-size:13px; color:#555;">將下面這個網址放入手機 Stash。**裡面的 Key 已被永久固化綁定**，不論 Vercel 如何重啟、後台生了多少新 Key，你的 Stash 都只會雷打不動用這一條 Key，直到定時交棒時間到！</p>
                <div class="url-box" onclick="navigator.clipboard.writeText('${lockedSubUrl}');alert('已複製此條持久化鎖定訂閱！');">
                    🍏 點擊複製當前選定鎖定網址：<br>${lockedSubUrl}
                </div>
            </div>

            <div class="card">
                <h2>⚙️ 配置與金鑰池管理</h2>
                <form method="POST">
                    <input type="hidden" name="action" value="save_settings">
                    
                    <div class="row" style="background:#f0f7ff; padding:15px; border-radius:10px; border:1px solid #b3d7ff;">
                        <label style="color:#007aff;">🌟 靜態自訂 [Safe Key] 資訊填寫欄：</label>
                        <div style="margin-bottom:6px;"><span style="font-size:11px;">Private Key:</span><input type="text" name="safe_private_key" value="${safeKeyObj.privateKey}"></div>
                        <div style="margin-bottom:6px;"><span style="font-size:11px;">Public Key:</span><input type="text" name="safe_public_key" value="${safeKeyObj.publicKey}"></div>
                        <div><span style="font-size:11px;">Reserved:</span><input type="text" name="safe_reserved" value="${safeKeyObj.reserved}"></div>
                    </div>

                    <div class="row" style="background:#fffcf0; padding:15px; border-radius:10px; border: 1px dashed #ff9500;">
                        <label style="color:#ff9500;">✍️ 自訂額外 Rules 路由規則 (GEOIP,cn已剔除)：</label>
                        <textarea name="custom_rules">${customRulesText}</textarea>
                    </div>

                    <div class="row">
                        <label>⏱️ 免洗帳戶自動刷新（定時交棒週期）：</label>
                        每 <input type="number" name="rotate_value" value="${rotateValue}" style="width:60px; text-align:center;">
                        <select name="rotate_unit">
                            <option value="m" ${rotateUnit==='m'?'selected':''}>分鐘</option>
                            <option value="h" ${rotateUnit==='h'?'selected':''}>小時</option>
                            <option value="d" ${rotateUnit==='d'?'selected':''}>天</option>
                        </select>
                        <div style="margin-top:6px;">
                            <input type="checkbox" id="use_force" name="use_force" value="true" ${useForceRotate?'checked':''}>
                            <label for="use_force" style="display:inline; color:#ff3b30; font-weight:normal;">時間到強制交棒更新</label>
                        </div>
                    </div>

                    <div class="row">
                        <label>⚡ 每次 GitHub 優選 IP 數量：</label>
                        <input type="number" name="ip_count" value="${selectIPCount}" style="width:70px; text-align:center;">
                    </div>

                    <button type="submit">💾 儲存所有配置</button>
                </form>
            </div>

            <div class="card">
                <h2>📋 當前生產線最新 Key 與歷史池（點擊各欄可即時生成其專屬鎖定網址）</h2>
                ${latestRegisteredObj ? `
                    <div class="pool-item" style="border:1px solid #ff9500; background:#fff9f0; cursor:pointer;" onclick="window.location.href='?pk=${encodeURIComponent(latestRegisteredObj.privateKey)}&pub=${encodeURIComponent(latestRegisteredObj.publicKey)}&res=${encodeURIComponent(latestRegisteredObj.reserved)}'">
                        <strong>🆕 最新生成的一條 Key (點擊將其綁定到上方綠色格子)：</strong><br>
                        Time: ${latestRegisteredObj.time} | Priv: ${latestRegisteredObj.privateKey.slice(0,20)}...
                    </div>
                ` : ''}
                
                ${keyHistoryPool.map((k, idx) => `
                    <div class="pool-item" style="cursor:pointer;" onclick="window.location.href='?pk=${encodeURIComponent(k.privateKey)}&pub=${encodeURIComponent(k.publicKey)}&res=${encodeURIComponent(k.reserved)}'">
                        📜 歷史累積第 ${idx+1} 條 Key (點擊套用鎖定)：<br>
                        Time: ${k.time} | Priv: ${k.privateKey.slice(0,20)}...
                    </div>
                `).join('')}
            </div>

            <div class="card"><details><summary>🔽 查看當前 Stash YAML 配置</summary><pre>${fullStashYaml.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></details></div>
        </div>
    </body>
    </html>
    `;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.status(200).send(html);
}
