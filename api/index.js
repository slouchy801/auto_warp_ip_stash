const crypto = require('crypto');
const https = require('https');

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
                else reject(new Error(`CF 拒絕: ${res.statusCode} - ${body}`));
            });
        });
        req.on('error', (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

export default async function handler(request, response) {
    try {
        // 1. 本地生成一個完全純淨、獨一無二嘅 WireGuard 私鑰與對應公鑰
        // 💡 邊度教我咁做？3x-ui 後續社群修復 401 時發現：不使用官方固定 Key，改用動態生成的密鑰對去註冊，即可繞過 401 封鎖。
        const privateKeyBuffer = crypto.randomBytes(32);
        const realPrivateKey = privateKeyBuffer.toString('base64');
        
        // 隨機生成一個符合格式的公鑰用於初次註冊握手（避免跟幾萬人共用舊公鑰被 401）
        const dummyPublicKey = crypto.randomBytes(32).toString('base64');

        // 2. 打去 CF 官方接口，改送動態 Key
        const regData = await cfPost('https://api.cloudflareclient.com/v0a/reg', {
            "key": dummyPublicKey,
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

        const stashYaml = `# =========================================================
# ⚙️ [3X-UI WARP FUNCTION - BYPASS 401 FIXED]
# Private Key: ${realPrivateKey}
# Peer Public Key: ${peerPubKey}
# Generated Reserved: ${reserved}
# =========================================================

proxies:
  - name: "🚀 CF-WARP-Bypass401"
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

        response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        response.status(200).send(stashYaml);

    } catch (error) {
        response.status(500).send(`核心出錯: ${error.message}`);
    }
}
