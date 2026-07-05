const crypto = require('crypto');
const https = require('https');

// 全局記憶體
let recentKeys = [];
let lockedPrivateKey = ""; 
let lastRotateTime = Date.now();
let selectIPCount = 3; // 預設 3 條 IP

const backupIPs = [
    { ip: '162.159.192.1', country: 'GLOBAL' },
    { ip: '162.159.193.1', country: 'GLOBAL' },
    { ip: '162.159.195.1', country: 'GLOBAL' }
];

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

export default async function handler(request, response) {
    const userAgent = (request.headers['user-agent'] || '').toLowerCase();
    const { method, query } = request;

    const clientCountry = request.headers['x-vercel-ip-country'] || 'HK';
    const clientIP = request.headers['x-vercel-forwarded-for'] || '127.0.0.1';
    const hostUrl = `https://${request.headers.host}${request.url.split('?')[0]}`;
    
    // 判斷客戶端
    const isSingBox = userAgent.includes('sing-box') || query.type === 'singbox';
    const isStashOrClash = userAgent.includes('stash') || userAgent.includes('clash') || query.type === 'stash' || query.type === 'clash';

    // 1. 撈取大數據優選 IP
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
            finalIPList.push({ ip: backupItem.ip, country: backupItem.country, ping: 20 });
        }
        backupIndex++;
    }
    finalIPList = finalIPList.slice(0, selectIPCount);

    // 2. 根據你提供嘅工作範本，100% 完整還原結構
    
    // --- 🍏 生成 Stash / Clash 完整 YAML 訂閱 ---
    let stashProxiesSection = "proxies:\n";
    let proxyNames = [];
    
    finalIPList.forEach((item, index) => {
        const ipRegion = item.country || 'CF';
        const nodeName = `🚀 Reality 優選-[${ipRegion}]-${index+1}`;
        proxyNames.push(nodeName);
        
        stashProxiesSection += `  - client-fingerprint: chrome
    flow: xtls-rprx-vision
    name: "${nodeName}"
    network: tcp
    port: 443
    reality-opts:
      public-key: xxx
      short-id: 7b9e8fd1d79a85
    server: ${item.ip}
    servername: tu.berlin
    tls: true
    type: vless
    udp: true
    uuid: 62e3be07-16e1-48ec-ae3a-019e7ca5b224\n`;
    });

    // 構建 proxy-groups
    let stashGroupSection = "proxy-groups:\n  - name: PROXY\n    type: select\n    proxies:\n";
    proxyNames.forEach(name => {
        stashGroupSection += `      - "${name}"\n`;
    });
    stashGroupSection += `      - DIRECT\n`;

    // 構建 rules
    let stashRulesSection = `rules:
  - GEOSITE,cn,DIRECT
  - GEOIP,cn,DIRECT
  - GEOIP,private,DIRECT
  - MATCH,PROXY`;

    const fullStashYaml = `${stashProxiesSection}\n${stashGroupSection}\n${stashRulesSection}`;


    // --- 🦊 生成 Sing-Box 完整 JSON 訂閱 ---
    const sbOutbounds = finalIPList.map((item, index) => {
        const ipRegion = item.country || 'CF';
        return {
            type: "vless",
            tag: `🚀 Reality 優選-[${ipRegion}]-${index+1}`,
            server: item.ip,
            server_port: 443,
            uuid: "62e3be07-16e1-48ec-ae3a-019e7ca5b224",
            flow: "xtls-rprx-vision",
            packet_encoding: "xray",
            tls: {
                enabled: true,
                server_name: "tu.berlin",
                utls: { enabled: true, fingerprint: "chrome" },
                reality: { enabled: true, public_key: "xxx", short_id: "7b9e8fd1d79a85" }
            }
        };
    });

    // 補齊 Sing-Box 必須的完整結構（selector 策略組與分流規則）
    const fullSingBoxJson = {
        outbounds: [
            {
                type: "selector",
                tag: "PROXY",
                outbounds: sbOutbounds.map(o => o.tag).concat(["direct"])
            },
            ...sbOutbounds,
            { type: "direct", tag: "direct" }
        ],
        route: {
            rules: [
                { geoip: [ "private", "cn" ], geosite: [ "cn" ], outbound: "direct" }
            ],
            final: "PROXY",
            auto_detect_interface: true
        }
    };
    const fullSingBoxJsonStr = JSON.stringify(fullSingBoxJson, null, 2);


    // 🤖 手機 App（Stash/Clash）直接請求，返回 100% 結構完整的 YAML
    if (isStashOrClash) {
        response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        return response.status(200).send(fullStashYaml);
    }

    // 🤖 手機 App（Sing-Box）直接請求，返回 100% 結構完整的 JSON
    if (isSingBox) {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        return response.status(200).send(fullSingBoxJsonStr);
    }

    // 🌐 瀏覽器 GUI 控制台網頁面
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Auto-WIS 萬能動態訂閱中心</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f9; color: #333; padding: 30px; margin: 0; }
            .container { max-width: 800px; margin: 0 auto; }
            .card { background: white; padding: 25px; border-radius: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.04); margin-bottom: 25px; }
            h2 { margin-top: 0; color: #007aff; border-bottom: 2px solid #f2f2f2; padding-bottom: 12px; font-size: 20px; }
            .url-box { background: #f8f9fa; border: 1px dashed #007aff; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 13px; color: #333; word-break: break-all; margin-top: 8px; cursor: pointer; }
            .url-box:hover { background: #f0f7ff; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; font-size: 14px; }
            th { background: #f8f9fa; color: #666; }
            .mono { font-family: monospace; font-weight: bold; }
            .region-badge { background: #eaeaea; color: #444; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 12px; font-weight: bold; }
            .region-hk { background: #e8f5e9; color: #2e7d32; }
            summary { font-weight: bold; color: #007aff; cursor: pointer; padding: 10px 0; font-size: 16px; outline: none; user-select: none; }
            pre { background: #1e1e1e; color: #4af626; padding: 18px; border-radius: 10px; overflow-x: auto; font-family: 'Courier New', monospace; font-size: 13px; line-height: 1.5; margin-top: 10px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="card">
                <h2>🌐 當前檢測位置：<span style="color:#0288d1;">${clientIP} (${clientCountry})</span></h2>
                <p>手機使用下方訂閱網址時，Vercel 每次都會生成 100% 完整結構的配置包給手機軟體，並將 Server 動態替換成最速 IP。</p>
            </div>

            <div class="card" style="border: 2px solid #007aff;">
                <h2 style="color:#007aff;">🔗 手機專用動態訂閱 URL (100% 結構完整)</h2>
                <div style="margin-bottom: 15px;">
                    <label style="font-weight:bold;">🍏 Stash / 🎛️ Clash 專用 Sub 網址：</label>
                    <div class="url-box" onclick="navigator.clipboard.writeText('${hostUrl}?type=stash');alert('已複製 Stash 訂閱網址！');">${hostUrl}?type=stash</div>
                </div>
                <div>
                    <label style="font-weight:bold;">🦊 Sing-Box 專用完整 JSON 網址：</label>
                    <div class="url-box" onclick="navigator.clipboard.writeText('${hostUrl}?type=singbox');alert('已複製 Sing-Box 訂閱網址！');">${hostUrl}?type=singbox</div>
                </div>
            </div>

            <div class="card">
                <h2>📊 目前預設鎖定的 3 條最速 Anycast 優選 IP</h2>
                <table>
                    <thead>
                        <tr>
                            <th>節點</th>
                            <th>優選 IP</th>
                            <th>歸屬地</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${finalIPList.map((item, index) => `
                            <tr>
                                <td># ${index + 1}</td>
                                <td class="mono" style="color:#0288d1;">${item.ip}</td>
                                <td><span class="region-badge ${item.country === 'HK' ? 'region-hk' : ''}">${item.country || 'GLOBAL'}</span></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>

            <div class="card">
                <details>
                    <summary>🔽 點擊展開 / 收起最終 Stash YAML 輸出原始碼 (已包好 Proxies, Groups, Rules)</summary>
                    <pre>${fullStashYaml.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                </details>
            </div>

            <div class="card">
                <details>
                    <summary>🔽 點擊展開 / 收起最終 Sing-Box JSON 輸出原始碼 (已包好 Outbounds, Route Rules)</summary>
                    <pre>${fullSingBoxJsonStr.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                </details>
            </div>
        </div>
    </body>
    </html>
    `;
    
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.status(200).send(html);
}
