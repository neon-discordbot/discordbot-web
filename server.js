require('dotenv').config();
const fs = require('fs'), express = require('express'), session = require('express-session'), bcrypt = require('bcryptjs');
const { Client, GatewayIntentBits: G, Partials, Events, EmbedBuilder } = require('discord.js');
const crypto = require('crypto');
const SITE = process.env.SITE_TITLE || '管理システム端末';
const { DISCORD_TOKEN, GUILD_ID, SESSION_SECRET, OWNER_USER = 'owner', OWNER_PASS, PORT = 3000 } = process.env;
const GIDS = (process.env.GUILD_IDS || GUILD_ID || '').split(',').map(x => x.trim()).filter(Boolean);
if (!GIDS.length) { console.error('GUILD_IDS(サーバーID。複数ならカンマ区切り)を設定してください'); process.exit(1); }
if (!SESSION_SECRET || !OWNER_PASS) { console.error('SESSION_SECRET と OWNER_PASS を設定してください'); process.exit(1); }

// ---- 保存(JSONファイル) ----
const FILE = 'data/db.json';
fs.mkdirSync('data', { recursive: true });
const db = Object.assign({ users: [], msgs: [], dms: [], logs: [], cases: [], reqs: [], dmlog: [], emerg: {}, memo: {}, sched: [], stats: {}, watch: {}, cfg: {}, alerts: [], vclog: [], snaps: [], devreq: [], seq: 1 },
  fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {});
const save = () => fs.writeFileSync(FILE, JSON.stringify(db));
const nid = () => db.seq++;
const now = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 16);
if (!db.users.length) db.users.push({ name: OWNER_USER, hash: bcrypt.hashSync(OWNER_PASS, 10), role: 'owner' });
db.users.forEach(u => { u.id ??= nid(); u.guilds ??= [...GIDS]; });
[...db.cases, ...db.reqs, ...db.msgs].forEach(x => { x.gid ??= GIDS[0]; });
db.dms.forEach(d => { d.gids ??= [GIDS[0]]; }); save();

// ---- 権限(ここを書き換えれば調整できます) ----
// direct: BAN/KICK/60分超のタイムアウトを承認なしで実行 / approve: 申請の承認 / logsAll: 全員の操作ログ / accounts: アカウント管理 / delMsg: 管理者間通信のメッセージ削除
const ROLES = { owner: '最高管理者', admin: '管理者', junior: '新任管理者' };
const CAN = { owner: ['direct', 'approve', 'logsAll', 'accounts', 'delMsg', 'release'], admin: ['direct', 'approve', 'logsAll'], junior: [] };
const can = (u, p) => CAN[u.role].includes(p);
const allowed = u => u.role === 'owner' ? GIDS : GIDS.filter(g => (u.guilds || []).includes(g));
const gname = id => bot.guilds.cache.get(id)?.name || id;
const visDm = (u, d) => d.gids.includes(u.gid) || (!d.gids.length && u.role === 'owner');
const TYPES = { ban: 'BAN', kick: 'KICK', timeout: 'タイムアウト', warn: '警告', unban: 'BAN解除', untimeout: 'タイムアウト解除' };
const DUR = [5, 10, 30, 60, 180, 360, 720, 1440, 4320, 10080, 40320];
const fmtMin = m => m % 1440 === 0 ? `${m / 1440}日` : m % 60 === 0 ? `${m / 60}時間` : `${m}分`;
const isId = s => /^\d{15,22}$/.test(s || '');
const pun = (t, m) => TYPES[t] + (t === 'timeout' ? `(${fmtMin(m)})` : '');

// ---- Discord ----
const bot = new Client({ intents: [G.Guilds, G.GuildMembers, G.DirectMessages, G.GuildVoiceStates, G.GuildMessages, G.GuildInvites], partials: [Partials.Channel, Partials.Message] });
bot.on(Events.MessageCreate, async m => {
  if (m.guild) { if (!m.author.bot && GIDS.includes(m.guild.id)) countMsg(m); return; }
  if (m.author.bot) return;
  const gids = [];
  for (const g of GIDS) if (await bot.guilds.fetch(g).then(x => x.members.fetch(m.author.id)).catch(() => null)) gids.push(g);
  db.dms.unshift({ id: nid(), t: now(), uid: m.author.id, name: m.author.tag, text: m.content, gids, ts: Date.now() });
  db.dms = db.dms.slice(0, 300); save();
});
bot.login(DISCORD_TOKEN);

const log = (who, op, target = '', detail = '', gid) => {
  db.logs.unshift({ t: now(), who, op, target, detail: String(detail).slice(0, 200), gid });
  db.logs = db.logs.slice(0, 1000); save();
};
async function exec(by, type, uid, reason, min, notify, gid) {
  if (!GIDS.includes(gid)) throw new Error('サーバーが選択されていません');
  if (!bot.isReady()) throw new Error('BOT_OFFLINE');
  if (notify && reason) await bot.users.send(uid, `【${gname(gid)} / ${TYPES[type]}】${reason}`).catch(() => {});
  if (type !== 'warn') {
    const g = await bot.guilds.fetch(gid);
    if (type === 'ban') await g.members.ban(uid, { reason });
    else if (type === 'unban') await g.bans.remove(uid, reason);
    else {
      const m = await g.members.fetch(uid);
      if (type === 'kick') await m.kick(reason); else await m.timeout(type === 'untimeout' ? null : min * 60000, reason);
    }
  }
  db.cases.unshift({ id: nid(), t: now(), type, uid, reason, min, by, gid }); save();
  log(by, pun(type, min), uid, reason, gid);
  if (type === 'ban') freezeCheck(by, 'ban', 3, '1分間に3人以上をBANしました', gid);
  notifyOwners(by, type, uid, reason, min, gid);
}

