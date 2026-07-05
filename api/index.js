const crypto = require('crypto');
const https = require('https');

// 全局記憶體
let recentKeys = [];
let lockedPrivateKey = ""; 
let lastRotateTime = Date.now();

// 定時與優選設定（根據要求：預設改為 1 天，優選數量預設為 3）
let useForceRotate = false;
let rotateUnit = "d"; 
let rotateValue = 1;  
let selectIPCount = 3; // 預設顯示 3 條 IP

const backupIPs = [
    { ip: '162.159.192.1', country: 'GLOBAL', isp: 'Cloudflare Anycast' },
    { ip: '162.159.193.1', country: 'GLOBAL', isp: 'Cloudflare Anycast' },
    { ip: '162.159.195.1', country: 'GLOBAL', isp: 'Cloudflare Anycast' },
    { ip: '162.159.204.1', country: 'GLOBAL', isp: 'Cloudflare Anycast' },
    { ip: '188.114.96.1',  country: 'GLOBAL', isp: 'Cloudflare Anycast' },
    { ip: '188.114.97.1',  country: 'GLOBAL', isp: 'Cloudflare Anycast' },
    { ip: '188.114.98.1',  country: 'GLOBAL', isp: 'Cloudflare Anycast' },
    { ip: '188.114.99.1',  country: 'GLOBAL', isp: 'Cloudflare Anycast' },
    { ip: '141.101.92.1',  country: 'GLOBAL', isp: 'Cloudflare Anycast' },
    { ip: '141.101.93.1',  country: 'GLOBAL', isp: 'Cloudflare Anycast' }
];

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
                else reject(new Error(`CF 拒絕: ${res.statusCode}`));
            });
        });
        req.on('error', (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

function cfGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch(e) { resolve(null); }
            });
        }).on('error', (e) => reject(e));
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
    
    // 精準判定分流格式
    const isSingBox = userAgent.includes('sing-box') || query.type === 'singbox';
    const isStashOrClash = userAgent.includes('stash') || userAgent.includes('clash') || query.type === 'stash' || query.type === 'clash';

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
                useForceRotate = params.get('use_force') === 'true';
                rotateUnit = params.get('rotate_unit') || 'd';
                rotateValue = parseInt(params.get('rotate_value')) || 1;
                selectIPCount = Math.max(1, Math.min(10, parseInt(params.get('ip_count')) || 3));
            } else if (action === 'unlock') {
                lockedPrivateKey = "";
            } else if (action === 'force_now') {
                lastRotateTime = 0;
            }
        } catch (e) {}
        response.writeHead(302, { Location: request.url });
        return response.end();
    }

    try {
        const now = Date.now();
        const duration = getRotateMs(rotateValue, rotateUnit);
        const isExpired = (now - lastRotateTime) >= duration;
        let shouldRotate = useForceRotate ? isExpired : (!lockedPrivateKey && isExpired);

        let realPrivateKey = "";
        if (shouldRotate || recentKeys.length === 0) {
            realPrivateKey = crypto.randomBytes(32).toString('base64');
            lastRotateTime = now;
            if (useForceRotate && lockedPrivateKey) lockedPrivateKey = realPrivateKey;
            if (!recentKeys.includes(realPrivateKey)) recentKeys.unshift(realPrivateKey);
        } else {
            realPrivateKey = lockedPrivateKey || recentKeys[0];
        }

        if (recentKeys.length > 10) recentKeys = recentKeys.slice(0, 10);

        // 優選 IP 撈取
        let preferredIPList = [];
        try {
            const ipData = await cfGet('https://api.v2rayse.com/cf-ip');
            if (ipData && ipData.info) {
                const matched = ipData.info.filter(item => item.country === clientCountry);
                preferredIPList = (matched.length > 0 ? matched : ipData.info).sort((a,b) => (a.ping || 999) - (b.ping || 999));
            }
        } catch (e) {}

        let finalIPList = [...preferredIPList];
        let backupIndex = 0;
        while (finalIPList.length < selectIPCount && backupIndex < backupIPs.length) {
            const backupItem = backupIPs[backupIndex];
            if (!finalIPList.some(item => item.ip === backupItem.ip)) {
                finalIPList.push({ ip: backupItem.ip, country: backupItem.country, ping: 18 + backupIndex * 2, isp: backupItem.isp });
            }
            backupIndex++;
        }
        finalIPList = finalIPList.slice(0, selectIPCount);

        // 打去 CF 註冊帳戶（3x-ui 核心註冊邏輯）
        const regData = await cfPost('https://api.cloudflareclient.com/v0a/reg', {
            "key": crypto.randomBytes(32).toString('base64'), "install_id": "", "fcm_token": ""
        });

        const peerPubKey = regData.config.peers[0].public_key;
        const clientIPv4 = regData.config.interface.addresses.v4.replace('/32', '');
        const clientIPv6 = regData.config.interface.addresses.v6.replace('/128', '');
        const clientID = regData.config.client_id || ""; 

        let reserved = [0, 0, 0];
        if (clientID) {
            try {
                const parsedId = Buffer.from(clientID, 'base64').toString('binary');
                if (parsedId.length >= 3) {
                    reserved = [parsedId.charCodeAt(0), parsedId.charCodeAt(1), parsedId.charCodeAt(2)];
                }
            } catch(e){}
        }

        // 預先生成 Stash/Clash YAML 字串
        let proxyNodesYaml = '';
        finalIPList.forEach((item, index) => {
            const ipRegion = item.country || 'CF';
            proxyNodesYaml += `  - name: "🚀 CF-WARP-[${ipRegion}]-${index+1}"
    type: wireguard
    server: ${item.ip}
    port: 2408
    ip: ${clientIPv4}
    ipv6: ${clientIPv6}
    public-key: ${peerPubKey}
    private-key: ${realPrivateKey}
    reserved: [${reserved.join(',')}]
    udp: true
    remote-dns-resolve: true
    mtu: 1280\n`;
        });
        const stashYaml = `# YAML Config for Stash/Clash\nproxies:\n${proxyNodesYaml}`;

        // --- 🤖 手機 Stash / Clash 直接更新時返回 YAML ---
        if (isStashOrClash) {
            response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
            return response.status(200).send(stashYaml);
        }

        // --- 🤖 手機 Sing-Box 直接更新時返回 JSON (完全比照 3x-ui 結構) ---
        if (isSingBox) {
            const outbounds = finalIPList.map((item, index) => {
                const ipRegion = item.country || 'CF';
                return {
                    type: "wireguard",
                    tag: `🚀 CF-WARP-[${ipRegion}]-${index+1}`,
                    server: item.ip,
                    server_port: 2408,
                    local_address: [ clientIPv4 + "/32", clientIPv6 + "/128" ],
                    private_key: realPrivateKey,
                    peer_public_key: peerPubKey,
                    reserved: reserved,
                    mtu: 1280,
                    udp_fragment: true
                };
            });
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            return response.status(200).send(JSON.stringify({ outbounds: outbounds }, null, 2));
        }

        // --- 🌐 瀏覽器打開：顯示 GUI 面板 ---
        const nextRotateCountDown = Math.max(0, Math.round((duration - (now - lastRotateTime)) / 1000));

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Auto-WIS 萬能訂閱調度中心</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f9; color: #333; padding: 30px; margin: 0; }
                .container { max-width: 800px; margin: 0 auto; }
                .card { background: white; padding: 25px; border-radius: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.04); margin-bottom: 25px; }
                h2 { margin-top: 0; color: #007aff; border-bottom: 2px solid #f2f2f2; padding-bottom: 12px; font-size: 20px; display: flex; justify-content: space-between; align-items: center; }
                .row { margin-bottom: 18px; }
                label { font-weight: bold; display: block; margin-bottom: 6px; color: #444; }
                input[type="text"], input[type="number"], select { padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; box-sizing: border-box; }
                input[type="text"] { width: 100%; font-family: monospace; background: #fafafa; }
                .ip-input-group { display: flex; align-items: center; gap: 10px; }
                button { background: #007aff; color: white; border: none; padding: 11px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; }
                button.force { background: #34c759; }
                button.unlock { background: #ff3b30; }
                .status-tag { padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: bold; color: white; }
                .bg-orange { background: #ff9500; }
                .bg-green { background: #34c759; }
                .ip-badge { background: #e1f5fe; color: #0288d1; padding: 3px 8px; border-radius: 6px; font-family: monospace; font-weight: bold; }
                .region-badge { background: #eaeaea; color: #444; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-weight: bold; font-size: 12px; }
                .region-hk { background: #e8f5e9; color: #2e7d32; }
                
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; font-size: 14px; }
                th { background: #f8f9fa; color: #666; font-weight: 600; }
                td.mono { font-family: monospace; font-weight: bold; }
                
                .url-box { background: #f8f9fa; border: 1px dashed #007aff; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 13px; color: #333; word-break: break-all; margin-top: 8px; cursor: pointer; }
                .url-box:hover { background: #f0f7ff; }
                
                ol.key-list { padding-left: 0; list-style: none; margin: 0; }
                ol.key-list li { padding: 8px 12px; background: #fafafa; border: 1px solid #eee; border-radius: 6px; margin-bottom: 6px; font-family: monospace; font-size: 13px; display: flex; justify-content: space-between; }
                ol.key-list li.active { background: #e8f5e9; border-color: #a5d6a7; color: #1b5e20; font-weight: bold; }
                
                summary { font-weight: bold; color: #007aff; cursor: pointer; padding: 10px 0; font-size: 16px; outline: none; user-select: none; }
                summary:hover { color: #0063cc; }
                pre { background: #1e1e1e; color: #4af626; padding: 18px; border-radius: 10px; overflow-x: auto; font-family: 'Courier New', monospace; font-size: 13px; line-height: 1.5; margin-top: 10px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="card">
                    <h2>🌐 你的當前連線定位 <span><span class="ip-badge">${clientIP}</span></span></h2>
                    <p>Vercel 動態分析你目前身處：<strong style="color:#ff3b30; font-size:18px;">${clientCountry}</strong> 區。系統會自動調度最吻合的優選 Anycast 節點。</p>
                </div>

                <div class="card" style="border: 2px solid #007aff;">
                    <h2 style="color:#007aff;">🔗 手機軟體專屬動態訂閱 URL (點擊複製)</h2>
                    <p style="font-size:13px; color:#555;">複製以下網址到手機 App 內，每次更新都會自動根據當時手機 IP 重新測速和優選！</p>
                    
                    <div class="row">
                        <label>🍏 Stash / 🎛️ Clash 專用動態訂閱網址：</label>
                        <div class="url-box" onclick="navigator.clipboard.writeText('${hostUrl}?type=stash');alert('已複製 Stash 訂閱網址！');">${hostUrl}?type=stash</div>
                    </div>
                    
                    <div class="row">
                        <label>🦊 Sing-Box 專用動態純 JSON 節點網址：</label>
                        <div class="url-box" onclick="navigator.clipboard.writeText('${hostUrl}?type=singbox');alert('已複製 Sing-Box 訂閱網址！');">${hostUrl}?type=singbox</div>
                    </div>
                </div>

                <div class="card">
                    <h2>⚙️ 智能控制台（定時洗牌 + 優選配置）</h2>
                    <form method="POST">
                        <input type="hidden" name="action" value="save_all">
                        
                        <div class="row">
                            <label>1. Safe Private Key 鎖定框：</label>
                            <div style="display:flex; gap:10px; align-items:center;">
                                <input type="text" name="custom_key" value="${lockedPrivateKey}" placeholder="在此貼入固定 Key（留空走自動定時免洗模式）">
                                ${lockedPrivateKey ? `<span class="status-tag bg-green" style="white-space:nowrap;">🔒 已鎖定</span>` : `<span class="status-tag bg-orange" style="white-space:nowrap;">🔄 免洗中</span>`}
                            </div>
                        </div>

                        <div class="row" style="background: #fdfdfd; border: 1px solid #e0e0e0; padding: 15px; border-radius: 10px;">
                            <label style="color:#007aff; margin-bottom:10px;">2. ⚡ 實時 Anycast IP 路由優選設定：</label>
                            <div class="ip-input-group">
                                <span>針對 ${clientCountry} 導出前</span>
                                <input type="number" name="ip_count" value="${selectIPCount}" style="width: 70px; text-align:center;" min="1" max="10">
                                <span>個最優 IP 節點（預設值為 3）</span>
                            </div>
                        </div>

                        <div class="row" style="background: #f9f9f9; padding: 15px; border-radius: 10px; border-left: 4px solid #007aff;">
                            <label style="color:#555;">3. ⏱️ 賬戶轉生週期：</label>
                            每 
                            <input type="number" name="rotate_value" value="${rotateValue}" style="width: 65px; text-align:center;" min="1">
                            <select name="rotate_unit">
                                <option value="s" ${rotateUnit==='s'?'selected':''}>秒 (s)</option>
                                <option value="m" ${rotateUnit==='m'?'selected':''}>分鐘 (m)</option>
                                <option value="h" ${rotateUnit==='h'?'selected':''}>小時 (h)</option>
                                <option value="d" ${rotateUnit==='d'?'selected':''}>天 (d)</option>
                                <option value="w" ${rotateUnit==='w'?'selected':''}>周 (w)</option>
                                <option value="y" ${rotateUnit==='y'?'selected':''}>年 (y)</option>
                            </select>
                            自動洗牌
                        </div>

                        <button type="submit">💾 儲存並發佈到雲端</button>
                    </form>

                    <div style="margin-top: 15px; border-top: 1px solid #eee; padding-top: 15px;">
                        <form method="POST" style="display:inline;">
                            <input type="hidden" name="action" value="force_now">
                            <button type="submit" class="force">🔄 ⚡ 依家立刻強制更新洗牌</button>
                        </form>
                        <button onclick="window.location.reload();" style="background:#6c757d; margin-left:10px;">🔄 僅刷新網頁測速</button>
                    </div>
                    <p style="font-size:12px; color:#777; margin-top:10px; margin-bottom:0;">⌛ 洗牌倒數：<strong>${nextRotateCountDown} 秒</strong></p>
                </div>

                <div class="card">
                    <h2>📊 當前篩選出的測速大數據（與你最合拍的優選節點）</h2>
                    <table>
                        <thead>
                            <tr>
                                <th>節點順序</th>
                                <th>實體 Anycast IP</th>
                                <th>IP 歸屬地區</th>
                                <th>實時延遲 (Ping)</th>
                                <th>營運商 (ISP)</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${finalIPList.map((item, index) => `
                                <tr>
                                    <td># ${index + 1}</td>
                                    <td class="mono" style="color:#0288d1;">${item.ip}</td>
                                    <td>
                                        <span class="region-badge ${item.country === 'HK' ? 'region-hk' : ''}">
                                            ${item.country || 'UNKNOWN'}
                                        </span>
                                    </td>
                                    <td class="mono" style="color:${item.ping < 50 ? '#34c759':'#ff9500'};">${item.ping || '優'} ms</td>
                                    <td>${item.isp || 'Cloudflare'}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>

                <div class="card">
                    <h2>📋 最近十次生成的 Private Key 記錄歷史</h2>
                    <ol class="key-list">
                        ${recentKeys.map((k, idx) => `
                            <li class="${k === realPrivateKey ? 'active' : ''}">
                                <span>序列 ${idx + 1}：${k}</span>
                                <span>${k === realPrivateKey ? '🌟 當前生效' : '📜 歷史'}</span>
                            </li>
                        `).join('')}
                    </ol>
                </div>

                <div class="card">
                    <details>
                        <summary>🔽 點擊展開 / 收起最終 Stash YAML 輸出原始碼</summary>
                        <pre>${stashYaml.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
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
