const crypto = require('crypto');
const https = require('https');

// 全局記憶體（計時器核心）
let recentKeys = [];
let lockedPrivateKey = ""; 
let lastRotateTime = Date.now(); // 上次自動洗牌時間

// 定時設定（預設：不啟用強制洗牌，每 1 小時動態換）
let useForceRotate = false;
let rotateUnit = "h"; // s, m, h, d, w, y
let rotateValue = 1;

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

// 計算過期秒數
function getRotateMs(value, unit) {
    const val = parseInt(value) || 1;
    switch(unit) {
        case 's': return val * 1000;
        case 'm': return val * 60 * 1000;
        case 'h': return val * 60 * 60 * 1000;
        case 'd': return val * 24 * 60 * 60 * 1000;
        case 'w': return val * 7 * 24 * 60 * 60 * 1000;
        case 'y': return val * 365 * 24 * 60 * 60 * 1000;
        default: return 60 * 60 * 1000;
    }
}

export default async function handler(request, response) {
    const userAgent = request.headers['user-agent'] || '';
    const { method, query } = request;

    // --- 網頁 POST 表單控制 ---
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
                rotateUnit = params.get('rotate_unit') || 'h';
                rotateValue = parseInt(params.get('rotate_value')) || 1;
            } else if (action === 'unlock') {
                lockedPrivateKey = "";
            } else if (action === 'force_now') {
                lastRotateTime = 0; // 觸發立刻洗牌
            }
        } catch (e) {}
        response.writeHead(302, { Location: request.url });
        return response.end();
    }

    try {
        // 核心邏輯：檢查時間有沒有過期
        const now = Date.now();
        const duration = getRotateMs(rotateValue, rotateUnit);
        const isExpired = (now - lastRotateTime) >= duration;

        let shouldRotate = false;

        // 判斷是否需要洗牌
        if (useForceRotate) {
            // 情況 A：用左「強制勾選」，就算有 safe key 都照轉
            if (isExpired) shouldRotate = true;
        } else {
            // 情況 B：無勾選強制
            if (!lockedPrivateKey) {
                // 無 safe key，跟隨時間去轉
                if (isExpired) shouldRotate = true;
            } else {
                // 有 safe key，永遠不轉
                shouldRotate = false;
            }
        }

        // 執行洗牌或調用
        let realPrivateKey = "";
        if (shouldRotate) {
            // 時間到，轉生新 Key
            realPrivateKey = crypto.randomBytes(32).toString('base64');
            lastRotateTime = now; // 重置計時器
            
            // 如果開了「強制勾選」而且有鎖定 key，洗牌時順便更新鎖定的 key 為這把新鑰
            if (useForceRotate && lockedPrivateKey) {
                lockedPrivateKey = realPrivateKey;
            }

            if (!recentKeys.includes(realPrivateKey)) {
                recentKeys.unshift(realPrivateKey);
                if (recentKeys.length > 10) recentKeys.pop();
            }
        } else {
            // 未過期，或處於鎖定狀態
            if (lockedPrivateKey) {
                realPrivateKey = lockedPrivateKey;
            } else {
                // 沒鎖定也沒過期，拿清單最新的那一條，保持短時間內穩定
                realPrivateKey = recentKeys[0] || crypto.randomBytes(32).toString('base64');
                if (!recentKeys.includes(realPrivateKey)) recentKeys.unshift(realPrivateKey);
            }
        }

        // 打去 CF 註冊免洗帳戶
        const regData = await cfPost('https://api.cloudflareclient.com/v0a/reg', {
            "key": crypto.randomBytes(32).toString('base64'),
            "install_id": "", "fcm_token": ""
        });

        const peerPubKey = regData.config.peers[0].public_key;
        const clientIPv4 = regData.config.interface.addresses.v4.replace('/32', '');
        const clientIPv6 = regData.config.interface.addresses.v6.replace('/128', '');
        const clientID = regData.config.client_id || ""; 

        let reserved = "[0,0,0]";
        if (clientID) {
            try {
                const parsedId = Buffer.from(clientID, 'base64').toString('binary');
                if (parsedId.length >= 3) {
                    reserved = "[" + [parsedId.charCodeAt(0), parsedId.charCodeAt(1), parsedId.charCodeAt(2)].join(",") + "]";
                }
            } catch(e){}
        }

        const nextRotateCountDown = Math.max(0, Math.round((duration - (now - lastRotateTime)) / 1000));

        const stashYaml = `# =========================================================
# ⚙️ [3X-UI WARP FUNCTION - AUTOMATIC ROTATION PANEL]
# Private Key Mode: ${lockedPrivateKey ? "🔒 FIXED (Safe Key)" : "🔄 DYNAMIC"}
# Force Rotate Checkbox: ${useForceRotate ? "✅ ON (Override Safe Key)" : "❌ OFF"}
# Next Scheduled Rotation: In ${nextRotateCountDown} seconds
# Active Private Key: ${realPrivateKey}
# =========================================================

proxies:
  - name: "🚀 CF-WARP-Rotated"
    type: wireguard
    server: 162.159.192.1
    port: 2408
    ip: ${clientIPv4}
    ipv6: ${clientIPv6}
    public-key: ${peerPubKey}
    private-key: ${realPrivateKey}
    reserved: ${reserved}
    udp: true
    remote-dns-resolve: true
    mtu: 1280
`;

        if (userAgent.includes('Stash') || userAgent.includes('Clash') || query.format === 'yaml') {
            response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
            return response.status(200).send(stashYaml);
        }

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Auto-WIS 智能定時控制台</title>
            <style>
                body { font-family: -apple-system, sans-serif; background: #f4f6f9; color: #333; padding: 30px; }
                .card { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); margin-bottom: 20px; max-width: 750px; }
                h2 { margin-top: 0; color: #007aff; border-bottom: 2px solid #f0f0f0; padding-bottom: 10px; }
                .row { margin-bottom: 15px; }
                label { font-weight: bold; display: block; margin-bottom: 5px; }
                input[type="text"], input[type="number"], select { padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
                input[type="text"] { width: 80%; font-family: monospace; }
                button { background: #007aff; color: white; border: none; padding: 10px 15px; border-radius: 6px; cursor: pointer; font-weight: bold; }
                button.force { background: #34c759; margin-left: 10px; }
                button.unlock { background: #ff3b30; }
                ol { padding-left: 20px; font-family: monospace; background: #fafafa; padding: 15px; border-radius: 6px; border: 1px solid #eee; }
                pre { background: #222; color: #27c93f; padding: 15px; border-radius: 6px; overflow-x: auto; font-family: monospace; }
                .status-tag { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; color: white; }
                .bg-orange { background: #ff9500; }
                .bg-green { background: #34c759; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>⚙️ 智能控制面板（定時 + 鎖定設定）</h2>
                <form method="POST">
                    <input type="hidden" name="action" value="save_all">
                    
                    <div class="row">
                        <label>1. Safe Private Key 鎖定框：</label>
                        <input type="text" name="custom_key" value="${lockedPrivateKey}" placeholder="在此貼入你想鎖定的 Private Key（留空則完全走定時免洗模式）">
                        ${lockedPrivateKey ? `<span class="status-tag bg-green">🔒 已鎖定</span>` : `<span class="status-tag bg-orange">🔄 免洗中</span>`}
                    </div>

                    <div class="row" style="background: #f9f9f9; padding: 15px; border-radius: 8px; border-left: 4px solid #007aff;">
                        <label style="color:#007aff;">2. ⏱️ 定時自動洗牌週期設定：</label>
                        每 
                        <input type="number" name="rotate_value" value="${rotateValue}" style="width: 60px;" min="1">
                        <select name="rotate_unit">
                            <option value="s" ${rotateUnit==='s'?'selected':''}>秒 (s)</option>
                            <option value="m" ${rotateUnit==='m'?'selected':''}>分鐘 (m)</option>
                            <option value="h" ${rotateUnit==='h'?'selected':''}>小時 (h)</option>
                            <option value="d" ${rotateUnit==='d'?'selected':''}>天 (d)</option>
                            <option value="w" ${rotateUnit==='w'?'selected':''}>周 (w)</option>
                            <option value="y" ${rotateUnit==='y'?'selected':''}>年 (y)</option>
                        </select>
                        自動更換全新 WARP 免洗帳戶
                        
                        <div style="margin-top: 10px;">
                            <input type="checkbox" id="use_force" name="use_force" value="true" ${useForceRotate?'checked':''}>
                            <label for="use_force" style="display:inline; font-weight:normal; color:#ff3b30;">
                                <strong>⚠️ 強制覆蓋勾選：</strong> 啟用後，就算上面填了 Safe Key，時間一到也【照樣強行洗牌轉生】！
                            </label>
                        </div>
                    </div>

                    <button type="submit">💾 儲存並套用全部設定</button>
                </form>

                <div style="margin-top: 15px; border-top: 1px solid #eee; padding-top: 15px;">
                    <form method="POST" style="display:inline;">
                        <input type="hidden" name="action" value="force_now">
                        <button type="submit" class="force">⚡ 唔等時間喇，依家立刻強制洗牌一次</button>
                    </form>
                    ${lockedPrivateKey ? `
                    <form method="POST" style="display:inline;">
                        <input type="hidden" name="action" value="unlock">
                        <button type="submit" class="unlock">🔓 清空 Safe Key</button>
                    </form>` : ''}
                </div>
                
                <p style="font-size: 13px; color: #666;">
                    距離下一次自動洗牌倒數：<strong>${nextRotateCountDown} 秒</strong>（手機更新訂閱時如果時間到會自動執行）
                </p>
            </div>

            <div class="card">
                <h2>📋 最近 10 次生成的 Private Key 記錄歷史</h2>
                <ol>${recentKeys.map(k => `<li>${k} ${k === realPrivateKey ? '🌟(當前生效)' : ''}</li>`).join('')}</ol>
            </div>

            <div class="card">
                <h2>📱 最終 Stash YAML 預覽</h2>
                <pre>${stashYaml.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
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
