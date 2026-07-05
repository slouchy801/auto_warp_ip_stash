const crypto = require('crypto');
const https = require('https');

// ==========================================
// 🌟 1. 全局持久記憶體（完美控制台資產池核心）
// ==========================================
let safeKeyObj = { privateKey: "請在下方編輯你的固定Key", publicKey: "請在下方編輯", reserved: "0,0,0" };
let currentActiveId = "safe"; // 預設選中 safe
let latestRegisteredObj = null; // 存放一鍵按下去拎到嘅最新 Key
let keyHistoryPool = []; // 存放最多 10 個歷史註冊帳戶物件 [{privateKey, publicKey, reserved, time}]

let useForceRotate = false;
let rotateUnit = "d"; 
let rotateValue = 1;  
let selectIPCount = 3; 
let lastRotateTime = Date.now();

// 自訂 Rules 儲存（GEOIP,cn 已除去）
let customRulesText = "# 在此輸入自訂 Rules，每行一條\n# 例如：\n# - DOMAIN-SUFFIX,google.com,PROXY";

// 封裝 POST 請求（用於一鍵向 Cloudflare 註冊 WARP 帳戶）
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

// 💡 核心修復：高穿透防快取 GET 請求（跟足 Edge Tunnel 破緩存機制）
function httpGetAntiCache(url) {
    return new Promise((resolve) => {
        // 加上時間戳參數破除 GitHub CDN 與 Vercel 內置緩存
        const antiCacheUrl = `${url}?cache_bust=${Date.now()}_${Math.random()}`;
        const options = {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            },
            timeout: 3000
        };
        https.get(antiCacheUrl, options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve(body));
        }).on('error', () => resolve(''));
    });
}

