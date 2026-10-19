const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');

let prefix = '.';
const ownerNumber = '8801344127041'; // তোর নম্বর
const botName = '𝐉𝐈𝐒𝐀𝐍 𝐗 𝐁𝐎𝐓';
const menuImageUrl = 'https://img.sanishtech.com/u/0c8e55738a4809dd9541d7a634e6219c.jpg';

// Render-এর জন্য HTTP সার্ভার
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('JISAN X BOT is active and running!\n');
}).listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});

// গ্রুপ সেটিংস সেভ রাখার জন্য
const db = {
    antisticker: {},
    antilink: {},
    antivideo: {}
};

const startTime = Date.now();
function getRuntime() {
    const millis = Date.now() - startTime;
    const seconds = Math.floor((millis / 1000) % 60);
    const minutes = Math.floor((millis / (1000 * 60)) % 60);
    const hours = Math.floor(millis / (1000 * 60 * 60));
    return `${hours}h ${minutes}m ${seconds}s`;
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.macOS('Chrome')
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(ownerNumber);
                console.log(`\n========================================`);
                console.log(`🔥 আপনার পেয়ারিং কোড: ${code}`);
                console.log(`========================================\n`);
            } catch (err) {
                console.log('পেয়ারিং কোড আনতে সমস্যা হয়েছে:', err);
            }
        }, 8000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`\n✅ 👑 ${botName} সফলভাবে কানেক্ট হয়েছে!`);
            try {
                const ownerJid = ownerNumber + '@s.whatsapp.net';
                await sock.sendMessage(ownerJid, { text: `👑 𝐉𝐈𝐒𝐀𝐍 𝐗 𝐁𝐎𝐓 is now online and fully connected! 🚀\n\nType .menu to see all commands.` });
            } catch (e) {
                console.log('ইনবক্সে মেসেজ পাঠাতে সমস্যা হয়েছে:', e);
            }
        } else if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // মেসেজ এবং গ্রুপ সিকিউরিটি হ্যান্ডলার
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;
        
        const jid = m.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        const body = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const sender = m.key.participant || jid;

        let isAdmin = false;
        let isOwner = sender.includes(ownerNumber) || m.key.fromMe;

        if (isGroup) {
            try {
                const groupMetadata = await sock.groupMetadata(jid);
                const participants = groupMetadata.participants || [];
                const senderObj = participants.find(p => p.id === sender);
                isAdmin = senderObj ? (senderObj.admin === 'admin' || senderObj.admin === 'superadmin') : false;
            } catch (e) {}
        }

        // --- অ্যান্টি সিকিউরিটি চেক ---
        if (isGroup && !m.key.fromMe) {
            const messageType = Object.keys(m.message)[0];

            if (db.antisticker[jid] && messageType === 'stickerMessage') {
                try {
                    await sock.sendMessage(jid, { delete: m.key });
                    return;
                } catch (e) {}
            }

            if (db.antivideo[jid] && messageType === 'videoMessage') {
                try {
                    await sock.sendMessage(jid, { delete: m.key });
                    return;
                } catch (e) {}
            }

            if (db.antilink[jid] && (body.includes('http://') || body.includes('https://') || body.includes('chat.whatsapp.com'))) {
                try {
                    await sock.sendMessage(jid, { delete: m.key });
                    await sock.sendMessage(jid, { text: `⚠️ @${sender.split('@')[0]} গ্রুপে লিংক শেয়ার করা নিষেধ!`, mentions: [sender] });
                    return;
                } catch (e) {}
            }
        }

        // --- কমান্ড হ্যান্ডলার ---
        if (body.startsWith(prefix)) {
            const args = body.slice(prefix.length).trim().split(' ');
            const command = args[0].toLowerCase();
            const action = args[1] ? args[1].toLowerCase() : '';

            if (command === 'antisticker') {
                if (!isGroup) return await sock.sendMessage(jid, { text: '❌ এই কমান্ড শুধু গ্রুপে ব্যবহার করা যাবে!' }, { quoted: m });
                if (!isAdmin && !isOwner) return await sock.sendMessage(jid, { text: '❌ দুঃখিত! এই কমান্ডটি শুধু গ্রুপের **এডমিন** বা **বট ওনার** ব্যবহার করতে পারবেন।' }, { quoted: m });
                
                if (action === 'on') {
                    db.antisticker[jid] = true;
                    await sock.sendMessage(jid, {
                        text: `✅ AntiSticker ON`,
                        contextInfo: {
                            externalAdReply: {
                                title: `+880 1344-127041 • Status`,
                                body: `Contact: 𝐉𝐈𝐒𝐀𝐍`,
                                thumbnailUrl: menuImageUrl,
                                mediaType: 1,
                                renderLargerThumbnail: false
                            }
                        }
                    }, { quoted: m });
                } else if (action === 'off') {
                    db.antisticker[jid] = false;
                    await sock.sendMessage(jid, { text: `❌ AntiSticker OFF` }, { quoted: m });
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ ব্যবহার নিয়ম:\n.antisticker on\n.antisticker off` }, { quoted: m });
                }
            }

            if (command === 'antilink') {
                if (!isGroup) return await sock.sendMessage(jid, { text: '❌ এই কমান্ড শুধু গ্রুপে ব্যবহার করা যাবে!' }, { quoted: m });
                if (!isAdmin && !isOwner) return await sock.sendMessage(jid, { text: '❌ দুঃখিত! এই কমান্ডটি শুধু গ্রুপের **এডমিন** বা **বট ওনার** ব্যবহার করতে পারবেন।' }, { quoted: m });
                
                if (action === 'on') {
                    db.antilink[jid] = true;
                    await sock.sendMessage(jid, {
                        text: `✅ AntiLink ON`,
                        contextInfo: {
                            externalAdReply: {
                                title: `+880 1344-127041 • Status`,
                                body: `Contact: 𝐉𝐈𝐒𝐀𝐍`,
                                thumbnailUrl: menuImageUrl,
                                mediaType: 1,
                                renderLargerThumbnail: false
                            }
                        }
                    }, { quoted: m });
                } else if (action === 'off') {
                    db.antilink[jid] = false;
                    await sock.sendMessage(jid, { text: `❌ AntiLink OFF` }, { quoted: m });
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ ব্যবহার নিয়ম:\n.antilink on\n.antilink off` }, { quoted: m });
                }
            }

            if (command === 'antivideo') {
                if (!isGroup) return await sock.sendMessage(jid, { text: '❌ এই কমান্ড শুধু গ্রুপে ব্যবহার করা যাবে!' }, { quoted: m });
                if (!isAdmin && !isOwner) return await sock.sendMessage(jid, { text: '❌ দুঃখিত! এই কমান্ডটি শুধু গ্রুপের **এডমিন** বা **বট ওনার** ব্যবহার করতে পারবেন।' }, { quoted: m });
                
                if (action === 'on') {
                    db.antivideo[jid] = true;
                    await sock.sendMessage(jid, {
                        text: `✅ AntiVideo ON`,
                        contextInfo: {
                            externalAdReply: {
                                title: `+880 1344-127041 • Status`,
                                body: `Contact: 𝐉𝐈𝐒𝐀𝐍`,
                                thumbnailUrl: menuImageUrl,
                                mediaType: 1,
                                renderLargerThumbnail: false
                            }
                        }
                    }, { quoted: m });
                } else if (action === 'off') {
                    db.antivideo[jid] = false;
                    await sock.sendMessage(jid, { text: `❌ AntiVideo OFF` }, { quoted: m });
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ ব্যবহার নিয়ম:\n.antivideo on\n.antivideo off` }, { quoted: m });
                }
            }

            if (['menu', 'help', 'allmenu', 'list', 'commands'].includes(command)) {
                const menuText = `╭━━━〔 👑 𝐉𝐈𝐒𝐀𝐍 𝐎𝐖𝐍𝐄𝐑 〕━━━╮\n\n` +
                                 `👑 𝐎𝐖𝐍𝐄𝐑 : 𝐉𝐈𝐒𝐀𝐍\n` +
                                 `📱 𝐍𝐔𝐌𝐁𝐄𝐑 : 𝟖𝟖𝟎𝟏٣𝟒𝟒𝟏𝟐𝟕𝟎𝟒𝟏\n` +
                                 `🤖 𝐁𝐎𝐓 : 𝐉𝐈𝐒𝐀𝐍 𝐗 𝐁𝐎𝐓\n` +
                                 `⚡ 𝐏𝐑𝐄𝐅𝐈𝐗 : ${prefix}\n` +
                                 `🌐 𝐒𝐓𝐀𝐓𝐔𝐒 : 𝐎𝐍𝐋𝐈𝐍𝐄\n` +
                                 `💎 𝐕𝐄𝐑𝐒𝐈𝐎𝐍 : 𝟐.𝟎.𝟎\n\n` +
                                 `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 🛡️ 𝐒𝐄𝐂𝐔𝐑𝐈𝐓𝐘 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒 〕━━━╮\n` +
                                 `➤ .antisticker on / off\n` +
                                 `➤ .antilink on / off\n` +
                                 `➤ .antivideo on / off\n` +
                                 `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 ⚡ 𝐁𝐀𝐒𝐈𝐂 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .menu\n➤ .ping\n➤ .alive\n➤ .runtime\n➤ .speed\n➤ .owner\n` +
                                 `╰━━━━━━━━━━━━━━━━━━━━╯`;
                
                await sock.sendMessage(jid, {
                    image: { url: menuImageUrl },
                    caption: menuText
                }, { quoted: m });
            }

            if (['ping', 'speed'].includes(command)) {
                await sock.sendMessage(jid, { text: `🏓 Pong! Speed is blazing fast.\n⚡ Runtime: ${getRuntime()}` }, { quoted: m });
            }
            if (['alive', 'status'].includes(command)) {
                await sock.sendMessage(jid, { text: `✨ 👑 ${botName} is online and running successfully! 🟢` }, { quoted: m });
            }
            if (['runtime', 'uptime'].includes(command)) {
                await sock.sendMessage(jid, { text: `⏱️ Uptime: ${getRuntime()}` }, { quoted: m });
            }
            if (['owner', 'creator'].includes(command)) {
                await sock.sendMessage(jid, { text: `👑 Owner: 𝐉𝐈𝐒𝐀𝐍\n📱 Number: wa.me/${ownerNumber}` }, { quoted: m });
            }
        }
    });
}

startBot();
