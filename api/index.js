const crypto = require('crypto');
const https = require('https');

// 仿照 3x-ui 發送 POST 請求給 Cloudflare
function cfPost(url, data) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const postData = JSON.stringify(data);
        const options = {
            hostname: u.hostname, path: u.pathname, method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'okhttp/3.12.1', // 3x-ui 模擬的安卓官方客戶端 Header
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

export default async function handler(request, response) {
    try {
        // 1. 【3x-ui 核心邏輯一】：在本地憑空生成 WireGuard 必備的私鑰
        const realPrivateKey = crypto.randomBytes(32).toString('base64');

        // 2. 【3x-ui 核心邏輯二】：打去 CF 官方接口註冊，拿取內網 IP 與 client_id
        const regData = await cfPost('https://api.cloudflareclient.com/v0a/reg', {
            "key": "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=", // 官方公共密鑰
            "install_id": "", "fcm_token": ""
        });

        const peerPubKey = regData.config.peers[0].public_key;
        const clientIPv4 = regData.config.interface.addresses.v4.replace('/32', '');
        const clientIPv6 = regData.config.interface.addresses.v6.replace('/128', '');
        const clientID = regData.config.client_id || ""; 

        // 3. 【3x-ui 核心邏輯三】：把 client_id 轉化為 3 位元組的 reserved 陣列
        let reserved = "[0,0,0]";
        if (clientID) {
            try {
                const parsedId = Buffer.from(clientID, 'base64').toString('binary');
                if (parsedId.length >= 3) {
                    reserved = "[" + [parsedId.charCodeAt(0), parsedId.charCodeAt(1), parsedId.charCodeAt(2)].join(",") + "]";
                }
            } catch(e){}
        }

        // 4. 打包成手機 Stash 認得的代理格式
        const stashYaml = `# =========================================================
# ⚙️ [3X-UI WARP FUNCTION EXTRACT]
# Private Key: ${realPrivateKey}
# Peer Public Key: ${peerPubKey}
# Generated Reserved: ${reserved}
# =========================================================

proxies:
  - name: "🚀 CF-WARP-Vercel"
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

        // 告訴 Vercel 輸出純文字，不要下載
        response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        response.status(200).send(stashYaml);

    } catch (error) {
        response.status(500).send(`核心出錯: ${error.message}`);
    }
}