// 註冊一個全新 WARP 帳戶
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
        return {
            privateKey: priv,
            publicKey: pub,
            reserved: resArr.join(','),
            time: new Date().toLocaleTimeString()
        };
    } catch (e) {
        return null;
    }
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
    const clientIP = request.headers['x-vercel-forwarded-for'] || '127.0.0.1';
    const hostUrl = `https://${request.headers.host}${request.url.split('?')[0]}`;
    
    const isStashOrClash = userAgent.includes('stash') || userAgent.includes('clash') || query.type === 'stash' || query.type === 'clash';

    // ==========================================
    // ⚙️ 2. 處理控制台 POST 表單（一鍵按落去拎新 Key、下拉切換選擇）
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
                
                // 🧠 鎖定機制：記死目前下拉選取了哪一把 Key
                currentActiveId = params.get('active_key_id') || "safe";
                
                customRulesText = params.get('custom_rules') || "";
                useForceRotate = params.get('use_force') === 'true';
                rotateUnit = params.get('rotate_unit') || 'd';
                rotateValue = parseInt(params.get('rotate_value')) || 1;
                selectIPCount = Math.max(1, Math.min(20, parseInt(params.get('ip_count')) || 3));
            } else if (action === 'click_register_new') {
                // 💡 起一個鍵按一下就拎新 Key 核心 Logic
                const newAcc = await registerWarpAccount();
                if (newAcc) {
                    if (latestRegisteredObj) {
                        keyHistoryPool.unshift(latestRegisteredObj);
                    }
                    latestRegisteredObj = newAcc;
                    currentActiveId = "latest"; // 按完按鈕自動幫你切換並選定最新呢條
                    
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
    // ⏱️ 3. 免洗定時轉生自動更新機制
    // ==========================================
    const now = Date.now();
    const duration = getRotateMs(rotateValue, rotateUnit);
    const isExpired = (now - lastRotateTime) >= duration;
    
    if (isExpired) {
        lastRotateTime = now;
        const autoAcc = await registerWarpAccount();
        if (autoAcc) {
            if (latestRegisteredObj) keyHistoryPool.unshift(latestRegisteredObj);
            latestRegisteredObj = autoAcc;
            if (useForceRotate) currentActiveId = "latest"; // 時間到強制交棒
            if (keyHistoryPool.length > 10) keyHistoryPool = keyHistoryPool.slice(0, 10);
        }
    }

    // ==========================================
    // 🎯 4. 決策目前選定的 Key（選定後，更新 100 次都不會變，穩如泰山）
    // ==========================================
    let finalUseKeyObj = safeKeyObj; 
    if (currentActiveId === "latest" && latestRegisteredObj) {
        finalUseKeyObj = latestRegisteredObj;
    } else if (currentActiveId.startsWith("history_")) {
        const index = parseInt(currentActiveId.split("_")[1]);
        if (keyHistoryPool[index]) finalUseKeyObj = keyHistoryPool[index];
    }

    // ==========================================
    // 🔍 5. 去 GitHub 撈取【真·即時動態優選 IP】（徹底洗牌，一 Refresh 即變）
    // ==========================================
    let githubIPs = [];
    const sources = [
        'https://raw.githubusercontent.com/banyao2000/warp-speed/main/api/ip.txt',
        'https://raw.githubusercontent.com/fscarmen/warp/main/api/ip.txt'
    ];
    for (const src of sources) {
        const rawText = await httpGetAntiCache(src); // 💡 使用破緩存請求
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
    
    // 🧠 隨機強力洗牌洗出你要的數量（每次 Refresh 這裡都會重新亂序，IP 絕對秒變）
    let shuffled = githubIPs.sort(() => 0.5 - Math.random());
    let finalIPList = shuffled.slice(0, selectIPCount);

    // 解析 Reserved 轉為 16 進制供 Stash 使用
    let stashReservedStr = "[0x00, 0x00, 0x00]";
    if (finalUseKeyObj.reserved) {
        try {
            const parts = finalUseKeyObj.reserved.split(',').map(x => parseInt(x.trim()));
            if (parts.length === 3 && !parts.some(isNaN)) {
                stashReservedStr = `[${parts.map(p => `0x${p.toString(16).padStart(2,'0')}`).join(', ')}]`;
            }
        } catch(e){}
    }

    // ==========================================
    // 🍏 6. 建構符合 Stash 嘅完整 YAML（乾淨無污染，零 unmarshal error）
    // ==========================================
    let stashProxiesSection = "proxies:\n";
    let proxyNames = [];
    finalIPList.forEach((item, index) => {
        const nodeName = `🚀 WARP-池選-[${index+1}]`;
        proxyNames.push(nodeName);
        stashProxiesSection += `  - name: "${nodeName}"
    type: wireguard
    server: ${item.ip}
    port: ${item.port}
    ip: 172.16.0.2
    ipv6: fd00::2
    public-key: ${finalUseKeyObj.publicKey}
    private-key: ${finalUseKeyObj.privateKey}
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

    // 自訂 Rules 與精簡路由處理（完全移除 GEOIP,cn）
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

    // 如果是手機 App 拉取更新，直接噴出純淨無瑕的 YAML 結構
    if (isStashOrClash) {
        response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        return response.status(200).send(fullStashYaml);
    }

    // ==========================================
    // 🌐 7. 網頁 GUI 控制台面版（所有中文字與描述完美回歸）
    // ==========================================
    const nextRotateCountDown = Math.max(0, Math.round((duration - (now - lastRotateTime)) / 1000));

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Auto-WIS 終極密鑰池與優選控制台</title>
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
            button.btn-reg:hover { background: #e08400; }
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
            <div class="card" style="background: linear-gradient(135deg, #007aff, #0056b3); color: white;">
                <h2 style="color: white; border-bottom: 1px solid rgba(255,255,255,0.2);">⚡ 密鑰註冊發電機 (一鍵撳落去即拎新 Key)</h2>
                <p style="margin-top: 10px; font-size: 14px; opacity: 0.9;">點擊下方按鈕，Vercel 會即時向 Cloudflare 註冊全新 WARP 帳戶，並直接推入你下方嘅「三合一金鑰池」！</p>
                <form method="POST">
                    <input type="hidden" name="action" value="click_register_new">
                    <button type="submit" class="btn-reg">⚡ 依家立刻註冊一個全新 WARP 帳戶金鑰</button>
                </form>
            </div>

            <div class="card">
                <h2>⚙️ 終極控制台面版（密鑰池管理 + Edge Tunnel 破緩存優選）</h2>
                <form method="POST">
                    <input type="hidden" name="action" value="save_settings">
                    
                    <div class="row" style="background:#f0f7ff; padding:15px; border-radius:10px; border: 1px solid #b3d7ff;">
                        <label style="color:#007aff; font-size: 16px;">🎯 【下拉式選擇】手機 Stash 固定套用邊一個 Key 帳戶：</label>
                        <select name="active_key_id" style="font-size:15px; font-weight:bold; color:#0056b3; background:#fff; padding:8px;">
                            <option value="safe" ${currentActiveId==='safe'?'selected':''}>🌟 [Safe Key] 穩定自訂固定靜態帳戶</option>
                            ${latestRegisteredObj ? `<option value="latest" ${currentActiveId==='latest'?'selected':''}>🆕 [最新拎到] - ${latestRegisteredObj.time} (${latestRegisteredObj.privateKey.slice(0,10)}...)</option>` : ''}
                            ${keyHistoryPool.map((k, idx) => `
                                <option value="history_${idx}" ${currentActiveId===`history_${idx}`?'selected':''}>📜 [歷史以前第 ${idx+1} 個] - ${k.time} (${k.privateKey.slice(0,10)}...)</option>
                            `).join('')}
                        </select>
                        
                        <div class="active-box">
                            <strong>🟢 目前手機連線【鎖定生效中】帳戶資訊：</strong><br>
                            • PrivateKey: <span style="word-break:break-all;">${finalUseKeyObj.privateKey}</span><br>
                            • PublicKey: <span>${finalUseKeyObj.publicKey}</span><br>
                            • Reserved: <span>${finalUseKeyObj.reserved}</span>
                        </div>
                    </div>

                    <div class="row" style="background:#fafafa; padding:15px; border-radius:10px; border: 1px solid #eee;">
                        <label>🔒 編輯自訂的 [Safe Key] 靜態金鑰（可貼上 3x-ui 運作正常的 Key）：</label>
                        <div style="margin-bottom:8px;"><span style="font-size:11px;">Private Key:</span><input type="text" name="safe_private_key" value="${safeKeyObj.privateKey}"></div>
                        <div style="margin-bottom:8px;"><span style="font-size:11px;">Public Key:</span><input type="text" name="safe_public_key" value="${safeKeyObj.publicKey}"></div>
                        <div><span style="font-size:11px;">Reserved (以逗號分隔，例如 0,0,0):</span><input type="text" name="safe_reserved" value="${safeKeyObj.reserved}"></div>
                    </div>

                    <div class="row" style="background:#fffcf0; padding:15px; border-radius:10px; border: 1px dashed #ff9500;">
                        <label style="color:#ff9500;">✍️ 自訂額外 Rules 路由規則輸入欄 (GEOIP,cn 已除去)：</label>
                        <textarea name="custom_rules">${customRulesText}</textarea>
                    </div>

                    <div class="row">
                        <label>⚡ 每次 GitHub 優選 IP 數量：</label>
                        <input type="number" name="ip_count" value="${selectIPCount}" style="width: 70px; text-align:center;" min="1"> 個節點
                    </div>

                    <div class="row">
                        <label>⏱️ 免洗帳戶自動刷新（定時交棒週期）：</label>
                        每 <input type="number" name="rotate_value" value="${rotateValue}" style="width:65px; text-align:center;">
                        <select name="rotate_unit" style="width:100px; display:inline-block;">
                            <option value="m" ${rotateUnit==='m'?'selected':''}>分鐘</option>
                            <option value="h" ${rotateUnit==='h'?'selected':''}>小時</option>
                            <option value="d" ${rotateUnit==='d'?'selected':''}>天</option>
                        </select>
                        <div style="margin-top: 8px;">
                            <input type="checkbox" id="use_force" name="use_force" value="true" ${useForceRotate?'checked':''}>
                            <label for="use_force" style="display:inline; color:#ff3b30; font-weight:normal; cursor:pointer;">時間到強制交棒更新</label>
                        </div>
                    </div>

                    <button type="submit">💾 儲存所有配置與選擇</button>
                </form>
                
                <div style="margin-top: 15px; border-top:1px solid #eee; padding-top:15px;">
                    <form method="POST" style="display:inline;">
                        <input type="hidden" name="action" value="force_rotate_now">
                        <button type="submit" class="force">🔄 ⚡ 依家立刻強制更新洗牌 (IP 必定全變)</button>
                    </form>
                    <button onclick="window.location.reload();" style="background:#6c757d; margin-left:10px;">🔄 單純重新整理網頁</button>
                    <p style="font-size:12px; color:#777; margin-top:8px;">⏳ 洗牌倒數：<strong>${nextRotateCountDown} 秒</strong></p>
                </div>
            </div>

            <div class="card">
                <h2>📊 當前隨機分配出的 ${selectIPCount} 條非官方 GitHub 優選中轉 IP（破緩存·Refresh 即變）</h2>
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

            <div class="card" style="border: 2px solid #007aff;">
                <h2 style="color:#007aff;">🔗 手機全自動同步訂閱網址（回歸乾淨無污染格式）</h2>
                <div class="url-box" onclick="navigator.clipboard.writeText('${hostUrl}?type=stash');alert('已複製 Stash 訂閱！');">🍏 Stash 訂閱 Sub 網址：${hostUrl}?type=stash</div>
            </div>

            <div class="card"><details><summary>🔽 點擊展開 / 查看當前 Stash YAML 輸出配置</summary><pre>${fullStashYaml.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></details></div>
            <div class="card"><details><summary>🔽 點擊展开 / 查看整合了自訂規則的單獨 Rules</summary><pre>${stashRulesSection}</pre></details></div>
        </div>
    </body>
    </html>
    `;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.status(200).send(html);
}
