# Discord管理Web

起動: `npm install` → `.env` を作成(`.env.example` を参照) → `npm start`
初回起動時に、`OWNER_USER` / `OWNER_PASS` の最高管理者アカウントが作られます。ログイン後に「パスワード変更」で変更してください。
権限は `server.js` の `CAN` で調整できます。データは `data/db.json` に保存されます。