// ---- 画面部品 ----
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEYS = ['メニュー', '戻る', '保存', '更新', '開始', '終了', '承認', '却下', '照会', '発信', '予約', '保持', '解放'];
const ACT = { メニュー: "location='/'", 戻る: 'history.back()', 更新: 'location.reload()', 終了: "location='/logout'", 照会: 'doLookup()', 発信: 'doSend()', 解放: 'doReset()', 予約: 'doSched()' };
const BASE = ['メニュー', '戻る', '更新', '終了'], FORM = [...BASE, '照会', '発信', '解放'];
const status = u => `<div class=st>係員 <span class=v>${esc(u.name)}</span> 権限区分 <span class=v>${ROLES[u.role]}</span> サーバー <form method=post action=/server><select name=gid onchange="this.form.submit()">${allowed(u).map(g => `<option value="${g}"${g === u.gid ? ' selected' : ''}>${esc(gname(g))}`).join('')}</select></form> 日時 <span class=v id=cl>${now()}</span> BOT <span class=v>${bot.isReady() ? `稼働中 ${bot.ws.ping}ms` : '停止中'}</span> 未読 <span class=v>${db.msgs.filter(m => m.to === u.name && !m.read && m.gid === u.gid).length} 件</span> <a class=b href=/inbox>管理者間通信</a> <a class=b href=/lock>端末ロック</a> <a class=b href=# onclick="dk();return false">ダークモード</a> <small id=ol>${online(u)}</small></div><div id=sa class="note alert" style="display:${staleItems(u).length ? 'block' : 'none'}">未対応のまま2時間以上放置されている案件が${staleItems(u).length}件あります</div><div id=sb class="note alert" style="display:${unack(u) ? 'block' : 'none'}"><a href=/alerts>警告アラートが<span id=sbn>${unack(u)}</span>件あります(確認する)</a></div>`;
const page = (u, title, body, on = BASE, act = {}) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(SITE)}</title><style>
body{margin:0;background:#d9d9d9;font:14px sans-serif;color:#111}
h1{margin:0;background:linear-gradient(#2a45b5,#1a2f9a);color:#fff;text-align:center;font-weight:400;font-size:15px;letter-spacing:.2em;padding:13px 8px}
.w{max-width:1000px;margin:0 auto;padding:10px}.tb{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px}
button,a.b{font:inherit;background:#e4e4e4;border:2px outset #fff;padding:9px 16px;color:#111;text-decoration:none;cursor:pointer;display:inline-block}
button:disabled{color:#999;background:#d2d2d2;cursor:default}button.on,a.cur{font-weight:700}button,a.b,.tile{-webkit-tap-highlight-color:transparent;user-select:none}button:not(:disabled):active,a.b:active,.tile:not(.off):active{border-style:inset;background:#c4c4c4;transform:translate(1px,1px)}
.st{margin:8px 0;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.st select{width:auto;display:inline-block;margin:0}.st form{display:inline;margin:0}.v{display:inline-block;background:#f4f4f4;border:2px inset #fff;padding:7px 10px;white-space:nowrap}
input,select,textarea{font:inherit;padding:7px;box-sizing:border-box;background:#f4f4f4;border:2px inset #fff}
form input:not([type=checkbox]),form select,form textarea{width:100%;max-width:600px;display:block;margin:4px 0 12px}
fieldset{border:1px solid #999;padding:10px;margin:0 0 12px}
table{width:100%;border-collapse:collapse;background:#f4f4f4}td,th{border:1px solid #999;padding:7px;text-align:left;vertical-align:top;white-space:pre-wrap}th{background:#c8c8c8}
.note{background:#eee;border:1px solid #999;padding:9px;margin:6px 0 12px}.alert{background:#fdd;border-color:#c00;color:#900;font-weight:700;animation:bl 1s step-start infinite}@keyframes bl{50%{opacity:.35}}.busy{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:99;align-items:center;justify-content:center;flex-direction:column;color:#fff;font-size:18px}.busy.on{display:flex}.sp{width:40px;height:40px;border:5px solid #fff;border-top-color:transparent;border-radius:50%;animation:rot 1s linear infinite;margin-bottom:12px}@keyframes rot{to{transform:rotate(360deg)}}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}
.tile{display:block;background:#e4e4e4;border:2px outset #fff;padding:12px 8px;text-align:center;color:#111;text-decoration:none;min-height:48px}
.tile small{display:block;margin-top:6px;background:#eee;border:1px solid #999;padding:2px;font-size:12px}.tile.off{background:#d0d0d0;border:2px solid #ccc}
button,a.b,.tile{-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none}button:active:not(:disabled),a.b:active{border-style:inset;background:#c4c4c4;padding:11px 16px 7px}.tile:not(.off):active{border-style:inset;background:#c4c4c4;padding:14px 8px 10px}a.cur{border-style:inset;background:#cfcfcf}button:disabled[data-t]{border-style:inset;color:#555}html.dk{filter:invert(1) hue-rotate(180deg)}</style><script>try{if(localStorage.getItem('dk')==='1')document.documentElement.classList.add('dk')}catch(e){}</script><h1>${esc(SITE)} ${esc(title)}</h1><div class=w>
<div class=tb>${KEYS.map(k => on.includes(k) ? `<button type=button class=on onclick="${act[k] || ACT[k]}">${k}</button>` : `<button disabled>${k}</button>`).join('')}</div>
${u ? status(u) + '<div id=nb class=note style="display:none"><a href=/inbox>管理者間通信に新着メッセージがあります</a></div>' : ''}${body}</div><div id=busy class=busy><div class=sp></div>処理中…しばらくお待ちください</div><script>
function F(){return document.querySelector('form.main')}
function doLookup(){var f=F(),i=f&&f.elements.uid;if(f&&f.method=='get')f.submit();else location='/history'+(i&&i.value?'?uid='+encodeURIComponent(i.value):'')}
function doSend(){var f=F();if(f){f.requestSubmit?f.requestSubmit():f.submit()}}
function doReset(){var f=F();if(f)f.reset()}
document.addEventListener('touchstart',function(){},true);
var BZ=false;function busy(on){BZ=on;var b=document.getElementById('busy');if(b)b.className='busy'+(on?' on':'')}
document.addEventListener('submit',function(e){if(e.defaultPrevented)return;if(BZ){e.preventDefault();return}busy(true);setTimeout(function(){busy(false)},30000)},false);
window.addEventListener('pageshow',function(){busy(false)});
setInterval(function(){var c=document.getElementById('cl');if(c)c.textContent=new Date(Date.now()+9*3600e3).toISOString().slice(0,16).replace('T',' ')},10000);
function qd(m){var w=document.querySelector('[name=when]');if(w)w.value=new Date(Date.now()+9*3600e3+m*6e4).toISOString().slice(0,16)}
function qt(h,dd){var w=document.querySelector('[name=when]');if(!w)return;var d=new Date(Date.now()+9*3600e3);d.setUTCDate(d.getUTCDate()+dd);d.setUTCHours(h,0,0,0);if(d.getTime()<Date.now()+9*3600e3)d.setUTCDate(d.getUTCDate()+1);w.value=d.toISOString().slice(0,16)}
document.addEventListener('touchstart',function(){},{passive:true});
document.addEventListener('submit',function(e){if(e.defaultPrevented)return;var b=e.submitter;if(b&&b.tagName==='BUTTON'&&!b.dataset.t){setTimeout(function(){b.dataset.t=b.textContent;b.textContent='処理中…';b.disabled=true},0)}},false);
window.addEventListener('pageshow',function(){document.querySelectorAll('button[data-t]').forEach(function(b){b.disabled=false;b.textContent=b.dataset.t;delete b.dataset.t})});
function doSched(){var f=F();if(!f)return;var w=f.elements.when;if(!w)return;if(!w.value){w.value=new Date(Date.now()+9*3600e3+36e5).toISOString().slice(0,16);if(!confirm('日時が空なので、1時間後('+w.value.replace('T',' ')+')で予約します。よろしいですか?'))return}f.action='/embed/schedule';f.requestSubmit?f.requestSubmit():f.submit()}
function dk(){var d=document.documentElement.classList.toggle('dk');try{localStorage.setItem('dk',d?'1':'0')}catch(e){}}${u ? POLL : ''}</script>`;
const note = t => t ? `<div class=note>${esc(t)}</div>` : '';
const fs_ = (legend, inner) => `<fieldset><legend>${esc(legend)}</legend>${inner}</fieldset>`;
const done = (u, title, t, on) => page(u, title, fs_(title, note(t)), on);
const bad = (res, u, t) => res.status(400).send(done(u, 'エラー', t));
const table = (head, rows) => `<table><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr>${rows.join('')}</table>`;
const tr = cells => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
const empty = t => `<table><tr><td>${t}</td></tr></table>`;

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 8 * 3600e3 } }));
const dupe = new Map();
app.use((req, res, next) => {
  if (req.method !== 'POST' || !req.session || !req.session.uid || /^\/(unlock|login)/.test(req.path)) return next();
  const k = `${req.session.uid}|${req.path}|${JSON.stringify(req.body)}`, t = Date.now(), p = dupe.get(k);
  for (const [kk, v] of dupe) if (t - v > 5000) dupe.delete(kk);
  if (p && t - p < 2500) return res.status(429).send(page(null, 'お待ちください', note('⚠️ 同じ操作を連続して受け付けました。処理中です。数秒おいてから、結果を確認してください。') + '<a class=b href=/>メニューへ</a>', []));
  dupe.set(k, t); next();
});

const auth = perm => (req, res, next) => {
  const u0 = db.users.find(x => x.id === req.session.uid);
  if (!u0) return res.redirect('/login');
  if (u0.frozen) return req.session.destroy(() => res.status(403).send(loginPage('このアカウントは凍結されています。最高管理者に連絡してください')));
  const al = allowed(u0), u = { ...u0, gid: al.includes(req.session.gid) ? req.session.gid : al[0] };
  seen.set(u.id, { ...(seen.get(u.id) || {}), name: u.name, ts: Date.now(), gid: u.gid });
  if (req.session.locked && req.path !== '/unlock') return res.send(lockPage(u));
  if (perm && !can(u, perm)) { log(u.name, '権限なしの操作', '', req.path, u.gid); return res.status(403).send(done(u, '権限なし', 'この操作の権限がありません。')); }
  req.u = u; next();
};

// ---- ログイン(5回失敗で10分ロック) ----
const fails = {};
const loginPage = t => page(null, 'ログイン', fs_('ログイン', `${note(t)}<form method=post><label>アカウント<input name=name required autocomplete=username></label><label>パスワード<input name=pass type=password required autocomplete=current-password></label><button>ログイン</button></form>`), []);
app.get('/login', (req, res) => res.send(loginPage()));
app.post('/login', async (req, res) => {
  let f = fails[req.ip];
  if (!f || Date.now() - f.t > 6e5) f = fails[req.ip] = { n: 0, t: Date.now() };
  if (f.n >= 5) return res.status(429).send(loginPage('試行回数が多すぎます。10分後にやり直してください。'));
  const u = db.users.find(x => x.name === req.body.name);
  if (u && bcrypt.compareSync(req.body.pass || '', u.hash)) {
    delete fails[req.ip];
    if (u.frozen) return res.status(403).send(loginPage('このアカウントは凍結されています。最高管理者に連絡してください'));
    const dv = deviceBlock(req, res, u); if (dv) return res.status(403).send(loginPage(dv));
    if (needMfa(u)) { try { await sendCode(req, u); return res.redirect('/login/code'); } catch (e) { log(u.name, '2段階認証メール送信失敗', '', e.message); return res.status(500).send(loginPage('確認メールを送信できませんでした。最高管理者に連絡してください。')); } }
    return req.session.regenerate(() => { req.session.uid = u.id; log(u.name, 'ログイン'); res.redirect('/'); });
  }
  f.n++; f.t = Date.now(); log(String(req.body.name || '').slice(0, 20), 'ログイン失敗');
  res.status(401).send(loginPage('アカウントまたはパスワードが違います'));
});
app.get('/logout', (req, res) => {
  const u = db.users.find(x => x.id === req.session.uid); if (u) log(u.name, 'ログアウト');
  req.session.destroy(() => res.redirect('/login'));
});

app.post('/server', auth(), (req, res) => { if (allowed(req.u).includes(req.body.gid)) req.session.gid = req.body.gid; res.redirect('/'); });

// ---- メインメニュー ----
app.get('/', auth(), (req, res) => {
  const u = req.u;
  const T = (h, t, s, ok = 1) => ok ? `<a class=tile href="${h}"><b>${t}</b><small>${s}</small></a>` : '<span class="tile off"></span>';
  const Gp = (t, items) => fs_(t, `<div class=g>${items.join('')}</div>`);
  res.send(page(u, 'メインメニュー', memoBox(u) +
    Gp('処分業務(BAN・KICK・タイムアウト)', [T('/act/ban', 'BAN', 'ユーザー追放'), T('/act/kick', 'KICK', 'ユーザー退出'), T('/act/timeout', 'タイムアウト', '発言停止'), T('/act/warn', '警告', '警告記録'), T('/act/unban', 'BAN解除', '追放を解除'), T('/act/untimeout', 'タイムアウト解除', '発言停止を解除')]) +
    Gp('申請・承認', [T('/approve', '申請承認', `未対応 ${db.reqs.filter(r => r.gid === u.gid && r.status === '申請中' && !r.lock).length}件`, can(u, 'approve')), T('/myreqs', '自分の申請', '申請状況'), T('/logs', '操作ログ', '実行履歴'), T('/history', '処分履歴照会', 'アカウント別'), T('/staffstats', '稼働実績', 'スタッフ別集計', can(u, 'logsAll'))]) +
    Gp('通信業務', [T('/dms', 'DM受信', `未対応 ${db.dms.filter(d => visDm(u, d) && (d.st || 'todo') === 'todo').length}件`), T('/dm', 'DM送信', 'ユーザー宛DM'), T('/inbox', '管理者間通信', 'サイト内・メール'), T('/allmsgs', '全メッセージ管理', 'メッセージ削除', can(u, 'delMsg')), T('/summon', '緊急招集', 'Discordでメンション', can(u, 'direct'))]) +
    Gp('サーバー管理', [T('/user', 'ユーザー情報', 'ID・ロール・警告'), T('/vc', 'VC管理', '参加者・切断・ミュート'), T('/invites', '招待リンク', '確認・破棄', can(u, 'direct')), T('/embed', '埋め込み・予約投稿', 'Botから投稿', can(u, 'direct')), T('/emerg', '緊急対応', '封鎖・低速・ゲート', can(u, 'release')), T('/bulkrole', 'ロール一括', '付与・剥奪', can(u, 'direct')), T('/stats', '統計', '参加・発言・ランキング'), T('/watch', '要監視', '怪しいユーザー', can(u, 'direct')), T('/alerts', '警告アラート', `未確認 ${unack(u)}件`), T('/guard', '荒らし対策', '新規アカウント・レイド', can(u, 'direct')), T('/vclog', 'VC履歴', '入退室・切断', true), T('/snap', 'バックアップ', '保存・復元', can(u, 'release'))]) +
    Gp('設定業務', [T('/accounts', 'アカウント管理', '追加・削除', can(u, 'accounts')), T('/password', 'パスワード変更', '自分のパスワード')]), ['更新', '終了']));
});

// ---- 処分(BAN/KICK/タイムアウト/警告) ----
app.get('/act/:type', auth(), (req, res) => {
  const t = req.params.type, u = req.u, direct = can(u, 'direct');
  if (!TYPES[t]) return res.redirect('/');
  if (!u.gid) return res.send(done(u, TYPES[t], '操作できるサーバーが割り当てられていません。'));
  const top = direct || t === 'warn' ? '' : t === 'timeout' ? '新任管理者の操作は、管理者以上の承認が必要です。タイムアウトは60分(1時間)までなら、承認なしで実行できます。' : '新任管理者の操作は、管理者以上の承認が必要です。';
  const uid = '<label>対象のDiscordユーザーID<input name=uid list=ri required pattern="\\d{15,22}" inputmode=numeric></label>' + recentIds(u);
  const rest = t === 'warn' ? '<label>警告の内容(本人にDMで送られます)<textarea name=reason rows=5 required maxlength=200></textarea></label>'
    : (t === 'timeout' ? `<label>時間<select name=min>${DUR.map(m => `<option value=${m}${m === 60 ? ' selected' : ''}>${fmtMin(m)}`).join('')}</select></label>` : '') +
      '<label>理由(任意)<input name=reason maxlength=200></label>' + (t === 'unban' ? '' : '<label><input type=checkbox name=notify value=1> この理由をBOT経由で本人にDMで送る</label>');
  res.send(page(u, TYPES[t], fs_(TYPES[t], `${note('対象サーバー: ' + gname(u.gid))}${note(top)}<form method=post class=main>${uid}${rest}</form>${t === 'warn' ? note('警告は処分履歴に残ります。承認は要りません。') : ''}`), FORM));
});
app.post('/act/:type', auth(), async (req, res) => {
  const t = req.params.type, u = req.u, uid = req.body.uid, reason = String(req.body.reason || '').slice(0, 200);
  const min = t === 'timeout' ? +req.body.min : 0, notify = t === 'warn' || !!req.body.notify;
  if (!TYPES[t] || !u.gid || !isId(uid) || (t === 'warn' && !reason) || (t === 'timeout' && !DUR.includes(min))) return bad(res, u, '入力が正しくありません');
  if (!can(u, 'direct') && (['ban', 'kick', 'unban', 'untimeout'].includes(t) || (t === 'timeout' && min > 60))) {
    db.reqs.unshift({ id: nid(), t: now(), by: u.name, type: t, uid, reason, min, notify, status: '申請中', handler: '', result: '', gid: u.gid, ts: Date.now() }); save();
    log(u.name, `${TYPES[t]}申請`, uid, reason, u.gid); return res.redirect('/myreqs');
  }
  try { await exec(u.name, t, uid, reason, min, notify, u.gid); res.send(done(u, TYPES[t], `${gname(u.gid)}で${pun(t, min)}を実行しました`)); }
  catch (e) { res.status(500).send(done(u, TYPES[t], explain(e))); }
});

// ---- 申請 ----
app.get('/myreqs', auth(), (req, res) => {
  const rows = db.reqs.filter(r => r.by === req.u.name && r.gid === req.u.gid).slice(0, 100).map(r => tr([r.id, pun(r.type, r.min), esc(r.uid), esc(r.status), esc(r.handler || '-'), esc(r.result || '-'), esc(r.t)]));
  res.send(page(req.u, '自分の申請', fs_('自分の申請(申請履歴・申請状況)', rows.length ? table(['番号', '予定処罰', '対象のDiscordアカウントID', '状況', '処理した人', '結果', '申請日時'], rows) : empty('申請はまだありません。'))));
});
app.get('/approve', auth('approve'), (req, res) => {
  const rows = db.reqs.filter(r => r.gid === req.u.gid).slice(0, 100).map(r => tr([r.id, esc(r.by), pun(r.type, r.min), esc(r.uid), esc(r.reason), esc(r.t),
    r.status === '申請中' ? reqBtns(r, req.u) : `${esc(r.status)}(${esc(r.handler)})`]));
  res.send(page(req.u, '申請承認', fs_('申請一覧', rows.length ? table(['番号', '申請者', '予定処罰', '対象ID', '理由', '申請日時', '状況'], rows) : empty('申請はありません。'))));
});
app.post('/approve/:id', auth('approve'), async (req, res) => {
  const r = db.reqs.find(x => x.id === +req.params.id);
  if (!r || r.status !== '申請中' || !allowed(req.u).includes(r.gid)) return res.redirect('/approve');
  const a = req.body.a, mine = r.lock && r.lock.by === req.u.name;
  if (a === 'lock') { if (!r.lock) { r.lock = { by: req.u.name, at: Date.now() }; save(); log(req.u.name, '申請の対応開始', r.uid, `#${r.id}`, r.gid); } return res.redirect('/approve'); }
  if (a === 'unlock') { if (mine || req.u.role === 'owner') { delete r.lock; save(); } return res.redirect('/approve'); }
  if (r.lock && !mine && req.u.role !== 'owner') return bad(res, req.u, `${r.lock.by}が対応中です(ロック中)`);
  delete r.lock;
  r.handler = req.u.name;
  if (req.body.a === 'ok') {
    r.status = '承認済';
    try { await exec(req.u.name, r.type, r.uid, `${r.reason}(申請者:${r.by})`, r.min, r.notify, r.gid); r.result = '実行済'; }
    catch (e) { r.result = explain(e).replace(/^⚠️ /, ''); }
  } else { r.status = '却下'; r.result = '実行されません'; }
  save(); log(req.u.name, `申請${r.status}`, r.uid, `#${r.id}`, r.gid); res.redirect('/approve');
});

// ---- 履歴・ログ ----
app.get('/history', auth(), (req, res) => {
  const q = String(req.query.uid || '').trim();
  const rows = q ? db.cases.filter(c => c.uid === q && c.gid === req.u.gid).map(c => tr([esc(c.t), pun(c.type, c.min), esc(c.reason), esc(c.by)])) : [];
  res.send(page(req.u, '処分履歴照会', fs_('処分履歴の照会', `<form method=get class=main><label>DiscordユーザーID<input name=uid value="${esc(q)}"></label></form>${note('このシステムから行った処分と警告の記録が出ます。Discordで直接行った処分は含まれません。')}`) +
    (q ? fs_(`照会結果(${gname(req.u.gid)})`, rows.length ? table(['日時', '処分', '理由', '担当'], rows) : empty('記録はありません。')) : ''), [...BASE, '照会']));
});
app.get('/logs', auth(), (req, res) => {
  const u = req.u, all = can(u, 'logsAll'), own = u.role === 'owner', who = own ? String(req.query.who || '') : '';
  const src = who ? db.logs.filter(l => l.who === who) : db.logs.filter(l => l.gid ? (l.gid === u.gid && (all || l.who === u.name)) : (l.who === u.name || own));
  const rows = src.slice(0, 300).map(l => tr([esc(l.t), esc(l.who), esc(l.op), esc(l.target), esc(l.detail), l.gid ? esc(gname(l.gid)) : '-']));
  const sel = own ? `<form method=get><label>アカウントで絞り込み(全サーバーの記録)<select name=who onchange="this.form.submit()"><option value="">全員(選択中のサーバー)${db.users.map(x => `<option${x.name === who ? ' selected' : ''}>${esc(x.name)}`).join('')}</select></label></form>` : '';
  res.send(page(u, '操作ログ', fs_(who ? `操作ログ(${who})` : all ? '操作ログ(全員の分)' : '操作ログ(自分の分)', sel + table(['日時', '係員', '操作', '対象', '内容', 'サーバー'], rows))));
});

// ---- DM ----
app.get('/dms', auth(), (req, res) => {
  const rows = db.dms.filter(d => visDm(req.u, d)).slice(0, 100).map(d => tr([esc(d.t), esc(d.name), esc(d.uid), esc(d.text.slice(0, 30)), esc(stLabel(d)), `<a class=b href=/dms/${d.id}>開く</a>`]));
  res.send(page(req.u, 'DM受信', fs_('DM受信履歴(新しい順)', table(['受信日時', 'Discordアカウント名', 'アカウントID', 'メッセージ(一部)', '状況', '開く'], rows))));
});
app.get('/dms/:id', auth(), (req, res) => {
  const d = db.dms.find(x => x.id === +req.params.id && visDm(req.u, x));
  if (!d) return res.redirect('/dms');
  res.send(page(req.u, 'DM受信', fs_('DM', table(['項目', '内容'], [tr(['日時', esc(d.t)]), tr(['アカウント名', esc(d.name)]), tr(['アカウントID', esc(d.uid)]), tr(['メッセージ', esc(d.text)]), tr(['対応状況', esc(stLabel(d))])])) + '<a class=b href=/dms>一覧へ</a> ' + [['todo', '未対応に戻す'], ['doing', '対応中にする'], ['done', '完了にする']].map(([x, l]) => `<form method=post action=/dms/${d.id}/st style="display:inline"><input type=hidden name=s value=${x}><button>${l}</button></form>`).join(' ')));
});
app.get('/dm', auth(), (req, res) => res.send(page(req.u, 'DM送信', fs_('DM送信', `<form method=post class=main><label>送信先のDiscordアカウントID<input name=uid list=ri required pattern="\\d{15,22}" inputmode=numeric></label>${recentIds(req.u)}<label>メッセージ<textarea name=text rows=7 required maxlength=1500></textarea></label></form>${note('1人あたり1時間に20通まで送れます。相手がDMを拒否していると届きません。選択中のサーバーのメンバーにだけ送れます。')}`), FORM)));
app.post('/dm', auth(), async (req, res) => {
  const u = req.u, { uid, text } = req.body;
  if (!isId(uid) || !text) return bad(res, u, '入力が正しくありません');
  if (!u.gid || !await bot.guilds.fetch(u.gid).then(g => g.members.fetch(uid)).catch(() => null)) return bad(res, u, `このサーバー(${gname(u.gid)})のメンバーではないため送れません`);
  db.dmlog = db.dmlog.filter(x => x.ts > Date.now() - 36e5);
  if (db.dmlog.filter(x => x.uid === uid).length >= 20) return res.status(429).send(done(u, 'DM送信', 'この相手には1時間に20通まで送れます。しばらく待ってください。'));
  try { await bot.users.send(uid, text.slice(0, 1500)); db.dmlog.push({ uid, ts: Date.now() }); save(); log(u.name, 'DM送信', uid, '', u.gid); res.send(done(u, 'DM送信', '送信しました')); }
  catch (e) { res.status(500).send(done(u, 'DM送信', explain(e))); }
});

// ---- 管理者間通信 ----
app.get('/inbox', auth(), (req, res) => {
  const u = req.u, tab = ['in', 'out', 'new'].includes(req.query.tab) ? req.query.tab : 'in';
  const tabs = `<div class=tb>${[['in', '受信箱'], ['out', '送信済み'], ['new', '新規作成']].map(([k, v]) => `<a class="b${tab === k ? ' cur' : ''}" href="/inbox?tab=${k}">${v}</a>`).join('')}</div>`;
  if (tab === 'new') return res.send(page(u, '管理者間通信', tabs + fs_('新規作成', `<form method=post class=main><label>宛先<select name=to><option value="*">このサーバーの全員(一斉送信)${db.users.filter(x => x.id !== u.id && allowed(x).includes(u.gid)).map(x => `<option>${esc(x.name)}`).join('')}</select></label><label>件名<input name=subject maxlength=100></label><label>本文<textarea name=text rows=6 required maxlength=1500></textarea></label></form>`), [...BASE, '発信']));
  const seen = new Set();
  const rows = db.msgs.filter(m => m.gid === u.gid).filter(m => tab === 'in' ? m.to === u.name : (m.from === u.name && (!m.grp || (!seen.has(m.grp) && seen.add(m.grp))))).slice(0, 100)
    .map(m => tr([esc(m.t), esc(tab === 'in' ? m.from : m.grp ? `全員(${db.msgs.filter(x => x.grp === m.grp).length}人)` : m.to), esc(m.subject), m.read ? '既読' : '未読', `<a class=b href=/inbox/${m.id}>開く</a>`]));
  res.send(page(u, '管理者間通信', tabs + fs_(tab === 'in' ? '受信箱' : '送信済み', table(['日時', tab === 'in' ? '差出人' : '宛先', '件名', '状態', '開く'], rows)), [...BASE, '発信'], { 発信: "location='/inbox?tab=new'" }));
});
app.get('/inbox/:id', auth(), (req, res) => {
  const u = req.u, m = db.msgs.find(x => x.id === +req.params.id && (x.to === u.name || x.from === u.name) && x.gid === u.gid);
  if (!m) return res.redirect('/inbox');
  if (m.to === u.name && !m.read) { m.read = true; save(); }
  res.send(page(u, '管理者間通信', fs_('メッセージ', table(['項目', '内容'], [tr(['日時', esc(m.t)]), tr(['差出人', esc(m.from)]), tr(['宛先', esc(m.grp && m.from === u.name ? '全員(一斉送信)' : m.to)]), tr(['件名', esc(m.subject)]), tr(['本文', esc(m.text)])])) + '<a class=b href=/inbox>受信箱へ</a>' + (can(u, 'delMsg') ? ` <form method=post action=/inbox/${m.id}/delete style="display:inline" onsubmit="return confirm('このメッセージを削除しますか?')"><button>削除</button></form>` : '')));
});
app.post('/inbox/:id/delete', auth('delMsg'), (req, res) => {
  const u = req.u, m = db.msgs.find(x => x.id === +req.params.id && (x.to === u.name || x.from === u.name));
  if (!m) return res.redirect('/inbox');
  const gone = m.grp && m.from === u.name ? db.msgs.filter(x => x.grp === m.grp) : [m];
  db.msgs = db.msgs.filter(x => !gone.includes(x)); save();
  log(u.name, 'メッセージ削除', '', `${m.subject}(${gone.length}件)`, m.gid);
  res.redirect('/inbox');
});
app.post('/inbox', auth(), (req, res) => {
  const { to, subject, text } = req.body;
  const bulk = to === '*', pool = db.users.filter(x => x.id !== req.u.id && allowed(x).includes(req.u.gid)), names = (bulk ? pool : pool.filter(x => x.name === to)).map(x => x.name);
  if (!names.length || !text) return bad(res, req.u, '入力が正しくありません(宛先がいません)');
  const grp = bulk ? nid() : undefined, subj = String(subject || '(件名なし)').slice(0, 100), t = now();
  names.forEach(n => db.msgs.unshift({ id: nid(), t, from: req.u.name, to: n, subject: subj, text: text.slice(0, 1500), read: false, grp, gid: req.u.gid }));
  save(); if (bulk) log(req.u.name, '一斉送信', '', subj, req.u.gid);
  pool.filter(x => names.includes(x.name) && x.discordId).forEach(x => bot.users.send(x.discordId, `【管理画面】${req.u.name}さんから新着メッセージ: ${subj}`).catch(() => {}));
  res.redirect('/inbox?tab=out');
});

// ---- サーバー管理(ユーザー情報・ロール・VC・招待・緊急対応・埋め込み) ----
const run = fn => (req, res) => Promise.race([Promise.resolve().then(() => fn(req, res)), new Promise((_, rj) => setTimeout(() => rj(new Error('TIMEOUT')), 25000))]).catch(e => { if (!res.headersSent) res.status(e.message === 'TIMEOUT' ? 504 : 500).send(done(req.u, 'エラー', explain(e))); });
const fmtD = d => d ? new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 16) : '-';
const G_ = async u => { if (!u.gid) throw new Error('サーバーが選択されていません'); if (!bot.isReady()) throw new Error('BOT_OFFLINE'); return bot.guilds.fetch(u.gid); };
const chans = (g, types = [0, 5]) => g.channels.cache.filter(c => types.includes(c.type));
const btn = (action, label, ask, extra = '') => `<form method=post action=${action} style="display:inline" onsubmit="return confirm('${ask}')">${extra}<button>${label}</button></form>`;

// ユーザー情報(ID・参加日・ロール・警告回数・ステータス)+ロール付け外し
app.get('/user', auth(), run(async (req, res) => {
  const u = req.u, q = String(req.query.q || '').trim();
  let out = '';
  if (q) {
    const g = await G_(u);
    const ms = isId(q) ? [await g.members.fetch(q).catch(() => null)].filter(Boolean) : [...(await g.members.search({ query: q, limit: 10 })).values()];
    const roleOpts = [...g.roles.cache.values()].filter(r => r.id !== g.id && !r.managed && r.editable && (u.role === 'owner' || !isDangerous(r))).sort((a, b) => b.position - a.position).map(r => `<option value=${r.id}>${esc(r.name)}`).join('');
    const hist = id => { const c = db.cases.filter(x => x.gid === u.gid && x.uid === id), n = t => c.filter(x => x.type === t).length; return { warn: n('warn'), txt: `警告${n('warn')} / タイムアウト${n('timeout')} / KICK${n('kick')} / BAN${n('ban')}` }; };
    for (const m of ms) {
      const h = hist(m.id), to = m.communicationDisabledUntilTimestamp > Date.now() ? `タイムアウト中(〜${fmtD(m.communicationDisabledUntilTimestamp)})` : '通常';
      out += fs_(m.displayName, table(['項目', '内容'], [tr(['ユーザーID', esc(m.id)]), tr(['アカウント名', esc(m.user.tag)]), tr(['サーバー参加日', fmtD(m.joinedAt)]), tr(['アカウント作成日', fmtD(m.user.createdAt)]),
        tr(['所持ロール', esc([...m.roles.cache.values()].filter(r => r.id !== g.id).map(r => r.name).join(', ') || 'なし')]), tr(['過去の警告回数', `${h.warn} 回`]), tr(['処分履歴(このシステム)', h.txt]),
        tr(['現在のステータス', to + (m.voice?.channel ? ` / VC参加中(${esc(m.voice.channel.name)})` : '')])]) +
        (can(u, 'direct') ? `<form method=post action=/role><input type=hidden name=uid value=${m.id}><label>ロール<select name=rid>${roleOpts}</select></label><button name=a value=add>付与</button> <button name=a value=remove>解除</button></form>` : ''));
    }
    if (!ms.length && isId(q)) {
      const ban = await g.bans.fetch({ user: q, force: true }).catch(() => null), h = hist(q);
      out += fs_('サーバーにいないユーザー', table(['項目', '内容'], [tr(['ユーザーID', esc(q)]), tr(['現在のステータス', ban ? `BAN中(理由: ${esc(ban.reason || 'なし')})` : 'サーバーにいません(BANなし)']), tr(['過去の警告回数', `${h.warn} 回`]), tr(['処分履歴(このシステム)', h.txt])]));
    } else if (!ms.length) out += note('見つかりませんでした。');
  }
  res.send(page(u, 'ユーザー情報', fs_(`ユーザー検索(${gname(u.gid)})`, `<form method=get class=main><label>ユーザーIDまたは名前<input name=q value="${esc(q)}"></label></form>`) + out, [...BASE, '照会']));
}));
app.post('/role', auth('direct'), run(async (req, res) => {
  const u = req.u, { uid, rid, a } = req.body;
  if (!isId(uid) || !isId(rid) || !['add', 'remove'].includes(a)) return bad(res, u, '入力が正しくありません');
  const g = await G_(u), role = g.roles.cache.get(rid), m = await g.members.fetch(uid);
  if (!role || role.managed || role.id === g.id) return bad(res, u, 'このロールは操作できません');
  if (u.role !== 'owner' && isDangerous(role)) return bad(res, u, '危険な権限(管理者・サーバー管理・BANなど)を含むロールは最高管理者だけが操作できます');
  if (a === 'add') await m.roles.add(role, `by ${u.name}`); else await m.roles.remove(role, `by ${u.name}`);
  log(u.name, a === 'add' ? 'ロール付与' : 'ロール解除', uid, role.name, u.gid);
  res.redirect('/user?q=' + uid);
}));

// 埋め込みメッセージ投稿
app.get('/embed', auth('direct'), run(async (req, res) => {
  const u = req.u, g = await G_(u); await g.channels.fetch();
  const opts = [...chans(g).values()].sort((a, b) => a.rawPosition - b.rawPosition).map(c => `<option value=${c.id}>#${esc(c.name)}`).join('');
  res.send(page(u, '埋め込み投稿', fs_(`埋め込み投稿(${gname(u.gid)})`, `<form method=post class=main><label>チャンネル<select name=cid>${opts}</select></label><label>タイトル<input name=title maxlength=256 required></label><label>本文<textarea name=text rows=6 maxlength=4000 required></textarea></label><label>色<input type=color name=color value="#2a45b5"></label><label>予約投稿の日時(日本時間。空欄なら今すぐ投稿)<input type=datetime-local name=when></label><div><button type=button onclick="qd(60)">1時間後</button> <button type=button onclick="qd(180)">3時間後</button> <button type=button onclick="qt(20,0)">今夜20:00</button> <button type=button onclick="qt(9,1)">明日9:00</button> <button type=button onclick="qt(20,1)">明日20:00</button></div></form>`) + schedList(u), [...FORM, '予約']));
}));
app.post('/embed', auth('direct'), run(async (req, res) => {
  const u = req.u, { cid, title, text, color } = req.body, g = await G_(u), c = g.channels.cache.get(cid) || await g.channels.fetch(cid).catch(() => null);
  if (!c || ![0, 5].includes(c.type) || !title || !text || !/^#[0-9a-f]{6}$/i.test(color || '')) return bad(res, u, '入力が正しくありません');
  if (req.body.when) return schedulePost(req, res, c);
  await c.send({ embeds: [new EmbedBuilder().setTitle(title.slice(0, 256)).setDescription(text.slice(0, 4000)).setColor(parseInt(color.slice(1), 16))] });
  log(u.name, '埋め込み投稿', c.id, title, u.gid); res.send(done(u, '埋め込み投稿', `#${c.name} に投稿しました`));
}));

// VC管理(10秒ごとに自動更新)
app.get('/vc', auth(), run(async (req, res) => {
  const u = req.u, g = await G_(u);
  const rows = [...g.voiceStates.cache.values()].filter(v => v.channel).sort((a, b) => a.channel.rawPosition - b.channel.rawPosition).map(v => tr([esc(v.channel.name), esc(v.member?.displayName || v.id), esc(v.id), v.serverMute ? 'サーバーミュート中' : v.selfMute ? '自分でミュート' : '-',
    `<form method=post action=/vc/act style="display:inline"><input type=hidden name=uid value=${v.id}><button name=a value=disconnect>切断</button> <button name=a value=mute>ミュート</button> <button name=a value=unmute>ミュート解除</button></form>`]));
  res.send(page(u, 'VC管理', fs_(`ボイスチャンネルの参加者(${gname(u.gid)} / 10秒ごとに自動更新)`, rows.length ? table(['VC', '名前', 'ユーザーID', '状態', '操作'], rows) : empty('現在VCに参加している人はいません。')) + '<script>setTimeout(function(){location.reload()},10000)</script>'));
}));
app.post('/vc/act', auth(), run(async (req, res) => {
  const u = req.u, { uid, a } = req.body;
  if (!isId(uid) || !['disconnect', 'mute', 'unmute'].includes(a)) return bad(res, u, '入力が正しくありません');
  const g = await G_(u), m = await g.members.fetch(uid);
  if (!m.voice.channel) return bad(res, u, 'この人は今VCにいません');
  if (a === 'disconnect') { panelVc[`${u.gid}:${uid}`] = { ts: Date.now(), by: u.name }; await m.voice.disconnect(`by ${u.name}`); } else await m.voice.setMute(a === 'mute', `by ${u.name}`);
  log(u.name, { disconnect: 'VC切断', mute: 'VCミュート', unmute: 'VCミュート解除' }[a], uid, '', u.gid);
  if (a !== 'disconnect') db.vclog.unshift({ ts: Date.now(), t: now(), gid: u.gid, uid, name: m.displayName, kind: a === 'mute' ? 'ミュート' : 'ミュート解除', from: m.voice.channel ? m.voice.channel.name : '', to: '', note: `${u.name}が管理画面から` }); res.redirect('/vc');
}));

// 招待リンクの確認と破棄
app.get('/invites', auth('direct'), run(async (req, res) => {
  const u = req.u, g = await G_(u), inv = [...(await g.invites.fetch()).values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  const rows = inv.map(i => tr([esc(i.code), esc(i.inviter?.tag || '不明'), esc(i.inviterId || '-'), `${i.uses ?? 0} / ${i.maxUses || '∞'}`, fmtD(i.createdAt), i.expiresAt ? fmtD(i.expiresAt) : '無期限', esc(i.channel?.name || '-'),
    `<form method=post action=/invites/delete onsubmit="return confirm('この招待リンクを破棄しますか?')"><input type=hidden name=code value="${esc(i.code)}"><button>破棄</button></form>`]));
  res.send(page(u, '招待リンク', fs_(`有効な招待リンク(${gname(u.gid)})`, rows.length ? table(['コード', '作成者', '作成者ID', '使用回数', '作成日', '有効期限', 'チャンネル', '操作'], rows) : empty('有効な招待リンクはありません。'))));
}));
app.post('/invites/delete', auth('direct'), run(async (req, res) => {
  const u = req.u, code = String(req.body.code || '');
  if (!/^[\w-]{2,32}$/.test(code)) return bad(res, u, '入力が正しくありません');
  await (await G_(u)).invites.delete(code, `by ${u.name}`);
  log(u.name, '招待リンク破棄', code, '', u.gid); res.redirect('/invites');
}));

// 緊急対応(発動も解除も最高管理者のみ)
app.get('/emerg', auth('release'), run(async (req, res) => {
  const u = req.u, g = await G_(u), st = db.emerg[u.gid] || {}, rel = can(u, 'release'), gate = g.features.includes('INVITES_DISABLED');
  const on = s => s ? `<b>発動中</b>(${esc(s.by)} / ${esc(s.at)})` : '未発動';
  const relBtn = (action, label) => rel ? btn(action, label, `${label}しますか?`, PW) : '<small>解除は最高管理者のみ</small>';
  const secs = [5, 10, 30, 60, 300, 900, 3600].map(x => `<option value=${x}>${x >= 60 ? x / 60 + '分' : x + '秒'}`).join('');
  res.send(page(u, '緊急対応', note(`対象サーバー: ${gname(u.gid)}`) +
    fs_('緊急封鎖(全テキストチャンネルの書き込み停止)', `<p>状態: ${on(st.lock)}</p>${btn('/emerg/lock', '緊急封鎖する', '全テキストチャンネルの書き込みを停止します。よろしいですか?', PW)} ${relBtn('/emerg/unlock', '封鎖を解除')}`) +
    fs_('低速モード(全テキストチャンネル)', `<p>状態: ${st.slow ? `<b>発動中</b>(${st.slow.sec}秒 / ${esc(st.slow.by)} / ${esc(st.slow.at)})` : '未発動'}</p><form method=post action=/emerg/slow onsubmit="return confirm('全チャンネルに低速モードを適用しますか?')"><label>書き込み間隔<select name=sec>${secs}</select></label>${PW}<button>適用</button></form> ${relBtn('/emerg/unslow', '低速モードを解除')}`) +
    fs_('ゲート封鎖(新規参加のブロック)', `<p>状態: ${gate ? '<b>封鎖中</b>' : '未封鎖'}${st.gate ? `(${esc(st.gate.by)} / ${esc(st.gate.at)})` : ''}</p>${btn('/emerg/gate', 'ゲートを封鎖する', '招待リンクからの新規参加を止めます。よろしいですか?', PW)} ${relBtn('/emerg/ungate', 'ゲートを解除')}`)));
}));
app.post('/emerg/:act', auth('release'), run(async (req, res) => {
  const u = req.u, a = req.params.act;
  if (!pwOk(u, req)) return bad(res, u, "パスワードが違います(危険操作はパスワードの再入力が必要です)");
  const g = await G_(u), st = db.emerg[u.gid] ??= {};
  if (['unlock', 'unslow', 'ungate'].includes(a) && !can(u, 'release')) { log(u.name, '権限なしの操作', '', req.path, u.gid); return res.status(403).send(done(u, '権限なし', '解除は最高管理者だけが行えます。')); }
  let msg, fail = 0;
  if (a === 'lock') {
    if (st.lock) throw new Error('すでに封鎖中です');
    await g.channels.fetch(); const prev = {};
    for (const c of chans(g).values()) { const ow = c.permissionOverwrites.cache.get(g.id); prev[c.id] = ow?.deny.has('SendMessages') ? false : ow?.allow.has('SendMessages') ? true : null; await c.permissionOverwrites.edit(g.id, { SendMessages: false }, { reason: `緊急封鎖 by ${u.name}` }).catch(() => fail++); }
    st.lock = { at: now(), by: u.name, prev }; msg = `緊急封鎖しました${fail ? `(${fail}件のチャンネルは失敗)` : ''}`;
  } else if (a === 'unlock') {
    if (!st.lock) throw new Error('封鎖していません');
    for (const [id, v] of Object.entries(st.lock.prev)) { const c = g.channels.cache.get(id); if (c) await c.permissionOverwrites.edit(g.id, { SendMessages: v }).catch(() => fail++); }
    delete st.lock; msg = `封鎖を解除しました${fail ? `(${fail}件のチャンネルは失敗)` : ''}`;
  } else if (a === 'slow') {
    const sec = +req.body.sec;
    if (![5, 10, 30, 60, 300, 900, 3600].includes(sec)) return bad(res, u, '入力が正しくありません');
    if (st.slow) throw new Error('すでに適用中です。先に解除してください');
    await g.channels.fetch(); const prev = {};
    for (const c of chans(g, [0]).values()) { prev[c.id] = c.rateLimitPerUser || 0; await c.setRateLimitPerUser(sec, `緊急対応 by ${u.name}`).catch(() => fail++); }
    st.slow = { at: now(), by: u.name, sec, prev }; msg = `低速モードを適用しました(${sec}秒)${fail ? `(${fail}件のチャンネルは失敗)` : ''}`;
  } else if (a === 'unslow') {
    if (!st.slow) throw new Error('低速モードを適用していません');
    for (const [id, v] of Object.entries(st.slow.prev)) { const c = g.channels.cache.get(id); if (c) await c.setRateLimitPerUser(v).catch(() => fail++); }
    delete st.slow; msg = `低速モードを解除しました${fail ? `(${fail}件のチャンネルは失敗)` : ''}`;
  } else if (a === 'gate') { await g.disableInvites(true); st.gate = { at: now(), by: u.name }; msg = 'ゲートを封鎖しました(招待リンクからの新規参加を停止)'; }
  else if (a === 'ungate') { await g.disableInvites(false); delete st.gate; msg = 'ゲートを解除しました'; }
  else return res.redirect('/emerg');
  save(); log(u.name, `緊急対応:${a}`, '', msg, u.gid); res.send(done(u, '緊急対応', msg));
}));

// ---- 端末ロック・稼働中スタッフ・共有メモ・対応ステータス・緊急招集・新着通知 ----
const seen = new Map();
const onlineText = u => { const l = [...seen.values()].filter(x => Date.now() - x.ts < 3e5 && x.gid === u.gid); return `稼働中 ${l.filter(x => !x.away).length}人: ${l.map(x => x.name + (x.away ? '(離席)' : '')).join(', ') || '-'}`; };
const online = u => esc(onlineText(u));
const PW = '<input type=password name=pw placeholder="パスワードを再入力" required autocomplete=current-password>';
const pwOk = (u, req) => bcrypt.compareSync(req.body.pw || '', u.hash);
const lockPage = (u, t) => page(null, '端末ロック', fs_(`端末ロック中(${u.name})`, `${note(t)}<form method=post action=/unlock><label>パスワード<input name=pass type=password autocomplete=current-password></label><button>ロック解除</button></form><a class=b href=/logout>ログアウト</a>`), []);
const stLabel = d => d.st === 'doing' ? `${d.by}が対応中(ロック)` : d.st === 'done' ? `完了(${d.by})` : '未対応';
const memoBox = u => { const m = db.memo[u.gid]; return `<div class=note style="font-weight:700">${m && m.text ? esc(m.text) : '(共有メモはありません)'}${m ? `<br><small>更新: ${esc(m.by)} ${esc(m.at)}</small>` : ''}</div><form method=post action=/memo><input name=text maxlength=200 value="${esc(m ? m.text : '')}" placeholder="全体共有メモ(例:【警戒】スパムURL荒らし発生中 / ○○さんは22時まで対応可)"><button>メモを保存</button></form>`; };
const POLL = "var N=null;function beep(){try{var a=new (window.AudioContext||window.webkitAudioContext)(),o=a.createOscillator();o.connect(a.destination);o.frequency.value=880;o.start();setTimeout(function(){o.stop()},250)}catch(e){}}function poll(){fetch('/api/unread').then(function(r){return r.json()}).then(function(j){if(N!==null&&j.n>N){beep();document.title='(新着) 管理システム端末';var b=document.getElementById('nb');if(b)b.style.display='block'}var o=document.getElementById('ol');if(o&&j.ol)o.textContent=j.ol;var s=document.getElementById('sa');if(s){s.style.display=j.stale>0?'block':'none';s.textContent='未対応のまま2時間以上放置されている案件が'+j.stale+'件あります'}var b=document.getElementById('sb');if(b){b.style.display=j.alerts>0?'block':'none';var q=document.getElementById('sbn');if(q)q.textContent=j.alerts}N=j.n}).catch(function(){})}setInterval(poll,15000);poll();";

app.get('/api/unread', auth(), (req, res) => res.json({ n: db.msgs.filter(m => m.to === req.u.name && !m.read && m.gid === req.u.gid).length, ol: onlineText(req.u), stale: staleItems(req.u).length, alerts: unack(req.u) }));
app.get('/lock', auth(), (req, res) => { const s = seen.get(req.u.id); if (s) s.away = true; req.session.locked = true; log(req.u.name, '端末ロック', '', '', req.u.gid); res.redirect('/'); });
app.post('/unlock', auth(), (req, res) => {
  if (!bcrypt.compareSync(req.body.pass || '', req.u.hash)) {
    if ((req.session.ul = (req.session.ul || 0) + 1) >= 5) return req.session.destroy(() => res.redirect('/login'));
    return res.status(401).send(lockPage(req.u, 'パスワードが違います'));
  }
  req.session.locked = false; req.session.ul = 0; const s = seen.get(req.u.id); if (s) s.away = false;
  log(req.u.name, '端末ロック解除', '', '', req.u.gid); res.redirect('/');
});
app.post('/memo', auth(), (req, res) => {
  if (req.u.gid) { db.memo[req.u.gid] = { text: String(req.body.text || '').slice(0, 200), by: req.u.name, at: now() }; save(); log(req.u.name, '共有メモ更新', '', db.memo[req.u.gid].text, req.u.gid); }
  res.redirect('/');
});
app.post('/dms/:id/st', auth(), (req, res) => {
  const d = db.dms.find(x => x.id === +req.params.id && visDm(req.u, x)), s = req.body.s;
  if (!d || !['todo', 'doing', 'done'].includes(s)) return res.redirect('/dms');
  if ((d.st || 'todo') === 'doing' && d.by !== req.u.name && req.u.role !== 'owner') return bad(res, req.u, `${d.by}が対応中です(ロック中)`);
  d.st = s; d.by = req.u.name; save(); log(req.u.name, 'DM対応状況', d.uid, stLabel(d), req.u.gid); res.redirect('/dms/' + d.id);
});

// 緊急招集(Discordのメンション付き。オフライン・離席中の人にも届く)
app.get('/summon', auth('direct'), run(async (req, res) => {
  const u = req.u, g = await G_(u); await g.channels.fetch();
  const opts = [...chans(g).values()].sort((a, b) => a.rawPosition - b.rawPosition).map(c => `<option value=${c.id}>#${esc(c.name)}`).join('');
  const staff = db.users.filter(x => allowed(x).includes(u.gid));
  res.send(page(u, '緊急招集', fs_(`緊急招集(${gname(u.gid)})`, note('指定したチャンネルにDiscordのメンション付きで投稿し、DMと管理者間通信でも知らせます。') + `<form method=post class=main><label>投稿するチャンネル<select name=cid>${opts}</select></label><label>メッセージ<input name=text maxlength=200 value="緊急招集: 至急、管理画面を確認してください" required></label></form>` + note(`対象: ${staff.map(x => x.name + (x.discordId ? '' : '(Discord ID未登録)')).join(', ')}`)), FORM));
}));
app.post('/summon', auth('direct'), run(async (req, res) => {
  const u = req.u, g = await G_(u), text = String(req.body.text || '').slice(0, 200), c = g.channels.cache.get(req.body.cid) || await g.channels.fetch(req.body.cid).catch(() => null);
  if (!text || !c || ![0, 5].includes(c.type)) return bad(res, u, '入力が正しくありません');
  const staff = db.users.filter(x => allowed(x).includes(u.gid) && x.id !== u.id), ids = staff.filter(x => x.discordId).map(x => x.discordId);
  await c.send({ content: `🚨 ${text}\n${ids.map(i => `<@${i}>`).join(' ')}`, allowedMentions: { users: ids } });
  ids.forEach(i => bot.users.send(i, `🚨【${gname(u.gid)}】${text}(${u.name}より)`).catch(() => {}));
  const grp = nid(), t = now(); staff.forEach(x => db.msgs.unshift({ id: nid(), t, from: u.name, to: x.name, subject: '【緊急招集】', text, read: false, grp, gid: u.gid }));
  save(); log(u.name, '緊急招集', c.id, text, u.gid);
  res.send(done(u, '緊急招集', `#${c.name} に投稿し、${ids.length}人にDMで知らせました${staff.length - ids.length ? `(Discord ID未登録の${staff.length - ids.length}人は管理者間通信のみ)` : ''}`));
}));

// ---- メールによる2段階認証(Gmail) ----
let mailer = null;
try {
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
    mailer = require('nodemailer').createTransport({ host: 'smtp.gmail.com', port: +process.env.SMTP_PORT || 465, secure: (+process.env.SMTP_PORT || 465) === 465, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, '') } });
} catch (e) { console.error('nodemailer を読み込めません(package.json の更新が必要です)'); }
const HOOK = process.env.MAIL_WEBHOOK_URL, MAIL_OK = !!mailer || !!HOOK; // MAIL_WEBHOOK_URL: Google Apps Script経由(SMTPが使えないホスト向け)
const needMfa = u => u.mfa && !process.env.MFA_BYPASS; // MFA_BYPASS=1 は緊急用(メールが使えないときだけ設定)
const sha = c => crypto.createHash('sha256').update(c + SESSION_SECRET).digest('hex');
const maskMail = m => String(m).replace(/^(.).*(@.*)$/, '$1***$2');
const sendMail = async (to, subject, text) => {
  if (HOOK) {
    const r = await fetch(HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: process.env.MAIL_WEBHOOK_SECRET, to, subject, text }), signal: AbortSignal.timeout(20000) });
    const body = (await r.text()).trim();
    if (body !== 'OK') throw new Error(body === 'NG' ? '合言葉が一致しません(ホストの MAIL_WEBHOOK_SECRET と Apps Script の合言葉を同じにしてください)' : body.startsWith('<') ? 'Apps Scriptの権限またはデプロイ設定の問題です(「アクセスできるユーザー」を「全員」にして、新しいバージョンでデプロイし直してください)' : `メール送信サービスの応答: ${body.slice(0, 60)}`);
    return;
  }
  return mailer.sendMail({ from: `${SITE} <${process.env.GMAIL_USER}>`, to, subject, text });
};
async function sendCode(req, u) {
  if (!MAIL_OK || !u.email) throw new Error('メール送信が設定されていません');
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await sendMail(u.email, `【${SITE}】ログイン確認コード`, `ログイン確認コード: ${code}\n有効期限は10分です。\n心当たりがない場合は、このメールを無視して、最高管理者に連絡してください。`);
  req.session.mfa = { uid: u.id, h: sha(code), exp: Date.now() + 6e5, tries: 0, sent: Date.now() };
}
const codePage = (u, t) => page(null, 'ログイン(2段階認証)', fs_('確認コードの入力', `${note(t)}${note(`${maskMail(u.email)} にコードを送りました(有効期限10分)`)}<form method=post><label>6桁のコード<input name=code inputmode=numeric autocomplete=one-time-code pattern="\\d{6}" maxlength=6 required></label><button>確認</button></form><form method=post action=/login/resend style="display:inline"><button>コードを再送する</button></form> <a class=b href=/login>最初に戻る</a>`), []);
const mfaUser = req => { const m = req.session.mfa; return m && db.users.find(x => x.id === m.uid); };
app.get('/login/code', (req, res) => { const u = mfaUser(req); if (!u) return res.redirect('/login'); res.send(codePage(u)); });
app.post('/login/code', (req, res) => {
  const u = mfaUser(req), m = req.session.mfa;
  if (!u) return res.redirect('/login');
  if (Date.now() > m.exp || m.tries >= 5) { delete req.session.mfa; return res.status(401).send(loginPage('コードの期限切れ、または入力回数の上限です。最初からやり直してください。')); }
  m.tries++;
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(sha(String(req.body.code || '').trim())), Buffer.from(m.h)); } catch (e) { ok = false; }
  if (!ok) { log(u.name, '2段階認証コード不一致'); return res.status(401).send(codePage(u, `コードが違います(残り${5 - m.tries}回)`)); }
  req.session.regenerate(() => { req.session.uid = u.id; log(u.name, 'ログイン(2段階認証)'); res.redirect('/'); });
});
app.post('/login/resend', async (req, res) => {
  const u = mfaUser(req);
  if (!u) return res.redirect('/login');
  if (Date.now() - req.session.mfa.sent < 6e4) return res.status(429).send(codePage(u, '再送は1分以上あけてください'));
  try { await sendCode(req, u); res.send(codePage(u, 'コードを再送しました')); } catch (e) { res.status(500).send(codePage(u, 'メールを送信できませんでした')); }
});
app.post('/mfa/test', auth('accounts'), run(async (req, res) => {
  const to = String(req.body.email || '').trim();
  if (!MAIL_OK) return bad(res, req.u, 'メール送信が未設定です(環境変数 GMAIL_USER と GMAIL_APP_PASSWORD を設定してください)');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return bad(res, req.u, 'メールアドレスが正しくありません');
  await sendMail(to, `【${SITE}】テストメール`, 'このメールが届いていれば、2段階認証のメール送信は正常です。');
  log(req.u.name, 'テストメール送信', '', maskMail(to)); res.send(done(req.u, 'テストメール', `${maskMail(to)} に送信しました。届いたか確認してください。`));
}));

// ---- 案件の放置アラート・危険ロール・稼働実績・BAN解除の外部申請 ----
const STALE = 2 * 3600e3;
const DANGER = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageWebhooks', 'BanMembers', 'KickMembers', 'ModerateMembers', 'MentionEveryone'];
const isDangerous = r => r.permissions.any(DANGER);
const staleItems = u => [...db.dms.filter(d => visDm(u, d) && (d.st || 'todo') === 'todo' && d.ts && Date.now() - d.ts > STALE),
  ...(can(u, 'approve') ? db.reqs.filter(r => r.gid === u.gid && r.status === '申請中' && !r.lock && r.ts && Date.now() - r.ts > STALE) : [])];
const reqBtns = (r, u) => {
  const f = (a, l) => `<button name=a value=${a}>${l}</button>`, mine = r.lock && r.lock.by === u.name, other = r.lock && !mine;
  const head = other ? `<b>${esc(r.lock.by)}が対応中(ロック)</b> ` + (u.role === 'owner' ? f('unlock', 'ロック解除') + ' ' : '') : (mine ? f('unlock', '対応を外す') : f('lock', '対応する')) + ' ';
  return `<form method=post action=/approve/${r.id}>${head}${!other || u.role === 'owner' ? f('ok', '承認') + ' ' + f('no', '却下') : ''}</form>`;
};
function checkStale() {
  for (const gid of GIDS) {
    const items = [...db.dms.filter(d => d.gids.includes(gid) && (d.st || 'todo') === 'todo' && d.ts && Date.now() - d.ts > STALE && !d.alerted), ...db.reqs.filter(r => r.gid === gid && r.status === '申請中' && !r.lock && r.ts && Date.now() - r.ts > STALE && !r.alerted)];
    if (!items.length) continue;
    items.forEach(x => { x.alerted = true; });
    const text = `未対応のまま2時間以上放置されている案件が${items.length}件あります。DM受信・申請承認を確認してください。`, t = now();
    db.users.filter(x => allowed(x).includes(gid)).forEach(x => { db.msgs.unshift({ id: nid(), t, from: 'システム', to: x.name, subject: '【放置アラート】', text, read: false, gid }); if (x.discordId) bot.users.send(x.discordId, `【${gname(gid)}】${text}`).catch(() => {}); });
    save();
  }
}
setInterval(checkStale, 6e5);

app.get('/staffstats', auth('logsAll'), (req, res) => {
  const u = req.u, days = [1, 7, 30].includes(+req.query.days) ? +req.query.days : 7, from = fmtD(Date.now() - days * 864e5);
  const rows = db.users.filter(x => allowed(x).includes(u.gid)).map(x => {
    const l = db.logs.filter(e => e.who === x.name && e.t >= from && (!e.gid || e.gid === u.gid)), n = f => l.filter(f).length;
    return tr([esc(x.name), ROLES[x.role], n(e => e.op === 'BAN'), n(e => e.op === 'KICK'), n(e => e.op.startsWith('タイムアウト(')), n(e => e.op === '警告'), n(e => e.op === '申請承認済'), n(e => e.op === '申請却下'), n(e => e.op === 'DM対応状況' && e.detail.startsWith('完了')), n(e => e.op === 'ログイン' || e.op === 'ログイン(2段階認証)')]);
  });
  const sel = `<form method=get><label>期間<select name=days onchange="this.form.submit()">${[[1, '今日(24時間)'], [7, '7日間'], [30, '30日間']].map(([d, l]) => `<option value=${d}${d === days ? ' selected' : ''}>${l}`).join('')}</select></label></form>`;
  res.send(page(u, '稼働実績', fs_(`スタッフ別の稼働実績(${gname(u.gid)} / 直近${days}日)`, sel + table(['スタッフ', '権限', 'BAN', 'KICK', 'タイムアウト', '警告', '申請承認', '申請却下', 'DM対応完了', 'ログイン'], rows))));
});

// BAN解除の外部申請(専用ページ / Googleフォーム連携)。スタッフ個人の情報は相手に渡らない
const appealHits = {};
const appealPage = (gid, msg) => page(null, 'BAN解除申請', fs_(`BAN解除申請(${gname(gid)})`, `${note(msg)}${note('BANされたアカウントのIDと、反省の内容を入力してください。審査はサーバー運営が行います。')}<form method=post><label>あなたのDiscordユーザーID<input name=uid required pattern="\\d{15,22}" inputmode=numeric></label><label>反省文・解除をお願いする理由<textarea name=text rows=8 maxlength=1000 required></textarea></label><div style="display:none"><input name=website></div><button>送信</button></form>`), []);
async function createAppeal(gid, uid, text) {
  if (!GIDS.includes(gid) || !isId(uid) || !text.trim()) return '入力が正しくありません';
  const g = await bot.guilds.fetch(gid), ban = await g.bans.fetch({ user: uid, force: true }).catch(() => null);
  if (!ban) return 'このサーバーでBANされているアカウントが見つかりません';
  if (db.reqs.some(r => r.gid === gid && r.uid === uid && r.type === 'unban' && r.status === '申請中')) return 'すでに申請済みです。結果をお待ちください';
  db.reqs.unshift({ id: nid(), t: now(), by: '外部フォーム', type: 'unban', uid, reason: '[アピール] ' + text.trim().slice(0, 1000), min: 0, notify: false, status: '申請中', handler: '', result: '', gid, ts: Date.now() });
  db.users.filter(x => allowed(x).includes(gid) && CAN[x.role].includes('approve')).forEach(x => db.msgs.unshift({ id: nid(), t: now(), from: '外部フォーム', to: x.name, subject: '【BAN解除申請】', text: `ユーザーID ${uid} から解除申請が届きました。申請承認を確認してください。`, read: false, gid }));
  save(); log('外部フォーム', 'BAN解除申請', uid, '', gid); return '';
}
app.get('/appeal/:gid', (req, res) => GIDS.includes(req.params.gid) ? res.send(appealPage(req.params.gid)) : res.status(404).send('Not found'));
app.post('/appeal/:gid', async (req, res) => {
  const gid = req.params.gid, h = appealHits[req.ip] = (appealHits[req.ip] || []).filter(t => Date.now() - t < 3.6e6);
  if (!GIDS.includes(gid)) return res.status(404).send('Not found');
  if (req.body.website) return res.send(appealPage(gid, '送信しました。'));
  if (h.length >= 3) return res.status(429).send(appealPage(gid, '短時間に送信しすぎです。しばらくしてからやり直してください'));
  h.push(Date.now());
  let m; try { m = await createAppeal(gid, String(req.body.uid || '').trim(), String(req.body.text || '')); } catch (e) { m = '送信できませんでした。時間をおいてやり直してください'; }
  res.send(appealPage(gid, m || '送信しました。審査の結果は、サーバー運営からお知らせします。'));
});
app.post('/api/appeal', async (req, res) => {
  const k = process.env.APPEAL_SECRET;
  if (!k || req.body.secret !== k) return res.status(403).send('NG');
  try { const m = await createAppeal(String(req.body.gid || ''), String(req.body.uid || '').trim(), String(req.body.text || '')); res.send(m ? 'NG: ' + m : 'OK'); } catch (e) { res.status(500).send('NG'); }
});

// ---- 第B回: 予約投稿・ロール一括付与/剥奪・統計 ----
const schedList = u => {
  const rows = db.sched.filter(x => x.gid === u.gid).sort((a, b) => b.at - a.at).slice(0, 30).map(x => tr([fmtD(x.at), esc('#' + x.cname), esc(x.title), esc(x.by), esc(x.status + (x.err ? `(${x.err})` : '')),
    x.status === '待機' ? `<form method=post action=/embed/cancel style="display:inline"><input type=hidden name=id value=${x.id}><button>取消</button></form>` : '']));
  return fs_('予約投稿の一覧', rows.length ? table(['投稿日時', 'チャンネル', 'タイトル', '登録者', '状態', '操作'], rows) : empty('予約はありません。'));
};
async function schedulePost(req, res, c) {
  const u = req.u, { title, text, color, when } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when || '')) return bad(res, u, '日時の形式が正しくありません');
  const at = Date.parse(when + ':00+09:00');
  if (!(at > Date.now() + 3e4) || at > Date.now() + 366 * 864e5) return bad(res, u, '1年以内の、未来の日時を指定してください');
  db.sched.push({ id: nid(), gid: u.gid, cid: c.id, cname: c.name, title: title.slice(0, 256), text: text.slice(0, 4000), color, at, by: u.name, status: '待機' }); save();
  log(u.name, '予約投稿を登録', c.id, `${title}(${fmtD(at)})`, u.gid);
  res.send(done(u, '予約投稿', `#${c.name} に、${fmtD(at)}(日本時間)の投稿を予約しました`));
}
app.post('/embed/schedule', auth('direct'), run(async (req, res) => {
  const u = req.u, { cid, title, text, color } = req.body, g = await G_(u), c = g.channels.cache.get(cid) || await g.channels.fetch(cid).catch(() => null);
  if (!c || ![0, 5].includes(c.type) || !title || !text || !/^#[0-9a-f]{6}$/i.test(color || '')) return bad(res, u, '入力が正しくありません');
  return schedulePost(req, res, c);
}));
app.post('/embed/cancel', auth('direct'), (req, res) => {
  const x = db.sched.find(y => y.id === +req.body.id && y.gid === req.u.gid && y.status === '待機');
  if (x) { x.status = '取消'; save(); log(req.u.name, '予約投稿を取消', x.cid, x.title, x.gid); }
  res.redirect('/embed');
});
async function runSched() {
  for (const x of db.sched.filter(y => y.status === '待機' && y.at <= Date.now())) {
    if (Date.now() - x.at > 3600e3) { x.status = '失敗'; x.err = '予定時刻を過ぎていたため送信しませんでした'; continue; }
    x.status = '送信中';
    try {
      const g = await bot.guilds.fetch(x.gid), c = await g.channels.fetch(x.cid);
      await c.send({ embeds: [new EmbedBuilder().setTitle(x.title).setDescription(x.text).setColor(parseInt(x.color.slice(1), 16))] });
      x.status = '送信済'; log(x.by, '予約投稿を実行', x.cid, x.title, x.gid);
    } catch (e) { x.status = '失敗'; x.err = e.message; }
  }
  db.sched = db.sched.filter(y => y.status === '待機' || y.status === '送信中' || Date.now() - y.at < 30 * 864e5);
  save();
}
setInterval(() => runSched().catch(() => {}), 20000);

app.get('/bulkrole', auth('direct'), run(async (req, res) => {
  const u = req.u, g = await G_(u), q = String(req.query.q || '').trim(), from = String(req.query.from || '');
  if (g.members.cache.size < g.memberCount) await g.members.fetch();
  let ms = [];
  if (isId(from)) ms = [...(g.roles.cache.get(from)?.members.values() || [])];
  else if (q) { const ids = q.match(/\d{15,22}/g), lq = q.toLowerCase(); ms = ids ? ids.map(i => g.members.cache.get(i)).filter(Boolean) : [...g.members.cache.values()].filter(m => m.displayName.toLowerCase().includes(lq) || m.user.tag.toLowerCase().includes(lq)); }
  ms = ms.filter(m => !m.user.bot).slice(0, 100);
  const all = [...g.roles.cache.values()].filter(r => r.id !== g.id).sort((a, b) => b.position - a.position);
  const given = all.filter(r => !r.managed && r.editable && (u.role === 'owner' || !isDangerous(r)));
  const search = fs_(`メンバーを探す(${gname(u.gid)})`, `<form method=get class=main><label>名前、またはID(複数は改行やカンマ区切り)<input name=q value="${esc(q)}"></label><label>または、ロールで絞り込み<select name=from><option value="">指定しない${all.map(r => `<option value=${r.id}${r.id === from ? ' selected' : ''}>${esc(r.name)}`).join('')}</select></label></form>`);
  const rows = ms.map(m => tr([`<input type=checkbox name=uid value=${m.id}>`, esc(m.displayName), esc(m.id), esc([...m.roles.cache.values()].filter(r => r.id !== g.id).map(r => r.name).slice(0, 6).join(', ') || 'なし')]));
  const act = ms.length ? fs_(`選んだ人にロールを付与・剥奪(${ms.length}人を表示)`, `<form method=post onsubmit="return confirm('選んだ人にロールを操作します。よろしいですか?')">${table(['<input type=checkbox onclick="var c=this.checked;document.querySelectorAll(\'input[name=uid]\').forEach(function(x){x.checked=c})">', '表示名', 'ユーザーID', '所持ロール'], rows)}<br><label>ロール<select name=rid>${given.map(r => `<option value=${r.id}>${esc(r.name)}`).join('')}</select></label><button name=a value=add>付与</button> <button name=a value=remove>剥奪</button></form>`) : ((q || from) ? note('該当するメンバーがいません。') : '');
  res.send(page(u, 'ロール一括', search + act, [...BASE, '照会']));
}));
app.post('/bulkrole', auth('direct'), run(async (req, res) => {
  const u = req.u, uids = [].concat(req.body.uid || []).filter(isId).slice(0, 100), { rid, a } = req.body;
  if (!uids.length || !isId(rid) || !['add', 'remove'].includes(a)) return bad(res, u, '対象の人とロールを選んでください');
  const g = await G_(u), role = g.roles.cache.get(rid);
  if (!role || role.managed || role.id === g.id || !role.editable) return bad(res, u, 'このロールは操作できません');
  if (u.role !== 'owner' && isDangerous(role)) return bad(res, u, '危険な権限(管理者・サーバー管理・BANなど)を含むロールは最高管理者だけが操作できます');
  let ok = 0; const errs = [];
  for (const id of uids) {
    try { const m = await g.members.fetch(id); if (a === 'add') await m.roles.add(role, `一括 by ${u.name}`); else await m.roles.remove(role, `一括 by ${u.name}`); ok++; }
    catch (e) { errs.push(`${id}: ${e.message}`); }
  }
  log(u.name, a === 'add' ? 'ロール一括付与' : 'ロール一括剥奪', role.id, `${role.name} ${ok}/${uids.length}件`, u.gid);
  res.send(done(u, 'ロール一括', `「${role.name}」を${a === 'add' ? '付与' : '剥奪'}しました。成功${ok}件 / 失敗${errs.length}件${errs.length ? '(' + errs.slice(0, 5).join(' / ') + ')' : ''}`));
}));

// 統計(件数だけを記録。メッセージの内容は保存しない)
const dayStat = (gid, k = now().slice(0, 10)) => ((db.stats[gid] ??= {})[k] ??= { join: 0, leave: 0, ch: {}, au: {} });
const countMsg = m => { const d = dayStat(m.guild.id); d.ch[m.channelId] = (d.ch[m.channelId] || 0) + 1; d.au[m.author.id] = 1; watchHit(m.guild.id, m.author.id, `発言(#${m.channel ? m.channel.name : m.channelId})`); };
bot.on(Events.GuildMemberAdd, m => { if (!GIDS.includes(m.guild.id)) return; dayStat(m.guild.id).join++; onJoin(m).catch(() => {}); });
bot.on(Events.GuildMemberRemove, m => { if (GIDS.includes(m.guild.id)) dayStat(m.guild.id).leave++; });
setInterval(() => { const lim = fmtD(Date.now() - 31 * 864e5).slice(0, 10); for (const g of Object.values(db.stats)) for (const k of Object.keys(g)) if (k < lim) delete g[k]; save(); }, 6e4);
app.get('/stats', auth(), run(async (req, res) => {
  const u = req.u, g = await G_(u), days = [1, 7, 30].includes(+req.query.days) ? +req.query.days : 7, st = db.stats[u.gid] || {};
  const ds = Array.from({ length: days }, (_, i) => fmtD(Date.now() - i * 864e5).slice(0, 10)).map(k => [k, st[k] || { join: 0, leave: 0, ch: {}, au: {} }]);
  const cnt = d => Object.values(d.ch).reduce((a, n) => a + n, 0), ch = {}, au = new Set();
  ds.forEach(([, d]) => { for (const [c, n] of Object.entries(d.ch)) ch[c] = (ch[c] || 0) + n; Object.keys(d.au).forEach(x => au.add(x)); });
  const members = g.memberCount || 0, total = ds.reduce((a, [, d]) => a + cnt(d), 0);
  const sum = tr(['期間の参加人数', ds.reduce((a, [, d]) => a + d.join, 0)]) + tr(['期間の退出人数', ds.reduce((a, [, d]) => a + d.leave, 0)]) + tr(['メッセージ数', total]) + tr(['発言した人数', au.size]) + tr(['現在のメンバー数', members]) + tr(['アクティブ率(発言した人数 ÷ メンバー数)', members ? (au.size / members * 100).toFixed(1) + ' %' : '-']);
  const rank = Object.entries(ch).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n], i) => tr([i + 1, esc('#' + (g.channels.cache.get(c)?.name || c)), n]));
  const sel = `<form method=get><label>期間<select name=days onchange="this.form.submit()">${[[1, '今日'], [7, '7日間'], [30, '30日間']].map(([d, l]) => `<option value=${d}${d === days ? ' selected' : ''}>${l}`).join('')}</select></label></form>`;
  res.send(page(u, '統計', note('集計は、この機能を反映した時点から始まります。記録するのは件数だけで、メッセージの内容は保存しません。') + fs_(`サーバーの統計(${gname(u.gid)} / 直近${days}日)`, sel + table(['項目', '値'], [sum])) +
    fs_('チャンネル別メッセージ数のランキング', rank.length ? table(['順位', 'チャンネル', 'メッセージ数'], rank) : empty('まだ記録がありません。')) +
    fs_('日別', table(['日付', '参加', '退出', 'メッセージ数', '発言した人数'], ds.map(([k, d]) => tr([k, d.join, d.leave, cnt(d), Object.keys(d.au).length]))))));
}));

// ---- 第C回・第D回: 警告アラート・要監視・荒らし対策・VC履歴・自動凍結・バックアップ・端末承認 ----
const unack = u => db.alerts.filter(a => a.gid === u.gid && !a.ack).length;
const rl = {}, once = (k, ms = 6e4) => { if (rl[k] && Date.now() - rl[k] < ms) return false; rl[k] = Date.now(); return true; };
function alertStaff(gid, kind, uid, text) {
  db.alerts.unshift({ id: nid(), gid, t: now(), kind, uid, text, ack: false }); db.alerts = db.alerts.slice(0, 500);
  const t = now(); db.users.filter(x => allowed(x).includes(gid)).forEach(x => db.msgs.unshift({ id: nid(), t, from: 'システム', to: x.name, subject: `【${kind}】`, text, read: false, gid }));
  const ch = (db.cfg[gid] || {}).alertChan;
  if (ch) bot.guilds.fetch(gid).then(g => g.channels.fetch(ch)).then(c => c.send(`🚨 【${kind}】${text}`)).catch(() => {});
  save();
}
const watchHit = (gid, uid, what) => { const w = (db.watch[gid] || {})[uid]; if (w && once(`${gid}:${uid}:${what.slice(0, 4)}`)) alertStaff(gid, '要監視ユーザー', uid, `${what}(メモ: ${w.note || '-'})`); };

// 参加時: 新規アカウント対策・レイド検知・同じ招待リンクからの連続参加・酷似アカウント
const joins = {}, invCache = {}, panelVc = {};
const norm = x => String(x).toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]/g, '');
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
const alike = (x, y) => { const a = norm(x.username), b = norm(y.username); return (a.length >= 4 && b.length >= 4 && 1 - lev(a, b) / Math.max(a.length, b.length) >= 0.8) || (!!x.avatar && x.avatar === y.avatar); };
async function snapInvites(g) { try { const inv = await g.invites.fetch(); invCache[g.id] = new Map(inv.map(i => [i.code, i.uses || 0])); return inv; } catch (e) { return null; } }
bot.on(Events.ClientReady, async () => { for (const gid of GIDS) { const g = await bot.guilds.fetch(gid).catch(() => null); if (g) await snapInvites(g); } });
async function onJoin(m) {
  const gid = m.guild.id, c = db.cfg[gid] || {}, t0 = Date.now();
  watchHit(gid, m.id, '参加');
  if (c.minAge > 0 && t0 - m.user.createdTimestamp < c.minAge * 864e5) {
    const age = ((t0 - m.user.createdTimestamp) / 864e5).toFixed(1), kick = c.ageAction === 'kick';
    try { if (kick) await m.kick(`新規アカウント(${age}日)`); else if (c.qRole) await m.roles.add(c.qRole, '新規アカウント'); } catch (e) {}
    alertStaff(gid, '新規アカウント', m.id, `${m.user.tag} は、アカウント作成から${age}日です(${kick ? 'キックしました' : c.qRole ? '隔離ロールを付与しました' : '対応は未設定です'})`);
  }
  const arr = (joins[gid] ??= []); arr.push({ ts: t0, id: m.id, u: m.user, code: null }); while (arr.length && t0 - arr[0].ts > 3600e3) arr.shift();
  if (c.raidN > 0 && arr.filter(x => t0 - x.ts < (c.raidSec || 60) * 1000).length >= c.raidN && once(`raid:${gid}`, 5 * 6e4)) {
    try { await m.guild.disableInvites(true); (db.emerg[gid] ??= {}).gate = { at: now(), by: 'システム(レイド検知)' }; } catch (e) {}
    alertStaff(gid, 'レイド検知', m.id, `${c.raidSec || 60}秒以内に${c.raidN}人以上が参加したため、招待リンクを一時停止しました。解除は最高管理者の「緊急対応」から行ってください`);
  }
  const before = invCache[gid], inv = await snapInvites(m.guild);
  if (before && inv) {
    const used = inv.find(i => (i.uses || 0) > (before.get(i.code) || 0));
    if (used) { arr[arr.length - 1].code = used.code; const same = arr.filter(x => x.code === used.code && t0 - x.ts < 10 * 6e4); if (same.length >= 3 && once(`inv:${gid}:${used.code}`, 10 * 6e4)) alertStaff(gid, '同じ招待リンクから連続参加', m.id, `招待コード ${used.code}(作成者: ${used.inviter ? used.inviter.tag : '不明'})から、10分以内に${same.length}人が参加しました`); }
  }
  const sims = arr.filter(x => x.id !== m.id && alike(m.user, x.u));
  if (sims.length >= 2 && once(`sim:${gid}:${norm(m.user.username)}`, 10 * 6e4)) alertStaff(gid, '酷似アカウント', m.id, `${m.user.tag} と、名前またはアイコンが酷似したアカウントが、1時間以内に${sims.length}人参加しています(${sims.map(x => x.u.tag).slice(0, 5).join(', ')})`);
}
bot.on(Events.GuildMemberUpdate, (o, n) => { try { if (GIDS.includes(n.guild.id) && o.displayName !== n.displayName) watchHit(n.guild.id, n.id, `名前変更: ${o.displayName} → ${n.displayName}`); } catch (e) {} });

