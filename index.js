const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');

let prefix = '.';
const ownerNumber = '8801344127041'; // তোর নম্বর
const botName = '𝐉𝐈𝐒𝐀𝐍 𝐗 𝐁𝐎𝐓';

const settings = {
    antisticker: {}, 
    antilink: {},    
    welcome: {},
    goodbye: {}
};

const welcomeMsgs = {};
const goodbyeMsgs = {};

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
        }, 5000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`\n✅ 👑 ${botName} সফলভাবে কানেক্ট হয়েছে!`);
            try {
                // বট কানেক্ট হওয়ার সাথে সাথে ওনারের ইনবক্সে মেসেজ চলে যাবে
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

    // মেসেজ হ্যান্ডলার (সব কমান্ড এখানে কাজ করবে)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;
        
        const jid = m.key.remoteJid;
        const body = m.message.conversation || m.message.extendedTextMessage?.text || '';

        if (body.startsWith(prefix)) {
            const args = body.slice(prefix.length).trim().split(' ');
            const command = args[0].toLowerCase();

            // .menu বা অন্য যেকোনো কমান্ড দিলে পুরো মেনু চলে আসবে
            if (['menu', 'help', 'allmenu', 'list', 'commands'].includes(command)) {
                const menuText = `╭━━━〔 👑 𝐉𝐈𝐒𝐀𝐍 𝐎𝐖𝐍𝐄𝐑 〕━━━╮\n\n` +
                                 `👑 𝐎𝐖𝐍𝐄𝐑 : 𝐉𝐈𝐒𝐀𝐍\n` +
                                 `📱 𝐍𝐔𝐌𝐁𝐄𝐑 : 𝟎𝟏𝟔𝟎𝟏𝟑𝟒𝟖𝟓𝟕𝟎\n` +
                                 `🤖 𝐁𝐎𝐓 : 𝐉𝐈𝐒𝐀𝐍 𝐗 𝐁𝐎𝐓\n` +
                                 `⚡ 𝐏𝐑𝐄𝐅𝐈𝐗 : ${prefix}\n` +
                                 `🌐 𝐒𝐓𝐀𝐓𝐔𝐒 : 𝐎𝐍𝐋𝐈𝐍𝐄\n` +
                                 `💎 𝐕𝐄𝐑𝐒𝐈𝐎𝐍 : 𝟐.𝟎.𝟎\n\n` +
                                 `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 ⚡ 𝐁𝐀𝐒𝐈𝐂 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .menu\n➤ .help\n➤ .allmenu\n➤ .list\n➤ .commands\n➤ .ping\n➤ .alive\n➤ .runtime\n➤ .uptime\n➤ .speed\n➤ .status\n➤ .info\n➤ .botinfo\n➤ .owner\n➤ .creator\n➤ .version\n➤ .prefix\n➤ .support\n➤ .repo\n➤ .script\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 👑 𝐎𝐖𝐍𝐄𝐑 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .broadcast\n➤ .bc\n➤ .restart\n➤ .shutdown\n➤ .block\n➤ .unblock\n➤ .ban\n➤ .unban\n➤ .join\n➤ .leave\n➤ .setprefix\n➤ .setname\n➤ .setbio\n➤ .setpp\n➤ .setstatus\n➤ .setowner\n➤ .setmenu\n➤ .update\n➤ .backup\n➤ .restore\n➤ .clearsession\n➤ .reconnect\n➤ .autostatus\n➤ .autoread\n➤ .autoreact\n➤ .anticall\n➤ .maintenance\n➤ .restartbot\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 🛡️ 𝐆𝐑𝐎𝐔𝐏 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .kick\n➤ .add\n➤ .promote\n➤ .demote\n➤ .kickall\n➤ .tagall\n➤ .hidetag\n➤ .totag\n➤ .tagadmins\n➤ .tagmembers\n➤ .groupinfo\n➤ .grouplink\n➤ .link\n➤ .revoke\n➤ .resetlink\n➤ .groupname\n➤ .setgname\n➤ .setgdesc\n➤ .setgpp\n➤ .open\n➤ .close\n➤ .lock\n➤ .unlock\n➤ .mute\n➤ .unmute\n➤ .admins\n➤ .members\n➤ .getmembers\n➤ .invite\n➤ .accept\n➤ .reject\n➤ .leavegroup\n➤ .delete\n➤ .del\n➤ .warn\n➤ .warnings\n➤ .resetwarn\n➤ .poll\n➤ .vote\n➤ .endpoll\n➤ .welcome\n➤ .goodbye\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 ⚠️ 𝐀𝐍𝐓𝐈-𝐀𝐁𝐔𝐒𝐄 〕━━━╮\n` +
                                 `➤ .antilink\n➤ .antispam\n➤ .antibadword\n➤ .antitag\n➤ .antibot\n➤ .antiflood\n➤ .antidelete\n➤ .antiedit\n➤ .antivirus\n➤ .antiraid\n➤ .antinsfw\n➤ .antisticker\n➤ .antimedia\n➤ .antipromote\n➤ .antidemote\n➤ .antigroupmention\n➤ .antichannel\n➤ .antifake\n➤ .antiscam\n➤ .antirepeat\n➤ .antireply\n➤ .antiviewonce\n➤ .antiporn\n➤ .antiinvite\n➤ .antiforward\n➤ .antibroadcast\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 🎨 𝐒𝐓𝐈𝐂𝐊𝐄𝐑 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .sticker\n➤ .s\n➤ .take\n➤ .steal\n➤ .toimg\n➤ .tomp4\n➤ .togif\n➤ .ttp\n➤ .attp\n➤ .brat\n➤ .bratvideo\n➤ .circle\n➤ .crop\n➤ .resize\n➤ .remini\n➤ .enhance\n➤ .blur\n➤ .sharpen\n➤ .grayscale\n➤ .invert\n➤ .flip\n➤ .mirror\n➤ .rotate\n➤ .removebg\n➤ .stickerinfo\n➤ .emojimix\n➤ .extract\n➤ .caption\n➤ .watermark\n➤ .memesticker\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 📥 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .play\n➤ .song\n➤ .video\n➤ .ytmp3\n➤ .ytmp4\n➤ .youtube\n➤ .ytsearch\n➤ .tiktok\n➤ .tt\n➤ .ttmp3\n➤ .ttmp4\n➤ .facebook\n➤ .fb\n➤ .fbvideo\n➤ .instagram\n➤ .ig\n➤ .igstory\n➤ .igreel\n➤ .twitter\n➤ .x\n➤ .xvideo\n➤ .pinterest\n➤ .pin\n➤ .pinsearch\n➤ .threads\n➤ .reddit\n➤ .redditvideo\n➤ .mediafire\n➤ .gdrive\n➤ .mega\n➤ .apk\n➤ .spotify\n➤ .soundcloud\n➤ .terabox\n➤ .capcut\n➤ .likee\n➤ .snapchat\n➤ .vimeo\n➤ .dailymotion\n➤ .lyrics\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 🔍 𝐒𝐄𝐀𝐑𝐂𝐇 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .google\n➤ .search\n➤ .web\n➤ .wikipedia\n➤ .wiki\n➤ .image\n➤ .img\n➤ .wallpaper\n➤ .gif\n➤ .giphy\n➤ .news\n➤ .weather\n➤ .forecast\n➤ .movie\n➤ .imdb\n➤ .anime\n➤ .manga\n➤ .character\n➤ .github\n➤ .npm\n➤ .package\n➤ .dictionary\n➤ .define\n➤ .synonym\n➤ .antonym\n➤ .translate\n➤ .country\n➤ .timezone\n➤ .currency\n➤ .exchange\n➤ .football\n➤ .cricket\n➤ .sports\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 🎮 𝐅𝐔𝐍 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .joke\n➤ .meme\n➤ .quote\n➤ .fact\n➤ .truth\n➤ .dare\n➤ .ship\n➤ .love\n➤ .flirt\n➤ .pickup\n➤ .compliment\n➤ .roast\n➤ .insult\n➤ .8ball\n➤ .coinflip\n➤ .dice\n➤ .roll\n➤ .rps\n➤ .guess\n➤ .quiz\n➤ .trivia\n➤ .mathquiz\n➤ .riddle\n➤ .answer\n➤ .rate\n➤ .character\n➤ .personality\n➤ .simp\n➤ .stupid\n➤ .smart\n➤ .handsome\n➤ .beautiful\n➤ .gayrate\n➤ .coolrate\n➤ .heart\n➤ .couple\n➤ .couples\n➤ .compatibility\n➤ .reaction\n➤ .pat\n➤ .hug\n➤ .kiss\n➤ .slap\n➤ .punch\n➤ .kill\n➤ .bite\n➤ .cuddle\n➤ .highfive\n➤ .wave\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 🎵 𝐌𝐔𝐒𝐈𝐂 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .song\n➤ .play\n➤ .lyrics\n➤ .shazam\n➤ .bass\n➤ .nightcore\n➤ .slow\n➤ .fast\n➤ .reverse\n➤ .volume\n➤ .audio\n➤ .tomp3\n➤ .mp3\n➤ .mp4\n➤ .sound\n➤ .radio\n➤ .lofi\n➤ .remix\n➤ .instrumental\n➤ .karaoke\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 🖼️ 𝐈𝐌𝐀𝐆𝐄 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .image\n➤ .sticker\n➤ .toimg\n➤ .remini\n➤ .enhance\n➤ .upscale\n➤ .removebg\n➤ .blur\n➤ .pixelate\n➤ .greyscale\n➤ .wanted\n➤ .jail\n➤ .passed\n➤ .triggered\n➤ .wasted\n➤ .beautiful\n➤ .circle\n➤ .heart\n➤ .horny\n➤ .comrade\n➤ .communism\n➤ .delete\n➤ .rip\n➤ .facepalm\n➤ .pet\n➤ .tweet\n➤ .tweetfake\n➤ .youtubeplay\n➤ .spotifycover\n➤ .phlogo\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 📱 𝐔𝐒𝐄𝐑 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .profile\n➤ .id\n➤ .me\n➤ .myinfo\n➤ .userinfo\n➤ .avatar\n➤ .getpp\n➤ .setpp\n➤ .setname\n➤ .setbio\n➤ .setstatus\n➤ .afk\n➤ .unafk\n➤ .rank\n➤ .level\n➤ .xp\n➤ .leaderboard\n➤ .top\n➤ .daily\n➤ .weekly\n➤ .monthly\n➤ .claim\n➤ .inventory\n➤ .badges\n➤ .achievements\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 🧰 𝐓𝐎𝐎𝐋𝐒 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .qr\n➤ .readqr\n➤ .shorturl\n➤ .tinyurl\n➤ .calc\n➤ .calculate\n➤ .count\n➤ .length\n➤ .reverse\n➤ .base64\n➤ .encode\n➤ .decode\n➤ .binary\n➤ .hash\n➤ .md5\n➤ .sha256\n➤ .password\n➤ .random\n➤ .uuid\n➤ .timestamp\n➤ .tohex\n➤ .tobinary\n➤ .temperature\n➤ .speedtest\n➤ .ping\n➤ .uptime\n➤ .runtime\n➤ .shorten\n➤ .readmore\n➤ .textmaker\n➤ .fancy\n➤ .font\n➤ .fontlist\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 📂 𝐅𝐈𝐋𝐄 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .get\n➤ .fetch\n➤ .upload\n➤ .url\n➤ .tourl\n➤ .tofile\n➤ .mediafire\n➤ .zip\n➤ .unzip\n➤ .compress\n➤ .extract\n➤ .pdf\n➤ .topdf\n➤ .docx\n➤ .txt\n➤ .json\n➤ .xml\n➤ .csv\n➤ .readfile\n➤ .filesize\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 💌 𝐌𝐄𝐒𝐒𝐀𝐆𝐄 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .forward\n➤ .quote\n➤ .quoted\n➤ .delete\n➤ .edit\n➤ .pin\n➤ .unpin\n➤ .react\n➤ .unreact\n➤ .save\n➤ .read\n➤ .unread\n➤ .send\n➤ .sendfile\n➤ .sendimage\n➤ .sendvideo\n➤ .sendaudio\n➤ .sendsticker\n➤ .text\n➤ .poll\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 ⚙️ 𝐁𝐎𝐓 𝐒𝐄𝐓𝐓𝐈𝐍𝐆𝐒 〕━━━╮\n` +
                                 `➤ .autoread\n➤ .autotyping\n➤ .autorecording\n➤ .autoreact\n➤ .autostatus\n➤ .statusview\n➤ .statuslike\n➤ .antidelete\n➤ .antiedit\n➤ .anticall\n➤ .readreceipt\n➤ .typing\n➤ .presence\n➤ .public\n➤ .private\n➤ .self\n➤ .mode\n➤ .setprefix\n➤ .settimezone\n➤ .setlanguage\n➤ .setmenu\n➤ .setfooter\n➤ .setowner\n➤ .setnumber\n➤ .setthumbnail\n➤ .setwelcome\n➤ .setgoodbye\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 📊 𝐒𝐘𝐒𝐓𝐄𝐌 𝐌𝐄𝐍𝐔 〕━━━╮\n` +
                                 `➤ .system\n➤ .server\n➤ .stats\n➤ .botstats\n➤ .memory\n➤ .cpu\n➤ .ram\n➤ .disk\n➤ .uptime\n➤ .runtime\n➤ .ping\n➤ .speed\n➤ .latency\n➤ .database\n➤ .dbstatus\n➤ .connection\n➤ .session\n➤ .logs\n➤ .errors\n➤ .health\n➤ .check\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                 `╭━━━〔 💖 𝐂𝐑𝐄𝐃𝐈𝐓𝐒 〕━━━╮\n` +
                                 `👑 𝐎𝐖𝐍𝐄𝐑 : 𝐉𝐈𝐒𝐀𝐍\n` +
                                 `⚡ 𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 : 𝐉𝐈𝐒𝐀𝐍 𝐗 𝐁𝐎𝐓\n` +
                                 `🔥 𝐁𝐎𝐓 𝐍𝐀𝐌𝐄 : 𝐉𝐈𝐒𝐀𝐍 𝐗 𝐁𝐎𝐓\n` +
                                 `💎 𝐓𝐇𝐀𝐍𝐊𝐒 𝐅𝐎𝐑 𝐔𝐒𝐈𝐍𝐆\n` +
                                 `╰━━━━━━━〔 🔥 𝐉𝐈𝐒𝐀𝐍 〕━━━━━━━╯`;
                
                await sock.sendMessage(jid, { text: menuText }, { quoted: m });
            }

            // সাধারণ ইউটিলিটি কমান্ড
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
