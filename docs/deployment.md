# 部署指南：Supabase（資料）＋ Cloudflare（網站）

Cairn 由兩個彼此獨立的部分組成，**兩者都要完成才算「雲端同步可用」**：

| 部分 | 服務 | 負責 | 需要你親自操作的事 |
|---|---|---|---|
| 資料與登入 | Supabase（Free） | Postgres 資料庫、RLS 權限、Email／密碼登入 | 建立專案、執行 SQL、複製 URL 與 publishable key |
| 網站 | Cloudflare（Free，Workers Static Assets） | 提供 `dist/` 靜態檔案 | 登入 Cloudflare、執行部署（或連接 GitHub） |

> 「網站部署完成」不等於「雲端資料庫已設定完成」。只部署網站而沒有設定 Supabase 時，App 會以本機模式執行，
> 側邊欄顯示 **Local only — not synced**，資料不會跨裝置同步。

---

## 步驟 1 — 建立 Supabase 專案並套用資料庫結構

完整說明與驗證方式：[`supabase/README.md`](../supabase/README.md)。最短流程：

1. 到 <https://supabase.com/dashboard> 建立免費專案（Region 建議選 Northeast Asia (Tokyo) 或 Singapore）。
2. 左側 **SQL Editor** → New query → 貼上 `supabase/migrations/20261102000000_init.sql` 全部內容 → **Run**。
3. 依 `supabase/README.md` §2 執行驗證查詢，確認每張表都啟用 RLS。
4. **Project Settings → Data API**：複製 Project URL；**Project Settings → API Keys**：複製 **publishable key**（`sb_publishable_…`）。
   **不要**使用 `service_role`／`sb_secret_…` key。

## 步驟 2 — 本機連上雲端測試

```bash
cp .env.example .env.local
```

在 `.env.local` 填入 `VITE_SUPABASE_URL` 與 `VITE_SUPABASE_PUBLISHABLE_KEY`，然後：

```bash
npm run dev
```

打開 http://localhost:5173 → 建立帳號（或依 `supabase/README.md` §3 在 Dashboard 直接新增使用者並勾選 Auto Confirm）→ 登入後建立一個專案，
到 Supabase **Table Editor** 應可看到資料。完成後在 **Authentication → Sign In / Providers** 關閉「Allow new users to sign up」。

## 步驟 3 — 部署網站到 Cloudflare

`VITE_*` 變數是在 **build 時** 寫進 JavaScript 的，所以要在 build 之前設定好。

### 方法 A：本機指令部署（最短）

1. 建立 `.env.production.local`（已被 git 忽略），內容與 `.env.local` 相同的兩個變數。
2. 建置並部署：

```bash
npm run build
```

```bash
npx wrangler@4.156.1 login
```

```bash
npx wrangler@4.156.1 deploy
```

`login` 會開瀏覽器請你授權 Cloudflare；`deploy` 讀取 `wrangler.jsonc`，上傳 `dist/`，完成後會顯示網址（例如 `https://cairn.<你的帳號>.workers.dev`）。

### 方法 B：連接 GitHub 自動部署（Workers Builds）

1. 把專案推到你自己的 GitHub repository（`.env*` 已被忽略，不會上傳金鑰）。
2. Cloudflare Dashboard → **Workers & Pages → Create → Import a repository**，選擇該 repo。
3. Build command：`npm run build`；Deploy command：`npx wrangler deploy`（預設）。
4. **Settings → Build → Build variables and secrets** 新增 `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`
   （是 *build* 變數，不是 runtime vars）。Node 版本會讀取 repo 內的 `.node-version`（24）。
5. 之後每次 push 都會自動重新部署。

## 步驟 4 — 讓 Supabase 認得你的正式網址

Supabase Dashboard → **Authentication → URL Configuration**：

- **Site URL**：你的正式網址（例如 `https://cairn.<帳號>.workers.dev`）。
- **Redirect URLs**：加入正式網址與 `http://localhost:5173`（本機開發用）。

這會影響「忘記密碼」與註冊確認信中的連結會導回哪裡。

## 步驟 5 — 上線後檢查

- 在另一台電腦（Mac／Windows）開啟正式網址並登入，確認看到相同資料（驗收標準 13）。
- 瀏覽器 DevTools Console 沒有 CSP 錯誤（`public/_headers` 只允許 `*.supabase.co` 的連線）。
- 重新整理深層網址（例如 `/projects/<id>/gantt`）仍可正常開啟（`wrangler.jsonc` 已設定 SPA fallback）。

---

## 免費方案限制與風險（請務必知道）

- **Supabase Free 沒有自動備份**，也沒有時間點還原。請定期在 **Settings → Data → Export JSON backup** 下載備份。
- **Supabase Free 專案閒置約 7 天會被暫停**；到 Dashboard 按 Restore 即可恢復（資料保留，但暫停期間 App 無法讀寫）。
- Free 方案最多 2 個進行中的專案；資料庫容量與流量對個人使用綽綽有餘，詳見 `docs/platform-notes.md` A1。
- Cloudflare 靜態檔案請求免費且不限次數；Git 自動建置每月有分鐘數上限（個人使用不會碰到）。
- 免費額度與政策可能變動，請以官方頁面為準；本專案不保證永久免費或永不停機。

## 絕對不要做的事

- 不要把 `service_role` 或 `sb_secret_…` key 放進任何 `VITE_*` 變數或提交到 Git（它會繞過 RLS）。
- 不要在 Supabase 關閉 RLS，或用 Dashboard 對資料表加上 `anon` 權限。