// VC履歴(入室・退出・移動・切断)
bot.on(Events.VoiceStateUpdate, async (o, n) => {
  const gid = n.guild.id; if (!GIDS.includes(gid)) return;
  const uid = n.id, name = n.member ? n.member.displayName : uid;
  const kind = !o.channelId && n.channelId ? '入室' : o.channelId && !n.channelId ? '退出' : o.channelId && n.channelId && o.channelId !== n.channelId ? '移動' : null;
  if (!kind) return;
  let note = '';
  if (kind !== '入室') {
    const p = panelVc[`${gid}:${uid}`];
    if (p && Date.now() - p.ts < 5000) note = `${p.by}が管理画面から切断`;
    else try { const e = (await n.guild.fetchAuditLogs({ type: kind === '退出' ? 27 : 26, limit: 1 })).entries.first(); if (e && Date.now() - e.createdTimestamp < 3000 && e.executorId !== uid) note = `${e.executor ? e.executor.tag : e.executorId}が実行した可能性があります`; } catch (e) {}
  }
  db.vclog.unshift({ ts: Date.now(), t: now(), gid, uid, name, kind, from: o.channel ? o.channel.name : '', to: n.channel ? n.channel.name : '', note }); db.vclog = db.vclog.slice(0, 2000);
  if (kind !== '退出') watchHit(gid, uid, `VC${kind}(${n.channel ? n.channel.name : ''})`);
});

