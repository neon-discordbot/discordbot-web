require('dotenv').config();
const fs = require('fs'), express = require('express'), session = require('express-session'), bcrypt = require('bcryptjs');
const { Client, GatewayIntentBits: G, Partials, Events } = require('discord.js');
const { DISCORD_TOKEN, GUILD_ID, SESSION_SECRET, OWNER_USER = 'owner', OWNER_PASS, PORT = 3000 } = process.env;
if (!SESSION_SECRET || !OWNER_PASS) { console.error('SESSION_SECRET と OWNER_PASS を設定してください'); process.exit(1); }

// ---- 保存(JSONファイル) ----
const FILE = 'data/db.json';
fs.mkdirSync('data', { recursive: true });
const db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8'))
  : { users: [], msgs: [], dms: [], logs: [], cases: [], reqs: [], seq: 1 };
const save = () => fs.writeFileSync(FILE, JSON.stringify(db));
const now = () => new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
if (!db.users.length) { db.users.push({ name: OWNER_USER, hash: bcrypt.hashSync(OWNER_PASS, 10), role: 'owner' }); save(); }

// ---- 権限(ここを書き換えれば権限を調整できます) ----
const ROLES = { owner: '最高管理者', admin: '管理者', junior: '新任管理者' };
const CAN = {
  owner: ['ban', 'kick', 'timeout', 'warn', 'approve', 'dm', 'logs', 'accounts'],
  admin: ['ban', 'kick', 'timeout', 'warn', 'approve', 'dm', 'logs'],
  junior: ['timeout', 'warn'], // BAN/KICKは「申請」→管理者が承認
};
const can = (u, p) => CAN[u.role].includes(p);
const TYPES = { ban: 'BAN', kick: 'KICK', timeout: 'タイムアウト', warn: '警告' };
const isId = s => /^\d{15,22}$/.test(s || '');

// ---- Discord ----
const bot = new Client({ intents: [G.Guilds, G.GuildMembers, G.DirectMessages], partials: [Partials.Channel, Partials.Message] });
bot.on(Events.MessageCreate, m => {
  if (m.guild || m.author.bot) return;
  db.dms.unshift({ t: now(), uid: m.author.id, name: m.author.tag, text: m.content });
  db.dms = db.dms.slice(0, 300); save();
});
bot.login(DISCORD_TOKEN);

const log = (u, text) => { db.logs.unshift({ t: now(), who: u.name, text }); db.logs = db.logs.slice(0, 500); save(); };
async function exec(u, type, uid, reason, min) {
  if (type !== 'warn') {
    const g = await bot.guilds.fetch(GUILD_ID);
    if (type === 'ban') await g.members.ban(uid, { reason });
    else {
      const m = await g.members.fetch(uid);
      if (type === 'kick') await m.kick(reason); else await m.timeout(min * 60000, reason);
    }
  }
  db.cases.unshift({ t: now(), type, uid, reason, min, by: u.name }); save();
  log(u, `${TYPES[type]} ${uid}(${reason})`);
}

// ---- 画面 ----
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (u, title, body, note = '') => `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
body{font:15px sans-serif;margin:0;background:#ddd;color:#111}
header{background:#2a45b5;color:#fff;padding:10px 16px;letter-spacing:.1em}
main{max-width:900px;margin:12px auto;padding:0 12px}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
a.b,button{background:#eee;border:2px outset #fff;padding:8px 14px;color:#111;text-decoration:none;font:inherit;cursor:pointer;margin:2px}
fieldset{margin:0 0 12px;border:1px solid #999}
input,select,textarea{font:inherit;padding:6px;width:100%;box-sizing:border-box;margin:4px 0}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border:1px solid #aaa;padding:6px;text-align:left;vertical-align:top;white-space:pre-wrap}
.note{background:#fff;border:1px solid #999;padding:8px;margin-bottom:12px}
</style><header>管理システム端末${u ? ` ｜ ${esc(u.name)}(${ROLES[u.role]})` : ''}</header><main>
${u ? '<div class=bar><a class=b href=/>メニュー</a><a class=b href=/logout>終了</a></div>' : ''}${note ? `<div class=note>${esc(note)}</div>` : ''}${body}</main>`;
const table = (head, rows) => `<table><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr>${rows.join('')}</table>`;
const tr = cells => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
const loginForm = '<form method=post><label>アカウント<input name=name required></label><label>パスワード<input name=pass type=password required></label><button>ログイン</button></form>';

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 8 * 3600e3 } }));

