require('dotenv').config();
const fs = require('fs'), express = require('express'), session = require('express-session'), bcrypt = require('bcryptjs');
const { Client, GatewayIntentBits: G, Partials, Events, EmbedBuilder } = require('discord.js');
const { DISCORD_TOKEN, GUILD_ID, SESSION_SECRET, OWNER_USER = 'owner', OWNER_PASS, PORT = 3000 } = process.env;
const GIDS = (process.env.GUILD_IDS || GUILD_ID || '').split(',').map(x => x.trim()).filter(Boolean);
if (!GIDS.length) { console.error('GUILD_IDS(サーバーID。複数ならカンマ区切り)を設定してください'); process.exit(1); }
if (!SESSION_SECRET || !OWNER_PASS) { console.error('SESSION_SECRET と OWNER_PASS を設定してください'); process.exit(1); }

// ---- 保存(JSONファイル) ----
const FILE = 'data/db.json';
fs.mkdirSync('data', { recursive: true });
const db = Object.assign({ users: [], msgs: [], dms: [], logs: [], cases: [], reqs: [], dmlog: [], emerg: {}, memo: {}, seq: 1 },
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
const bot = new Client({ intents: [G.Guilds, G.GuildMembers, G.DirectMessages, G.GuildVoiceStates], partials: [Partials.Channel, Partials.Message] });
bot.on(Events.MessageCreate, async m => {
  if (m.guild || m.author.bot) return;
  const gids = [];
  for (const g of GIDS) if (await bot.guilds.fetch(g).then(x => x.members.fetch(m.author.id)).catch(() => null)) gids.push(g);
  db.dms.unshift({ id: nid(), t: now(), uid: m.author.id, name: m.author.tag, text: m.content, gids });
  db.dms = db.dms.slice(0, 300); save();
});
bot.login(DISCORD_TOKEN);

const log = (who, op, target = '', detail = '', gid) => {
  db.logs.unshift({ t: now(), who, op, target, detail: String(detail).slice(0, 200), gid });
  db.logs = db.logs.slice(0, 1000); save();
};
async function exec(by, type, uid, reason, min, notify, gid) {
  if (!GIDS.includes(gid)) throw new Error('サーバーが選択されていません');
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
}

// ---- 画面部品 ----
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEYS = ['メニュー', '戻る', '保存', '更新', '開始', '終了', '承認', '却下', '照会', '発信', '予約', '保持', '解放'];
const ACT = { メニュー: "location='/'", 戻る: 'history.back()', 更新: 'location.reload()', 終了: "location='/logout'", 照会: 'doLookup()', 発信: 'doSend()', 解放: 'doReset()' };
const BASE = ['メニュー', '戻る', '更新', '終了'], FORM = [...BASE, '照会', '発信', '解放'];
const status = u => `<div class=st>係員 <span class=v>${esc(u.name)}</span> 権限区分 <span class=v>${ROLES[u.role]}</span> サーバー <form method=post action=/server><select name=gid onchange="this.form.submit()">${allowed(u).map(g => `<option value="${g}"${g === u.gid ? ' selected' : ''}>${esc(gname(g))}`).join('')}</select></form> 日時 <span class=v>${now()}</span> BOT <span class=v>${bot.isReady() ? `稼働中 ${bot.ws.ping}ms` : '停止中'}</span> 未読 <span class=v>${db.msgs.filter(m => m.to === u.name && !m.read && m.gid === u.gid).length} 件</span> <a class=b href=/inbox>管理者間通信</a> <a class=b href=/lock>端末ロック</a> <small>${online(u)}</small></div>`;
const page = (u, title, body, on = BASE, act = {}) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>管理システム端末</title><style>
body{margin:0;background:#d9d9d9;font:14px sans-serif;color:#111}
h1{margin:0;background:linear-gradient(#2a45b5,#1a2f9a);color:#fff;text-align:center;font-weight:400;font-size:15px;letter-spacing:.2em;padding:13px 8px}
.w{max-width:1000px;margin:0 auto;padding:10px}.tb{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px}
button,a.b{font:inherit;background:#e4e4e4;border:2px outset #fff;padding:9px 16px;color:#111;text-decoration:none;cursor:pointer;display:inline-block}
button:disabled{color:#999;background:#d2d2d2;cursor:default}button.on,a.cur{font-weight:700}
.st{margin:8px 0;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.st select{width:auto;display:inline-block;margin:0}.st form{display:inline;margin:0}.v{display:inline-block;background:#f4f4f4;border:2px inset #fff;padding:7px 10px;white-space:nowrap}
input,select,textarea{font:inherit;padding:7px;box-sizing:border-box;background:#f4f4f4;border:2px inset #fff}
form input:not([type=checkbox]),form select,form textarea{width:100%;max-width:600px;display:block;margin:4px 0 12px}
fieldset{border:1px solid #999;padding:10px;margin:0 0 12px}
table{width:100%;border-collapse:collapse;background:#f4f4f4}td,th{border:1px solid #999;padding:7px;text-align:left;vertical-align:top;white-space:pre-wrap}th{background:#c8c8c8}
.note{background:#eee;border:1px solid #999;padding:9px;margin:6px 0 12px}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}
.tile{display:block;background:#e4e4e4;border:2px outset #fff;padding:12px 8px;text-align:center;color:#111;text-decoration:none;min-height:48px}
.tile small{display:block;margin-top:6px;background:#eee;border:1px solid #999;padding:2px;font-size:12px}.tile.off{background:#d0d0d0;border:2px solid #ccc}
</style><h1>管理システム端末(version 5.0.0) ${esc(title)}</h1><div class=w>
<div class=tb>${KEYS.map(k => on.includes(k) ? `<button type=button class=on onclick="${act[k] || ACT[k]}">${k}</button>` : `<button disabled>${k}</button>`).join('')}</div>
${u ? status(u) + '<div id=nb class=note style="display:none"><a href=/inbox>管理者間通信に新着メッセージがあります</a></div>' : ''}${body}</div><script>
function F(){return document.querySelector('form.main')}
function doLookup(){var f=F(),i=f&&f.elements.uid;if(f&&f.method=='get')f.submit();else location='/history'+(i&&i.value?'?uid='+encodeURIComponent(i.value):'')}
function doSend(){var f=F();if(f){f.requestSubmit?f.requestSubmit():f.submit()}}
function doReset(){var f=F();if(f)f.reset()}${u ? POLL : ''}</script>`;
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

const auth = perm => (req, res, next) => {
  const u0 = db.users.find(x => x.id === req.session.uid);
  if (!u0) return res.redirect('/login');
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
app.post('/login', (req, res) => {
  let f = fails[req.ip];
  if (!f || Date.now() - f.t > 6e5) f = fails[req.ip] = { n: 0, t: Date.now() };
  if (f.n >= 5) return res.status(429).send(loginPage('試行回数が多すぎます。10分後にやり直してください。'));
  const u = db.users.find(x => x.name === req.body.name);
  if (u && bcrypt.compareSync(req.body.pass || '', u.hash)) {
    delete fails[req.ip];
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
    Gp('申請・承認', [T('/approve', '申請承認', '承認待ち', can(u, 'approve')), T('/myreqs', '自分の申請', '申請状況'), T('/logs', '操作ログ', '実行履歴'), T('/history', '処分履歴照会', 'アカウント別')]) +
    Gp('通信業務', [T('/dms', 'DM受信', `未対応 ${db.dms.filter(d => visDm(u, d) && (d.st || 'todo') === 'todo').length}件`), T('/dm', 'DM送信', 'ユーザー宛DM'), T('/inbox', '管理者間通信', 'サイト内・メール'), T('/allmsgs', '全メッセージ管理', 'メッセージ削除', can(u, 'delMsg')), T('/summon', '緊急招集', 'Discordでメンション', can(u, 'direct'))]) +
    Gp('サーバー管理', [T('/user', 'ユーザー情報', 'ID・ロール・警告'), T('/vc', 'VC管理', '参加者・切断・ミュート'), T('/invites', '招待リンク', '確認・破棄', can(u, 'direct')), T('/embed', '埋め込み投稿', 'Botから投稿', can(u, 'direct')), T('/emerg', '緊急対応', '封鎖・低速・ゲート', can(u, 'release'))]) +
    Gp('設定業務', [T('/accounts', 'アカウント管理', '追加・削除', can(u, 'accounts')), T('/password', 'パスワード変更', '自分のパスワード')]), ['更新', '終了']));
});

// ---- 処分(BAN/KICK/タイムアウト/警告) ----
app.get('/act/:type', auth(), (req, res) => {
  const t = req.params.type, u = req.u, direct = can(u, 'direct');
  if (!TYPES[t]) return res.redirect('/');
  if (!u.gid) return res.send(done(u, TYPES[t], '操作できるサーバーが割り当てられていません。'));
  const top = direct || t === 'warn' ? '' : t === 'timeout' ? '新任管理者の操作は、管理者以上の承認が必要です。タイムアウトは60分(1時間)までなら、承認なしで実行できます。' : '新任管理者の操作は、管理者以上の承認が必要です。';
  const uid = '<label>対象のDiscordユーザーID<input name=uid required pattern="\\d{15,22}" inputmode=numeric></label>';
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
    db.reqs.unshift({ id: nid(), t: now(), by: u.name, type: t, uid, reason, min, notify, status: '申請中', handler: '', result: '', gid: u.gid }); save();
    log(u.name, `${TYPES[t]}申請`, uid, reason, u.gid); return res.redirect('/myreqs');
  }
  try { await exec(u.name, t, uid, reason, min, notify, u.gid); res.send(done(u, TYPES[t], `${gname(u.gid)}で${pun(t, min)}を実行しました`)); }
  catch (e) { res.status(500).send(done(u, TYPES[t], `失敗: ${e.message}`)); }
});

// ---- 申請 ----
app.get('/myreqs', auth(), (req, res) => {
  const rows = db.reqs.filter(r => r.by === req.u.name && r.gid === req.u.gid).slice(0, 100).map(r => tr([r.id, pun(r.type, r.min), esc(r.uid), esc(r.status), esc(r.handler || '-'), esc(r.result || '-'), esc(r.t)]));
  res.send(page(req.u, '自分の申請', fs_('自分の申請(申請履歴・申請状況)', rows.length ? table(['番号', '予定処罰', '対象のDiscordアカウントID', '状況', '処理した人', '結果', '申請日時'], rows) : empty('申請はまだありません。'))));
});
app.get('/approve', auth('approve'), (req, res) => {
  const rows = db.reqs.filter(r => r.gid === req.u.gid).slice(0, 100).map(r => tr([r.id, esc(r.by), pun(r.type, r.min), esc(r.uid), esc(r.reason), esc(r.t),
    r.status === '申請中' ? `<form method=post action=/approve/${r.id}><button name=a value=ok>承認</button> <button name=a value=no>却下</button></form>` : `${esc(r.status)}(${esc(r.handler)})`]));
  res.send(page(req.u, '申請承認', fs_('申請一覧', rows.length ? table(['番号', '申請者', '予定処罰', '対象ID', '理由', '申請日時', '状況'], rows) : empty('申請はありません。'))));
});
app.post('/approve/:id', auth('approve'), async (req, res) => {
  const r = db.reqs.find(x => x.id === +req.params.id);
  if (!r || r.status !== '申請中' || !allowed(req.u).includes(r.gid)) return res.redirect('/approve');
  r.handler = req.u.name;
  if (req.body.a === 'ok') {
    r.status = '承認済';
    try { await exec(req.u.name, r.type, r.uid, `${r.reason}(申請者:${r.by})`, r.min, r.notify, r.gid); r.result = '実行済'; }
    catch (e) { r.result = `失敗: ${e.message}`; }
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
app.get('/dm', auth(), (req, res) => res.send(page(req.u, 'DM送信', fs_('DM送信', `<form method=post class=main><label>送信先のDiscordアカウントID<input name=uid required pattern="\\d{15,22}" inputmode=numeric></label><label>メッセージ<textarea name=text rows=7 required maxlength=1500></textarea></label></form>${note('1人あたり1時間に20通まで送れます。相手がDMを拒否していると届きません。選択中のサーバーのメンバーにだけ送れます。')}`), FORM)));
app.post('/dm', auth(), async (req, res) => {
  const u = req.u, { uid, text } = req.body;
  if (!isId(uid) || !text) return bad(res, u, '入力が正しくありません');
  if (!u.gid || !await bot.guilds.fetch(u.gid).then(g => g.members.fetch(uid)).catch(() => null)) return bad(res, u, `このサーバー(${gname(u.gid)})のメンバーではないため送れません`);
  db.dmlog = db.dmlog.filter(x => x.ts > Date.now() - 36e5);
  if (db.dmlog.filter(x => x.uid === uid).length >= 20) return res.status(429).send(done(u, 'DM送信', 'この相手には1時間に20通まで送れます。しばらく待ってください。'));
  try { await bot.users.send(uid, text.slice(0, 1500)); db.dmlog.push({ uid, ts: Date.now() }); save(); log(u.name, 'DM送信', uid, '', u.gid); res.send(done(u, 'DM送信', '送信しました')); }
  catch (e) { res.status(500).send(done(u, 'DM送信', `失敗: ${e.message}(相手がDMを拒否している可能性があります)`)); }
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
const run = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(500).send(done(req.u, 'エラー', `失敗: ${e.message}`)));
const fmtD = d => d ? new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 16) : '-';
const G_ = async u => { if (!u.gid) throw new Error('サーバーが選択されていません'); return bot.guilds.fetch(u.gid); };
const chans = (g, types = [0, 5]) => g.channels.cache.filter(c => types.includes(c.type));
const btn = (action, label, ask, extra = '') => `<form method=post action=${action} style="display:inline" onsubmit="return confirm('${ask}')">${extra}<button>${label}</button></form>`;

// ユーザー情報(ID・参加日・ロール・警告回数・ステータス)+ロール付け外し
app.get('/user', auth(), run(async (req, res) => {
  const u = req.u, q = String(req.query.q || '').trim();
  let out = '';
  if (q) {
    const g = await G_(u);
    const ms = isId(q) ? [await g.members.fetch(q).catch(() => null)].filter(Boolean) : [...(await g.members.search({ query: q, limit: 10 })).values()];
    const roleOpts = [...g.roles.cache.values()].filter(r => r.id !== g.id && !r.managed && r.editable && (u.role === 'owner' || !r.permissions.has('Administrator'))).sort((a, b) => b.position - a.position).map(r => `<option value=${r.id}>${esc(r.name)}`).join('');
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
  if (u.role !== 'owner' && role.permissions.has('Administrator')) return bad(res, u, '管理者権限を持つロールは最高管理者だけが操作できます');
  if (a === 'add') await m.roles.add(role, `by ${u.name}`); else await m.roles.remove(role, `by ${u.name}`);
  log(u.name, a === 'add' ? 'ロール付与' : 'ロール解除', uid, role.name, u.gid);
  res.redirect('/user?q=' + uid);
}));

// 埋め込みメッセージ投稿
app.get('/embed', auth('direct'), run(async (req, res) => {
  const u = req.u, g = await G_(u); await g.channels.fetch();
  const opts = [...chans(g).values()].sort((a, b) => a.rawPosition - b.rawPosition).map(c => `<option value=${c.id}>#${esc(c.name)}`).join('');
  res.send(page(u, '埋め込み投稿', fs_(`埋め込み投稿(${gname(u.gid)})`, `<form method=post class=main><label>チャンネル<select name=cid>${opts}</select></label><label>タイトル<input name=title maxlength=256 required></label><label>本文<textarea name=text rows=6 maxlength=4000 required></textarea></label><label>色<input type=color name=color value="#2a45b5"></label></form>`), FORM));
}));
app.post('/embed', auth('direct'), run(async (req, res) => {
  const u = req.u, { cid, title, text, color } = req.body, g = await G_(u), c = g.channels.cache.get(cid) || await g.channels.fetch(cid).catch(() => null);
  if (!c || ![0, 5].includes(c.type) || !title || !text || !/^#[0-9a-f]{6}$/i.test(color || '')) return bad(res, u, '入力が正しくありません');
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
  if (a === 'disconnect') await m.voice.disconnect(`by ${u.name}`); else await m.voice.setMute(a === 'mute', `by ${u.name}`);
  log(u.name, { disconnect: 'VC切断', mute: 'VCミュート', unmute: 'VCミュート解除' }[a], uid, '', u.gid); res.redirect('/vc');
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
const online = u => { const l = [...seen.values()].filter(x => Date.now() - x.ts < 3e5 && x.gid === u.gid); return `稼働中 ${l.filter(x => !x.away).length}人: ${esc(l.map(x => x.name + (x.away ? '(離席)' : '')).join(', ') || '-')}`; };
const PW = '<input type=password name=pw placeholder="パスワードを再入力" required autocomplete=current-password>';
const pwOk = (u, req) => bcrypt.compareSync(req.body.pw || '', u.hash);
const lockPage = (u, t) => page(null, '端末ロック', fs_(`端末ロック中(${u.name})`, `${note(t)}<form method=post action=/unlock><label>パスワード<input name=pass type=password autocomplete=current-password></label><button>ロック解除</button></form><a class=b href=/logout>ログアウト</a>`), []);
const stLabel = d => d.st === 'doing' ? `${d.by}が対応中` : d.st === 'done' ? `完了(${d.by})` : '未対応';
const memoBox = u => { const m = db.memo[u.gid]; return `<div class=note style="font-weight:700">${m && m.text ? esc(m.text) : '(共有メモはありません)'}${m ? `<br><small>更新: ${esc(m.by)} ${esc(m.at)}</small>` : ''}</div><form method=post action=/memo><input name=text maxlength=200 value="${esc(m ? m.text : '')}" placeholder="全体共有メモ(例:【警戒】スパムURL荒らし発生中 / ○○さんは22時まで対応可)"><button>メモを保存</button></form>`; };
const POLL = "var N=null;function beep(){try{var a=new (window.AudioContext||window.webkitAudioContext)(),o=a.createOscillator();o.connect(a.destination);o.frequency.value=880;o.start();setTimeout(function(){o.stop()},250)}catch(e){}}function poll(){fetch('/api/unread').then(function(r){return r.json()}).then(function(j){if(N!==null&&j.n>N){beep();document.title='(新着) 管理システム端末';var b=document.getElementById('nb');if(b)b.style.display='block'}N=j.n}).catch(function(){})}setInterval(poll,15000);poll();";

app.get('/api/unread', auth(), (req, res) => res.json({ n: db.msgs.filter(m => m.to === req.u.name && !m.read && m.gid === req.u.gid).length }));
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
  const rows = db.users.map(x => tr([esc(x.name), ROLES[x.role], esc(x.discordId || '-'), x.role === 'owner' ? '全て' : esc(allowed(x).map(gname).join(', ') || 'なし'), x.id === req.u.id ? '(自分)' : `<form method=post action=/accounts/delete onsubmit="return confirm('このアカウントを削除しますか?')"><input type=hidden name=id value=${x.id}>${PW}<button>削除</button></form>`]));
  res.send(page(req.u, 'アカウント管理', fs_('追加 / 更新(既存の名前なら権限・パスワードを更新)', `<form method=post><label>アカウント名(英数字3〜20)<input name=name required></label><label>パスワード(8文字以上。更新時は空欄で変更なし)<input name=pass type=password autocomplete=new-password></label><label>DiscordユーザーID(任意。緊急招集・新着通知に使います)<input name=did inputmode=numeric></label><label>権限<select name=role>${Object.entries(ROLES).map(([k, v]) => `<option value=${k}>${v}`).join('')}</select></label><div>操作できるサーバー(最高管理者は全サーバー): ${GIDS.map(g => `<label><input type=checkbox name=g value="${g}"> ${esc(gname(g))}</label> `).join('')}</div><br><button>保存</button></form>`) + fs_('アカウント一覧', table(['アカウント', '権限', 'DiscordID', '操作できるサーバー', '操作'], rows))));
});
app.post('/accounts', auth('accounts'), (req, res) => {
  const { name, pass, role } = req.body, ex = db.users.find(x => x.name === name);
  const gs = [].concat(req.body.g || []).filter(g => GIDS.includes(g)), did = String(req.body.did || '').trim();
  if (!/^[\w-]{3,20}$/.test(name || '') || !ROLES[role] || (pass && pass.length < 8) || (!ex && !pass) || (ex && ex.id === req.u.id && role !== 'owner') || (role !== 'owner' && !gs.length) || (did && !isId(did)))
    return bad(res, req.u, '入力が正しくありません(自分自身の権限は下げられません / 最高管理者以外は操作できるサーバーを1つ以上選んでください)');
  if (ex) { ex.role = role; ex.guilds = gs; if (did) ex.discordId = did; if (pass) ex.hash = bcrypt.hashSync(pass, 10); }
  else db.users.push({ id: nid(), name, hash: bcrypt.hashSync(pass, 10), role, guilds: gs, discordId: did || undefined });
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

app.listen(PORT, '0.0.0.0', () => console.log(`管理画面: http://localhost:${PORT}`));