// スタッフの異常操作の自動凍結(最高管理者は対象外)
const acts = {};
function freezeCheck(name, kind, limit, reason, gid) {
  const a = (acts[`${name}:${kind}`] ??= []); a.push(Date.now()); while (a.length && Date.now() - a[0] > 60e3) a.shift();
  const u = db.users.find(x => x.name === name);
  if (!u || u.role === 'owner' || u.frozen || a.length < limit) return;
  u.frozen = { at: now(), reason }; save(); log('システム', 'アカウント凍結', name, reason, gid);
  const t = now(); db.users.filter(x => x.role === 'owner').forEach(x => db.msgs.unshift({ id: nid(), t, from: 'システム', to: x.name, subject: '【アカウント凍結】', text: `${name} のアカウントを自動で凍結しました(${reason})。アカウント管理から解除できます。`, read: false, gid }));
  alertStaff(gid, 'アカウント凍結', '', `${name} を凍結しました(${reason})`);
}
const auditBy = async (guild, type) => { try { const e = (await guild.fetchAuditLogs({ type, limit: 1 })).entries.first(); return e && Date.now() - e.createdTimestamp < 5000 ? e.executorId : null; } catch (e) { return null; } };
const staffOf = id => id && db.users.find(x => x.discordId === id);
const chanEvt = async c => { if (!c.guild || !GIDS.includes(c.guild.id)) return; const s = staffOf(await auditBy(c.guild, 12)) || staffOf(await auditBy(c.guild, 11)); if (s) freezeCheck(s.name, 'chan', 3, '短時間に複数のチャンネルを削除・変更しました', c.guild.id); };
bot.on(Events.ChannelDelete, chanEvt);
bot.on(Events.ChannelUpdate, (o, c) => chanEvt(c));
bot.on(Events.GuildBanAdd, async b => { if (!GIDS.includes(b.guild.id)) return; const s = staffOf(await auditBy(b.guild, 22)); if (s) freezeCheck(s.name, 'ban', 3, '1分間に3人以上をBANしました', b.guild.id); });
app.post('/accounts/unfreeze', auth('accounts'), (req, res) => {
  const t = db.users.find(x => x.id === +req.body.id);
  if (t && t.frozen) { delete t.frozen; Object.keys(acts).filter(k => k.startsWith(t.name + ':')).forEach(k => delete acts[k]); save(); log(req.u.name, '凍結解除', t.name); }
  res.redirect('/accounts');
});