const auth = perm => (req, res, next) => {
  const u = db.users.find(x => x.name === req.session.name);
  if (!u) return res.redirect('/login');
  if (perm && !can(u, perm)) return res.status(403).send(page(u, '権限なし', '', 'この操作の権限がありません。'));
  req.u = u; next();
};

// ログイン(5回失敗で10分ロック)
const fails = {};
app.get('/login', (req, res) => res.send(page(null, 'ログイン', loginForm)));
app.post('/login', (req, res) => {
  let f = fails[req.ip];
  if (!f || Date.now() - f.t > 6e5) f = fails[req.ip] = { n: 0, t: Date.now() };
  if (f.n >= 5) return res.status(429).send(page(null, 'ログイン', loginForm, '試行回数が多すぎます。10分後にやり直してください。'));
  const u = db.users.find(x => x.name === req.body.name);
  if (u && bcrypt.compareSync(req.body.pass || '', u.hash)) {
    delete fails[req.ip];
    return req.session.regenerate(() => { req.session.name = u.name; res.redirect('/'); });
  }
  f.n++; f.t = Date.now();
  res.status(401).send(page(null, 'ログイン', loginForm, 'アカウントまたはパスワードが違います'));
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/', auth(), (req, res) => {
  const u = req.u, unread = db.msgs.filter(m => m.to === u.name && !m.read).length;
  const L = (p, h, t) => (!p || can(u, p)) ? `<a class=b href=${h}>${t}</a>` : '';
  res.send(page(u, 'メインメニュー', `<div class=note>BOT: ${bot.isReady() ? `稼働中 ${bot.ws.ping}ms` : '停止中'}　未読: ${unread}件</div>
<fieldset><legend>処分業務</legend>${Object.keys(TYPES).map(t => L(t, `/act/${t}`, TYPES[t])).join('')}</fieldset>
<fieldset><legend>申請・承認</legend>${L('', '/reqs', '申請一覧')}${L('', '/cases', '処分履歴照会')}${L('logs', '/logs', '操作ログ')}</fieldset>
<fieldset><legend>通信業務</legend>${L('dm', '/dms', 'DM受信')}${L('dm', '/dm', 'DM送信')}${L('', '/inbox', '管理者間通信')}</fieldset>
<fieldset><legend>設定業務</legend>${L('accounts', '/accounts', 'アカウント管理')}${L('', '/password', 'パスワード変更')}</fieldset>`));
});

// 処分
app.get('/act/:type', auth(), (req, res) => {
  const t = req.params.type, u = req.u;
  if (!TYPES[t] || !can(u, t)) return res.status(403).send(page(u, '権限なし', '', 'この操作の権限がありません。BAN/KICKは「申請一覧」から申請してください。'));
  res.send(page(u, TYPES[t], `<form method=post><label>ユーザーID<input name=uid required pattern="\\d{15,22}"></label>
<label>理由<input name=reason required maxlength=200></label>${t === 'timeout' ? `<label>分数<input name=min type=number min=1 max=${u.role === 'junior' ? 60 : 40320} required></label>` : ''}<button>実行</button></form>`));
});
app.post('/act/:type', auth(), async (req, res) => {
  const t = req.params.type, u = req.u, { uid, reason } = req.body;
  const min = Math.min(+req.body.min || 0, u.role === 'junior' ? 60 : 40320);
  if (!TYPES[t] || !can(u, t) || !isId(uid) || !reason || (t === 'timeout' && min < 1)) return res.status(400).send(page(u, 'エラー', '', '入力または権限が正しくありません'));
  try { await exec(u, t, uid, reason.slice(0, 200), min); res.send(page(u, '完了', '', `${TYPES[t]}を実行しました`)); }
  catch (e) { res.status(500).send(page(u, 'エラー', '', `失敗: ${e.message}`)); }
});

