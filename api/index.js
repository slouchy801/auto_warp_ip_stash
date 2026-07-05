const fetch = require('node-fetch');
const crypto = require('crypto');

// 喺 Node.js 本地生成符合 WireGuard 的隨機 Private Key
function genWireGuardPrivateKey() {
    const buf = crypto.randomBytes(32);
    return buf.toString('base64');
}

export default async function handler(request, response) {
    try {
        // Vercel 自動提供訪客的手機 IP 所在地 (例如 "HK")
        const clientCountry = request.headers['x-vercel-ip-country'] || 'HK';
        const clientIP = request.headers['x-vercel-forwarded-for'] || '未知 IP';

        // ==========================================
        // 第一步：真正的「自動向 CF 註冊 WARP 帳戶」
        // 喺 Vercel (AWS) 環境發出，100% 避開 1015！
        // ==========================================
        const regUrl = 'https://api.cloudflareclient.com/v0a/reg';
        const regResponse = await fetch(regUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'okhttp/3.12.1'
            },
            body: JSON.stringify({
                "key": "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=", // 官方公共密鑰
                "install_id": "",
                "fcm_token": ""
            })
        });

        if (!regResponse.ok) {
            throw new Error(`CF 註冊失敗，狀態碼: ${regResponse.status}`);
        }

        const regData = await regResponse.json();
        
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

        // ==========================================
        // 第二步：動態獲取優選 IP
        // ==========================================
        const ipResponse = await fetch('https://api.v2rayse.com/cf-ip');
        const ipData = await ipResponse.json();
        let bestIP = '162.159.192.1'; 

        if (ipData && ipData.info) {
            const matched = ipData.info.filter(item => item.country === clientCountry);
            if (matched.length > 0) {
                bestIP = matched[0].ip;
            }
        }

        // ==========================================
        // 第三步：組合並直出 Stash 格式
        // ==========================================
        const realPrivateKey = genWireGuardPrivateKey();

        const stashYaml = `# ==========================================
# ⚡ WARP Vercel 雲端全自動自產優選配置
# 🌐 當前手機 IP: ${clientIP}
# 📍 手機定位地區: ${clientCountry}
# ==========================================

proxies:
  - name: "🚀 CF-WARP-Vercel優選-${clientCountry}"
    type: wireguard
    server: ${bestIP}
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

        // 設置回傳 Header，讓 Stash 可以直接識別並導入
        response.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        response.setHeader('Content-Disposition', 'inline; filename="warp_stash.yaml"');
        return response.status(200).send(stashYaml);

    } catch (error) {
        return response.status(500).send(`❌ 部署出錯：${error.message}`);
    }
}