// 警告アラート・要監視・荒らし対策設定・VC履歴
app.get('/alerts', auth(), (req, res) => {
  const rows = db.alerts.filter(a => a.gid === req.u.gid).slice(0, 100).map(a => tr([esc(a.t), esc(a.kind), esc(a.uid || '-'), esc(a.text), a.ack ? '確認済み' : `<form method=post action=/alerts/ack style="display:inline"><input type=hidden name=id value=${a.id}><button>確認済みにする</button></form>`]));
  res.send(page(req.u, '警告アラート', fs_(`警告アラート(${gname(req.u.gid)})`, `<form method=post action=/alerts/ack><input type=hidden name=id value=all><button>すべて確認済みにする</button></form>` + (rows.length ? table(['日時', '種類', 'ユーザーID', '内容', '状態'], rows) : empty('アラートはありません。')))));
});
app.post('/alerts/ack', auth(), (req, res) => { db.alerts.filter(a => a.gid === req.u.gid && (req.body.id === 'all' || a.id === +req.body.id)).forEach(a => { a.ack = true; }); save(); res.redirect('/alerts'); });
app.get('/watch', auth('direct'), (req, res) => {
  const rows = Object.entries(db.watch[req.u.gid] || {}).map(([id, v]) => tr([esc(id), esc(v.note || '-'), esc(v.by), esc(v.at), `<form method=post action=/watch/del style="display:inline"><input type=hidden name=uid value=${id}><button>解除</button></form>`]));
  res.send(page(req.u, '要監視ユーザー', fs_(`要監視ユーザーの登録(${gname(req.u.gid)})`, `<form method=post class=main><label>ユーザーID<input name=uid required pattern="\\d{15,22}" inputmode=numeric></label><label>メモ(理由)<input name=note maxlength=100></label></form>${note('登録した人が、参加・発言・VC入室・名前変更をすると、警告アラートが出ます(同じ種類は1分に1回)。')}`) + fs_('登録中のユーザー', rows.length ? table(['ユーザーID', 'メモ', '登録者', '登録日時', '操作'], rows) : empty('登録はありません。')), FORM));
});
app.post('/watch', auth('direct'), (req, res) => {
  const { uid, note: nt } = req.body; if (!isId(uid) || !req.u.gid) return bad(res, req.u, '入力が正しくありません');
  (db.watch[req.u.gid] ??= {})[uid] = { note: String(nt || '').slice(0, 100), by: req.u.name, at: now() }; save(); log(req.u.name, '要監視に登録', uid, nt, req.u.gid); res.redirect('/watch');
});
app.post('/watch/del', auth('direct'), (req, res) => { if (db.watch[req.u.gid]) delete db.watch[req.u.gid][req.body.uid]; save(); log(req.u.name, '要監視を解除', req.body.uid, '', req.u.gid); res.redirect('/watch'); });
app.get('/guard', auth('direct'), run(async (req, res) => {
  const u = req.u, g = await G_(u), c = db.cfg[u.gid] || {}, own = can(u, 'release'); await g.channels.fetch();
  const ro = [...g.roles.cache.values()].filter(r => r.id !== g.id && !r.managed).sort((a, b) => b.position - a.position).map(r => `<option value=${r.id}${r.id === c.qRole ? ' selected' : ''}>${esc(r.name)}`).join('');
  const co = [...chans(g).values()].map(x => `<option value=${x.id}${x.id === c.alertChan ? ' selected' : ''}>#${esc(x.name)}`).join('');
  res.send(page(u, '荒らし対策', fs_(`荒らし対策の設定(${gname(u.gid)})`, (own ? note('変更はすぐに反映されます。') : note('変更できるのは最高管理者だけです。')) +
    `<form method=post class=main><label>アカウント作成から何日未満を対象にするか(0で無効)<input name=minAge type=number min=0 max=365 value=${+c.minAge || 0}></label><label>対象アカウントの処理<select name=ageAction><option value=role${c.ageAction !== 'kick' ? ' selected' : ''}>隔離ロールを付与<option value=kick${c.ageAction === 'kick' ? ' selected' : ''}>キックする</select></label><label>隔離ロール<select name=qRole><option value="">指定しない${ro}</select></label><label>レイド検知: 何秒以内に<input name=raidSec type=number min=5 max=3600 value=${+c.raidSec || 60}></label><label>レイド検知: 何人以上が参加したら招待を停止するか(0で無効)<input name=raidN type=number min=0 max=1000 value=${+c.raidN || 0}></label><label>アラートを投稿するチャンネル(任意)<select name=alertChan><option value="">投稿しない${co}</select></label></form>`), own ? FORM : BASE));
}));
app.post('/guard', auth('release'), (req, res) => {
  const n = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.floor(+v) || d)), b = req.body;
  db.cfg[req.u.gid] = { minAge: n(b.minAge, 0, 365, 0), ageAction: b.ageAction === 'kick' ? 'kick' : 'role', qRole: isId(b.qRole) ? b.qRole : '', raidSec: n(b.raidSec, 5, 3600, 60), raidN: n(b.raidN, 0, 1000, 0), alertChan: isId(b.alertChan) ? b.alertChan : '' };
  save(); log(req.u.name, '荒らし対策の設定を変更', '', JSON.stringify(db.cfg[req.u.gid]), req.u.gid); res.send(done(req.u, '荒らし対策', '保存しました。すぐに反映されます。'));
});
app.get('/vclog', auth(), (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const rows = db.vclog.filter(v => v.gid === req.u.gid && (!q || v.uid === q || v.name.toLowerCase().includes(q))).slice(0, 200).map(v => tr([esc(v.t), esc(v.name), esc(v.uid), esc(v.kind), esc(v.kind === '移動' ? `${v.from} → ${v.to}` : v.kind === '入室' ? v.to : v.from), esc(v.note || '-')]));
  res.send(page(req.u, 'VC履歴', fs_(`VCの入退室履歴(${gname(req.u.gid)} / 新しい順)`, `<form method=get class=main><label>名前またはIDで絞り込み<input name=q value="${esc(q)}"></label></form>` + (rows.length ? table(['日時', '名前', 'ユーザーID', '動作', 'VC', '備考'], rows) : empty('記録はありません。'))), [...BASE, '照会']));
});