// 申請・承認
app.get('/reqs', auth(), (req, res) => {
  const u = req.u, ap = can(u, 'approve');
  const rows = db.reqs.filter(r => ap || r.by === u.name).slice(0, 100).map(r => tr([esc(r.t), esc(r.by), TYPES[r.type], esc(r.uid), esc(r.reason),
    r.status === 'pending' && ap ? `<form method=post action=/reqs/${r.id}><button name=a value=ok>承認</button><button name=a value=no>却下</button></form>` : esc(r.status)]));
  res.send(page(u, '申請一覧', `<fieldset><legend>BAN/KICKの申請</legend><form method=post action=/reqs><select name=type><option value=ban>BAN<option value=kick>KICK</select>
<input name=uid placeholder=ユーザーID required pattern="\\d{15,22}"><input name=reason placeholder=理由 required maxlength=200><button>申請</button></form></fieldset>
${table(['日時', '申請者', '種別', 'ユーザーID', '理由', '状況'], rows)}`));
});
app.post('/reqs', auth(), (req, res) => {
  const { type, uid, reason } = req.body;
  if (!['ban', 'kick'].includes(type) || !isId(uid) || !reason) return res.status(400).send(page(req.u, 'エラー', '', '入力が正しくありません'));
  db.reqs.unshift({ id: db.seq++, t: now(), by: req.u.name, type, uid, reason: reason.slice(0, 200), status: 'pending' });
  log(req.u, `申請 ${type} ${uid}`); res.redirect('/reqs');
});
app.post('/reqs/:id', auth('approve'), async (req, res) => {
  const r = db.reqs.find(x => x.id === +req.params.id);
  if (!r || r.status !== 'pending') return res.redirect('/reqs');
  if (req.body.a !== 'ok') { r.status = `却下(${req.u.name})`; save(); log(req.u, `却下 申請#${r.id}`); return res.redirect('/reqs'); }
  try { await exec(req.u, r.type, r.uid, `${r.reason}(申請者:${r.by})`); r.status = `承認(${req.u.name})`; save(); res.redirect('/reqs'); }
  catch (e) { res.status(500).send(page(req.u, 'エラー', '', `失敗: ${e.message}`)); }
});

// 履歴・ログ
app.get('/cases', auth(), (req, res) => {
  const q = String(req.query.uid || '');
  const rows = db.cases.filter(c => !q || c.uid === q).slice(0, 200).map(c => tr([esc(c.t), TYPES[c.type], esc(c.uid), esc(c.reason), esc(c.by)]));
  res.send(page(req.u, '処分履歴', `<form><input name=uid placeholder="ユーザーIDで絞り込み" value="${esc(q)}"></form>${table(['日時', '種別', 'ユーザーID', '理由', '担当'], rows)}`));
});
app.get('/logs', auth('logs'), (req, res) => res.send(page(req.u, '操作ログ', table(['日時', '係員', '内容'], db.logs.slice(0, 200).map(l => tr([esc(l.t), esc(l.who), esc(l.text)]))))));

// DM
app.get('/dms', auth('dm'), (req, res) => res.send(page(req.u, 'DM受信', table(['日時', '送信者', 'ユーザーID', '内容'], db.dms.slice(0, 100).map(d => tr([esc(d.t), esc(d.name), esc(d.uid), esc(d.text)]))))));
app.get('/dm', auth('dm'), (req, res) => res.send(page(req.u, 'DM送信', '<form method=post><input name=uid placeholder=ユーザーID required pattern="\\d{15,22}"><textarea name=text rows=5 required maxlength=1500></textarea><button>送信</button></form>')));
app.post('/dm', auth('dm'), async (req, res) => {
  if (!isId(req.body.uid) || !req.body.text) return res.status(400).send(page(req.u, 'エラー', '', '入力が正しくありません'));
  try { await bot.users.send(req.body.uid, req.body.text.slice(0, 1500)); log(req.u, `DM送信 ${req.body.uid}`); res.send(page(req.u, '完了', '', '送信しました')); }
  catch (e) { res.status(500).send(page(req.u, 'エラー', '', `失敗: ${e.message}`)); }
});

// 管理者間通信
app.get('/inbox', auth(), (req, res) => {
  const u = req.u, mine = db.msgs.filter(m => m.to === u.name);
  const body = `<fieldset><legend>送信</legend><form method=post><select name=to>${db.users.filter(x => x.name !== u.name).map(x => `<option>${esc(x.name)}`).join('')}</select>
<textarea name=text rows=4 required maxlength=1500></textarea><button>送信</button></form></fieldset>${table(['日時', '差出人', '内容'], mine.slice(0, 50).map(m => tr([esc(m.t), esc(m.from), esc(m.text)])))}`;
  mine.forEach(m => m.read = true); save();
  res.send(page(u, '管理者間通信', body));
});
app.post('/inbox', auth(), (req, res) => {
  if (!db.users.some(x => x.name === req.body.to) || !req.body.text) return res.status(400).send(page(req.u, 'エラー', '', '入力が正しくありません'));
  db.msgs.unshift({ t: now(), from: req.u.name, to: req.body.to, text: req.body.text.slice(0, 1500), read: false }); save();
  res.redirect('/inbox');
});

// アカウント管理(最高管理者のみ)
app.get('/accounts', auth('accounts'), (req, res) => res.send(page(req.u, 'アカウント管理', `<fieldset><legend>作成 / 更新(既存の名前なら権限・パスワードを更新)</legend><form method=post>
<input name=name placeholder="アカウント名(英数字3〜20)" required><input name=pass type=password placeholder="パスワード(8文字以上。更新時は空欄で変更なし)">
<select name=role>${Object.entries(ROLES).map(([k, v]) => `<option value=${k}>${v}`).join('')}</select><button>保存</button></form></fieldset>
${table(['アカウント', '権限'], db.users.map(x => tr([esc(x.name), ROLES[x.role]])))}`)));
app.post('/accounts', auth('accounts'), (req, res) => {
  const { name, pass, role } = req.body, ex = db.users.find(x => x.name === name);
  if (!/^[\w-]{3,20}$/.test(name || '') || !ROLES[role] || (pass && pass.length < 8) || (!ex && !pass) || (ex && ex.name === req.u.name && role !== 'owner'))
    return res.status(400).send(page(req.u, 'エラー', '', '入力が正しくありません(自分自身の権限は下げられません)'));
  if (ex) { ex.role = role; if (pass) ex.hash = bcrypt.hashSync(pass, 10); }
  else db.users.push({ name, hash: bcrypt.hashSync(pass, 10), role });
  save(); log(req.u, `アカウント更新 ${name}(${ROLES[role]})`); res.redirect('/accounts');
});

// パスワード変更
app.get('/password', auth(), (req, res) => res.send(page(req.u, 'パスワード変更', '<form method=post><input name=old type=password placeholder=現在のパスワード required><input name=pass type=password placeholder="新しいパスワード(8文字以上)" required><button>変更</button></form>')));
app.post('/password', auth(), (req, res) => {
  if (!bcrypt.compareSync(req.body.old || '', req.u.hash) || (req.body.pass || '').length < 8) return res.status(400).send(page(req.u, 'エラー', '', '現在のパスワードが違うか、新しいパスワードが短すぎます'));
  req.u.hash = bcrypt.hashSync(req.body.pass, 10); save(); res.send(page(req.u, '完了', '', '変更しました'));
});

app.listen(PORT, '0.0.0.0', () => console.log(`管理画面: http://localhost:${PORT}`));