// バックアップ(スナップショット)と復元 — 最高管理者のみ
const SNAPDIR = 'data/snapshots'; fs.mkdirSync(SNAPDIR, { recursive: true });
async function takeSnapshot(gid, by) {
  const g = await bot.guilds.fetch(gid); await g.channels.fetch(); await g.roles.fetch();
  const roles = [...g.roles.cache.values()].filter(r => r.id !== g.id && !r.managed).map(r => ({ id: r.id, name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield.toString(), position: r.position }));
  const channels = [...g.channels.cache.values()].filter(c => [0, 2, 4, 5, 13, 15].includes(c.type)).map(c => ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId || null, position: c.rawPosition, topic: c.topic || null, nsfw: !!c.nsfw, rateLimitPerUser: c.rateLimitPerUser || 0, bitrate: c.bitrate || null, userLimit: c.userLimit || 0,
    overwrites: [...(c.permissionOverwrites ? c.permissionOverwrites.cache.values() : [])].map(o => ({ id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })) }));
  const id = nid();
  fs.writeFileSync(`${SNAPDIR}/${gid}-${id}.json`, JSON.stringify({ gid, name: g.name, at: now(), by, roles, channels, roleNames: Object.fromEntries(roles.map(r => [r.id, r.name])) }));
  db.snaps.unshift({ id, gid, ts: Date.now(), at: now(), by, roles: roles.length, channels: channels.length });
  const mine = db.snaps.filter(x => x.gid === gid), old = mine.slice(30);
  old.forEach(x => { try { fs.unlinkSync(`${SNAPDIR}/${gid}-${x.id}.json`); } catch (e) {} }); db.snaps = db.snaps.filter(x => !old.includes(x));
  save(); return id;
}
setInterval(() => GIDS.forEach(gid => { const l = db.snaps.find(x => x.gid === gid); if (!l || Date.now() - l.ts > 864e5) takeSnapshot(gid, 'システム(自動)').catch(() => {}); }), 36e5);
async function restoreSnapshot(gid, id, o, by) {
  const snap = JSON.parse(fs.readFileSync(`${SNAPDIR}/${gid}-${id}.json`, 'utf8')), g = await bot.guilds.fetch(gid);
  await g.channels.fetch(); await g.roles.fetch();
  const r = { rolesMade: 0, rolesFixed: 0, chMade: 0, permFixed: 0, errs: [] }, byName = n => [...g.roles.cache.values()].find(x => x.name === n), cur = () => [...g.channels.cache.values()];
  for (const x of snap.roles) {
    const ex = byName(x.name);
    try {
      if (!ex && o.roles) { await g.roles.create({ name: x.name, color: x.color, hoist: x.hoist, mentionable: x.mentionable, permissions: BigInt(x.permissions), reason: `復元 by ${by}` }); r.rolesMade++; }
      else if (ex && o.rolePerm && ex.editable && ex.permissions.bitfield.toString() !== x.permissions) { await ex.setPermissions(BigInt(x.permissions), `復元 by ${by}`); r.rolesFixed++; }
    } catch (e) { r.errs.push(`ロール${x.name}: ${e.message}`); }
  }
  await g.roles.fetch();
  const rid = i => { if (i === snap.gid) return g.id; const n = snap.roleNames[i], z = n && byName(n); return z ? z.id : i; };
  const ow = c => c.overwrites.map(x => ({ id: x.type === 0 ? rid(x.id) : x.id, type: x.type, allow: BigInt(x.allow), deny: BigInt(x.deny) }));
  const pName = c => c.parentId ? ((snap.channels.find(x => x.id === c.parentId) || {}).name || null) : null;
  const match = c => cur().find(x => x.name === c.name && x.type === c.type && ((x.parent && x.parent.name) || null) === pName(c));
  const order = snap.channels.filter(c => c.type === 4).concat(snap.channels.filter(c => c.type !== 4));
  if (o.channels) for (const c of order) {
    if (match(c)) continue;
    const pn = pName(c), parent = pn ? (cur().find(x => x.type === 4 && x.name === pn) || {}).id : undefined;
    try { await g.channels.create({ name: c.name, type: c.type, parent, topic: c.topic || undefined, nsfw: c.nsfw, rateLimitPerUser: c.rateLimitPerUser || undefined, bitrate: c.bitrate || undefined, userLimit: c.userLimit || undefined, permissionOverwrites: ow(c), reason: `復元 by ${by}` }); r.chMade++; }
    catch (e) { r.errs.push(`チャンネル${c.name}: ${e.message}`); }
  }
  if (o.chPerm) for (const c of order) { const ex = match(c); if (ex && ex.permissionOverwrites) try { await ex.permissionOverwrites.set(ow(c), `復元 by ${by}`); r.permFixed++; } catch (e) { r.errs.push(`権限${c.name}: ${e.message}`); } }
  return r;
}
app.get('/snap', auth('release'), (req, res) => {
  const rows = db.snaps.filter(x => x.gid === req.u.gid).map(x => tr([esc(x.at), esc(x.by), `${x.roles}個 / ${x.channels}個`,
    `<a class=b href=/snap/${x.id}/download>ダウンロード</a> <form method=post action=/snap/${x.id}/restore onsubmit="return confirm('このバックアップから復元します。よろしいですか?')"><label><input type=checkbox name=roles value=1 checked> 不足しているロールを作り直す</label><label><input type=checkbox name=rolePerm value=1> 既存ロールの権限を保存時に戻す</label><label><input type=checkbox name=channels value=1 checked> 不足しているチャンネル・カテゴリを作り直す</label><label><input type=checkbox name=chPerm value=1> 既存チャンネルの権限設定を保存時に戻す</label>${PW}<button>復元する</button></form>`]));
  res.send(page(req.u, 'バックアップ', fs_(`サーバー構成のバックアップ(${gname(req.u.gid)})`, note('チャンネル・カテゴリ・ロールとその権限を、JSONで保存します。復元は、消えたものを作り直し、権限を保存時の状態に戻します(削除はしません)。復元したロールは、順位が一番下になります。毎日1回、自動でも保存されます(30件まで)。') + btn('/snap', '今すぐバックアップする', 'いまの構成を保存します。よろしいですか?')) + fs_('保存済みのバックアップ', rows.length ? table(['日時', '作成者', 'ロール / チャンネル', '操作'], rows) : empty('まだありません。'))));
});
app.post('/snap', auth('release'), run(async (req, res) => { const id = await takeSnapshot(req.u.gid, req.u.name); log(req.u.name, 'バックアップ作成', String(id), '', req.u.gid); res.redirect('/snap'); }));
app.get('/snap/:id/download', auth('release'), (req, res) => {
  const x = db.snaps.find(y => y.id === +req.params.id && y.gid === req.u.gid); if (!x) return res.redirect('/snap');
  res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename=snapshot-${x.id}.json`);
  res.send(fs.readFileSync(`${SNAPDIR}/${x.gid}-${x.id}.json`, 'utf8'));
});
app.post('/snap/:id/restore', auth('release'), run(async (req, res) => {
  const u = req.u, x = db.snaps.find(y => y.id === +req.params.id && y.gid === u.gid);
  if (!x) return bad(res, u, 'バックアップが見つかりません');
  if (!pwOk(u, req)) return bad(res, u, 'パスワードが違います(危険操作はパスワードの再入力が必要です)');
  const b = req.body, r = await restoreSnapshot(u.gid, x.id, { roles: !!b.roles, rolePerm: !!b.rolePerm, channels: !!b.channels, chPerm: !!b.chPerm }, u.name);
  log(u.name, 'バックアップから復元', String(x.id), `ロール作成${r.rolesMade}/権限修正${r.rolesFixed}/チャンネル作成${r.chMade}/権限修正${r.permFixed}/失敗${r.errs.length}`, u.gid);
  res.send(done(u, '復元', `ロール作成${r.rolesMade}件、ロール権限の修正${r.rolesFixed}件、チャンネル作成${r.chMade}件、チャンネル権限の修正${r.permFixed}件。失敗${r.errs.length}件${r.errs.length ? '(' + r.errs.slice(0, 5).join(' / ') + ')' : ''}`));
}));

// 端末の承認制(ブラウザごとの識別cookie)。最高管理者は対象外
const devToken = (req, res) => { let t = ((req.headers.cookie || '').match(/(?:^|; )did=([a-f0-9]{32})/) || [])[1]; if (!t) { t = crypto.randomBytes(16).toString('hex'); res.cookie('did', t, { httpOnly: true, sameSite: 'lax', secure: !!req.secure, maxAge: 400 * 864e5 }); } return t; };
function deviceBlock(req, res, u) {
  if (!u.devGuard || u.role === 'owner') return null;
  const t = devToken(req, res);
  if ((u.devs || []).some(d => d.t === t)) return null;
  if (!db.devreq.some(r => r.uid === u.id && r.t === t && r.status === '承認待ち')) {
    db.devreq.unshift({ id: nid(), uid: u.id, name: u.name, t, ua: String(req.headers['user-agent'] || '').slice(0, 200), ip: req.ip, at: now(), status: '承認待ち' }); db.devreq = db.devreq.slice(0, 200);
    const tm = now(); db.users.filter(x => x.role === 'owner').forEach(x => GIDS.forEach(gid => db.msgs.unshift({ id: nid(), t: tm, from: 'システム', to: x.name, subject: '【未登録の端末からのログイン】', text: `${u.name} が、未登録の端末からログインしようとしました。アカウント管理で承認または却下してください。`, read: false, gid })));
    save(); log('システム', '未登録の端末からのログイン', u.name, req.ip);
  }
  return 'この端末は未登録です。最高管理者の承認をお待ちください(承認後に、もう一度ログインしてください)。';
}
const devPending = () => { const rows = db.devreq.filter(r => r.status === '承認待ち').map(r => tr([esc(r.name), esc(r.at), esc(r.ip), esc(r.ua), `<form method=post action=/devices/${r.id} style="display:inline"><button name=a value=ok>承認</button> <button name=a value=no>却下</button></form>`])); return fs_('未登録の端末の承認待ち', rows.length ? table(['アカウント', '日時', 'IPアドレス', 'ブラウザ情報', '操作'], rows) : empty('承認待ちの端末はありません。')); };
app.post('/devices/reset', auth('accounts'), (req, res) => { const t = db.users.find(x => x.id === +req.body.id); if (t) { t.devs = []; save(); log(req.u.name, '登録端末をリセット', t.name); } res.redirect('/accounts'); });
app.post('/devices/:id', auth('accounts'), (req, res) => {
  const r = db.devreq.find(x => x.id === +req.params.id && x.status === '承認待ち'); if (!r) return res.redirect('/accounts');
  if (req.body.a === 'ok') { const t = db.users.find(x => x.id === r.uid); if (t) (t.devs ??= []).push({ t: r.t, ua: r.ua, ip: r.ip, at: now() }); r.status = '承認済'; } else r.status = '却下';
  save(); log(req.u.name, `端末${r.status}`, r.name, r.ip); res.redirect('/accounts');
});

// ---- 全メッセージ管理(最高管理者のみ・他の人のメッセージも削除可) ----
app.get('/allmsgs', auth('delMsg'), (req, res) => {
  const seen = new Set();
  const rows = db.msgs.filter(m => m.gid === req.u.gid).filter(m => !m.grp || (!seen.has(m.grp) && seen.add(m.grp))).slice(0, 200).map(m => tr([esc(m.t), esc(m.from),
    m.grp ? `全員(${db.msgs.filter(x => x.grp === m.grp).length}人)` : esc(m.to), esc(m.subject), esc(m.text.slice(0, 40)),
    `<form method=post action=/allmsgs/${m.id}/delete onsubmit="return confirm('このメッセージを削除しますか?')">${PW}<button>削除</button></form>`]));
  res.send(page(req.u, '全メッセージ管理', fs_(`管理者間通信の全メッセージ(${gname(req.u.gid)})`, rows.length ? table(['日時', '差出人', '宛先', '件名', '本文(一部)', '操作'], rows) : empty('メッセージはありません。'))));
});
app.post('/allmsgs/:id/delete', auth('delMsg'), (req, res) => {
  if (!pwOk(req.u, req)) return bad(res, req.u, 'パスワードが違います(危険操作はパスワードの再入力が必要です)');
  const m = db.msgs.find(x => x.id === +req.params.id);
  if (m) {
    const gone = m.grp ? db.msgs.filter(x => x.grp === m.grp) : [m];
    db.msgs = db.msgs.filter(x => !gone.includes(x)); save();
    log(req.u.name, 'メッセージ削除(全体)', m.from, `${m.subject}(${gone.length}件)`, m.gid);
  }
  res.redirect('/allmsgs');
});

// ---- アカウント管理(最高管理者のみ) ----
app.get('/accounts', auth('accounts'), (req, res) => {
  const rows = db.users.map(x => tr([esc(x.name) + (x.frozen ? ` <b>【凍結中: ${esc(x.frozen.reason)}】</b><form method=post action=/accounts/unfreeze style="display:inline"><input type=hidden name=id value=${x.id}><button>凍結を解除</button></form>` : ''), ROLES[x.role], esc(x.discordId || '-'), x.mfa ? `必須(${esc(x.email ? maskMail(x.email) : '-')})` : '-', x.devGuard ? `承認制(登録${(x.devs || []).length}台) <form method=post action=/devices/reset style="display:inline"><input type=hidden name=id value=${x.id}><button>登録をリセット</button></form>` : '-', x.role === 'owner' ? '全て' : esc(allowed(x).map(gname).join(', ') || 'なし'), x.id === req.u.id ? '(自分)' : `<form method=post action=/accounts/delete onsubmit="return confirm('このアカウントを削除しますか?')"><input type=hidden name=id value=${x.id}>${PW}<button>削除</button></form>`]));
  res.send(page(req.u, 'アカウント管理', fs_('追加 / 更新(既存の名前なら権限・パスワードを更新)', `<form method=post><label>アカウント名(英数字3〜20)<input name=name required></label><label>パスワード(8文字以上。更新時は空欄で変更なし)<input name=pass type=password autocomplete=new-password></label><label>DiscordユーザーID(任意。緊急招集・新着通知に使います)<input name=did inputmode=numeric></label><label>メールアドレス(2段階認証用。空欄なら変更しません)<input name=email type=email></label><label>メールによる2段階認証<select name=mfa><option value=keep>変更しない(新規は不要)<option value=on>必須にする<option value=off>不要にする</select></label><label>未登録の端末からのログイン<select name=devg><option value=keep>変更しない(新規は不要)<option value=on>最高管理者の承認制にする<option value=off>制限しない</select></label><label>(2段階認証を不要にするときだけ)あなたのパスワード<input type=password name=pw autocomplete=current-password></label><label>権限<select name=role>${Object.entries(ROLES).map(([k, v]) => `<option value=${k}>${v}`).join('')}</select></label><div>操作できるサーバー(最高管理者は全サーバー): ${GIDS.map(g => `<label><input type=checkbox name=g value="${g}"> ${esc(gname(g))}</label> `).join('')}</div><br><button>保存</button></form>`) + devPending() + fs_('メール送信のテスト(2段階認証用)', `${note(MAIL_OK ? 'Gmailの送信設定は有効です。2段階認証を必須にする前に、テストメールが届くか確認してください。' : '未設定です(環境変数 GMAIL_USER と GMAIL_APP_PASSWORD が必要です)')}<form method=post action=/mfa/test><label>送信先<input name=email type=email required></label><button>テストメールを送る</button></form>`) + fs_('アカウント一覧', table(['アカウント', '権限', 'DiscordID', '2段階認証', '端末承認', '操作できるサーバー', '操作'], rows))));
});
app.post('/accounts', auth('accounts'), (req, res) => {
  const { name, pass, role } = req.body, ex = db.users.find(x => x.name === name);
  const gs = [].concat(req.body.g || []).filter(g => GIDS.includes(g)), did = String(req.body.did || '').trim();
  const email = String(req.body.email || '').trim(), mfa = ['on', 'off'].includes(req.body.mfa) ? req.body.mfa : 'keep', devg = ['on', 'off'].includes(req.body.devg) ? req.body.devg : 'keep';
  if (!/^[\w-]{3,20}$/.test(name || '') || !ROLES[role] || (pass && pass.length < 8) || (!ex && !pass) || (ex && ex.id === req.u.id && role !== 'owner') || (role !== 'owner' && !gs.length) || (did && !isId(did)) || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    return bad(res, req.u, '入力が正しくありません(自分自身の権限は下げられません / 最高管理者以外は操作できるサーバーを1つ以上選んでください)');
  const mail = email || (ex && ex.email) || '';
  if (mfa === 'on' && !mail) return bad(res, req.u, '2段階認証を必須にするには、メールアドレスが必要です');
  if (mfa === 'on' && !MAIL_OK) return bad(res, req.u, 'メール送信が未設定のため、2段階認証を必須にできません(GMAIL_USER / GMAIL_APP_PASSWORD)');
  if (mfa === 'off' && ex && ex.mfa && !pwOk(req.u, req)) return bad(res, req.u, '2段階認証を不要にするには、あなたのパスワードの入力が必要です');
  if (ex) { ex.role = role; ex.guilds = gs; if (did) ex.discordId = did; if (email) ex.email = email; if (mfa !== 'keep') ex.mfa = mfa === 'on'; if (devg !== 'keep') ex.devGuard = devg === 'on'; if (pass) ex.hash = bcrypt.hashSync(pass, 10); }
  else db.users.push({ id: nid(), name, hash: bcrypt.hashSync(pass, 10), role, guilds: gs, discordId: did || undefined, email: email || undefined, mfa: mfa === 'on', devGuard: devg === 'on' });
  save(); log(req.u.name, ex ? 'アカウント更新' : 'アカウント追加', name, ROLES[role]); res.redirect('/accounts');
});
app.post('/accounts/delete', auth('accounts'), (req, res) => {
  if (!pwOk(req.u, req)) return bad(res, req.u, 'パスワードが違います(危険操作はパスワードの再入力が必要です)');
  const t = db.users.find(x => x.id === +req.body.id);
  if (!t || t.id === req.u.id) return bad(res, req.u, '削除できません(自分自身は削除できません)');
  db.users = db.users.filter(x => x.id !== t.id); save();
  log(req.u.name, 'アカウント削除', t.name); res.redirect('/accounts');
});

// ---- パスワード変更 ----
app.get('/password', auth(), (req, res) => res.send(page(req.u, 'パスワード変更', fs_('パスワード変更', '<form method=post><label>現在のパスワード<input name=old type=password autocomplete=current-password required></label><label>新しいパスワード(8文字以上)<input name=pass type=password autocomplete=new-password required></label><button>変更</button></form>'))));
app.post('/password', auth(), (req, res) => {
  if (!bcrypt.compareSync(req.body.old || '', req.u.hash) || (req.body.pass || '').length < 8) return bad(res, req.u, '現在のパスワードが違うか、新しいパスワードが短すぎます');
  db.users.find(x => x.id === req.u.id).hash = bcrypt.hashSync(req.body.pass, 10); save(); log(req.u.name, 'パスワード変更'); res.send(done(req.u, 'パスワード変更', '変更しました'));
});

const recentIds = u => `<datalist id=ri>${[...new Set([...db.cases.filter(c => c.gid === u.gid).map(c => c.uid), ...db.dms.filter(d => visDm(u, d)).map(d => d.uid)])].slice(0, 30).map(i => `<option value=${i}>`).join('')}</datalist>`;
function notifyOwners(by, type, uid, reason, min, gid) {
  const a = db.users.find(x => x.name === by);
  if (!a || a.role === 'owner' || !(['ban', 'kick', 'unban', 'untimeout'].includes(type) || (type === 'timeout' && min > 60))) return;
  const text = `${by}が、${pun(type, min)}を実行しました(サーバー: ${gname(gid)} / 対象ID: ${uid} / 理由: ${reason || 'なし'})`, t = now();
  db.users.filter(x => x.role === 'owner').forEach(x => { db.msgs.unshift({ id: nid(), t, from: 'システム', to: x.name, subject: '【処分の実行】', text, read: false, gid }); if (x.discordId) bot.users.send(x.discordId, `【${SITE}】${text}`).catch(() => {}); });
  save();
}
const explain = e => {
  const m = String((e && e.message) || e), c = e && (e.code || e.status);
  if (m === 'BOT_OFFLINE') return '⚠️ Botがオフラインです。しばらくしてから、もう一度お試しください(ホストの稼働を確認してください)。';
  if (m === 'TIMEOUT') return '⚠️ 処理に時間がかかっています。結果は「操作ログ」で確認してください。';
  if (c === 429 || /rate ?limit|too many requests/i.test(m)) return '⚠️ Botとの通信が一時的に制限されています。5秒後にもう一度お試しください。';
  if (c === 50013 || /missing permissions/i.test(m)) return '⚠️ Botの権限が足りません。サーバー設定で、Botのロールの権限と順位を確認してください。';
  if (c === 50001 || /missing access/i.test(m)) return '⚠️ Botがそのチャンネルやサーバーにアクセスできません。権限を確認してください。';
  if (c === 10007 || c === 10013 || /unknown (member|user)/i.test(m)) return '⚠️ 対象のユーザーが見つかりません。IDを確認してください。';
  if (c === 10026 || /unknown ban/i.test(m)) return '⚠️ このユーザーはBANされていません。';
  if (c === 10003 || /unknown channel/i.test(m)) return '⚠️ チャンネルが見つかりません。';
  if (c === 50007 || /cannot send messages to this user/i.test(m)) return '⚠️ 相手がDMを拒否しているため、送れませんでした。';
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up/i.test(m)) return '⚠️ Discordとの通信に失敗しました。少し待ってから、もう一度お試しください。';
  return `⚠️ 処理に失敗しました。(詳細: ${m})`;
};
app.use((err, req, res, next) => { console.error(err); if (!res.headersSent) res.status(500).send(page(null, 'エラー', note(explain(err)) + '<a class=b href=/>メニューへ</a>', [])); });
process.on('unhandledRejection', e => console.error('unhandledRejection', e));
process.on('uncaughtException', e => console.error('uncaughtException', e));
bot.on(Events.Error, e => console.error('bot error', e));
app.listen(PORT, '0.0.0.0', () => console.log(`管理画面: http://localhost:${PORT}`));
