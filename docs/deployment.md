# 部署指南：Supabase（資料）＋ Cloudflare（網站）

Cairn 由兩個彼此獨立的部分組成，**兩者都要完成才算「雲端同步可用」**：

| 部分       | 服務                                      | 負責                                       | 需要你親自操作的事                              |
| ---------- | ----------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| 資料與登入 | Supabase（Free）                          | Postgres 資料庫、RLS 權限、Email／密碼登入 | 建立專案、執行 SQL、複製 URL 與 publishable key |
| 網站       | Cloudflare（Free，Workers Static Assets） | 提供 `dist/` 靜態檔案                      | 登入 Cloudflare、執行部署（或連接 GitHub）      |

> 「網站部署完成」不等於「雲端資料庫已設定完成」。只部署網站而沒有設定 Supabase 時，App 會以本機模式執行，
> 側邊欄顯示 **Local only — not synced**，資料不會跨裝置同步。

**重要**：到目前為止，雲端部分只在本機模擬環境測試過（詳見 [`docs/progress.md`](progress.md) 第 5 節）。
照下面步驟做完、並完成最後的「上線後手動驗收清單」之前，不能說雲端同步已經驗證完成。

建議順序：步驟 1 → 2 → 3（先拿到網站網址）→ 4（把網址告訴 Supabase）→ 5（關閉註冊）→ 驗收清單。

---

## 事前準備

- Node.js 22.22 以上（建議 24 LTS；專案的 `.node-version` 指定 24）與 npm，在專案資料夾執行 `npm install`。
- 一個 Supabase 帳號與一個 Cloudflare 帳號（兩者都有免費方案）。

---

## 步驟 1 — 建立 Supabase 專案並套用資料庫結構

完整說明與驗證方式：[`supabase/README.md`](../supabase/README.md)。最短流程：

1. 到 <https://supabase.com/dashboard> 建立免費專案（Region 建議選 Northeast Asia (Tokyo) 或 Singapore）。需要 PostgreSQL 15 以上（新專案預設即可）。
2. 左側 **SQL Editor** → New query → 貼上 `supabase/migrations/20261102000000_init.sql` **全部內容** → **Run**。
   這份 migration 只能用在全新的空專案，重跑會因「物件已存在」而失敗。
3. 在同一個 SQL Editor 執行 `supabase/README.md` 第 2 節的兩段檢查查詢，確認：
   6 張表都啟用 RLS、每張 4 條 policy、`anon` 沒有任何權限、只有 3 個 RPC 可由登入使用者執行、沒有 `SECURITY DEFINER`。
4. **Project Settings → Data API**：複製 Project URL；**Project Settings → API Keys**：複製 **publishable key**（`sb_publishable_…`）。
   **不要**使用 `service_role`／`sb_secret_…` key。

## 步驟 2 — 建立你自己的帳號，並在本機連上雲端測試

1. 建立帳號（建議這個方法）：Supabase Dashboard → **Authentication → Users → Add user → Create new user**，輸入 email 與密碼，勾選 **Auto Confirm User**（選項名稱以實際畫面為準）。
   這樣不需要收確認信。若改在 App 的登入頁按「Create an account」，Supabase 預設會寄確認信，但內建寄信服務只寄給專案團隊成員的信箱、每小時 2 封，你的信箱不是團隊成員時會收不到。
2. 複製環境變數範本並填入兩個值：

```bash
cp .env.example .env.local
```

在 `.env.local` 填入 `VITE_SUPABASE_URL`（Project URL）與 `VITE_SUPABASE_PUBLISHABLE_KEY`（publishable key）。其他變數留空。

3. 啟動並登入：

```bash
npm run dev
```

打開 http://localhost:5173 ，用步驟 1 建立的帳號登入。建立一個專案，到 Supabase **Table Editor** 的 `projects` 表應可看到那筆資料。

## 步驟 3 — 部署網站到 Cloudflare

`VITE_*` 變數是在 **build 時** 寫進 JavaScript 的，所以要在 build 之前設定好。它們是公開的，只能放 URL 與 publishable key。

`npm run build` 會檢查這些變數：

- 任何 `VITE_*` 變數含有 secret／service role key 時**直接中止**。
- 若印出 `Supabase is not configured` 或 `VITE_SUPABASE_URL …` 的警告，代表這個 build 不會同步（本機模式，或連線會被 CSP 擋下），請先修正再部署。
- 想在部署前確認正式版，可以執行 `npm run test:prod`（不會動到 `dist/`，也不需要 Supabase 帳號）。

> 安全標頭（`public/_headers`）的 CSP 只允許連線到 `*.supabase.co`。如果你使用 Supabase 的自訂網域，
> 必須先修改 `public/_headers` 的 `connect-src` 並重新建置，否則瀏覽器會擋下所有雲端請求。

### 方法 A：本機指令部署（最短）

1. `.env.local` 已在步驟 2 填好，`npm run build` 會自動讀取它（不需要另外建檔）。
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
之後每次更新程式，重新 `npm run build` 與 `deploy` 即可。

### 方法 B：連接 GitHub 自動部署（Workers Builds）

1. 把專案推到你自己的 GitHub repository（`.env*` 已被忽略，不會上傳金鑰）。
2. Cloudflare Dashboard → **Workers & Pages → Create → Import a repository**，選擇該 repo。
3. Build command：`npm run build`；Deploy command：`npx wrangler deploy`（預設）。
4. **Settings → Build → Build variables and secrets** 新增 `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`
   （是 _build_ 變數，不是 runtime vars）。Node 版本會讀取 repo 內的 `.node-version`（24）。
5. 之後每次 push 都會自動重新部署。

## 步驟 4 — 讓 Supabase 認得你的正式網址

Supabase Dashboard → **Authentication → URL Configuration**：

- **Site URL**：你的正式網址（例如 `https://cairn.<帳號>.workers.dev`）。預設值 `http://localhost:3000` 一定要改。
- **Redirect URLs**：加入正式網址本身（只有網域，結尾不要加 `/login` 之類的路徑，也不要加 `/`）與 `http://localhost:5173`（本機開發用）。

原因：App 寄出確認信與重設密碼信時，要求導回的是「目前開啟 App 的網址」（只有網域部分）。
這個網址不在 Redirect URLs 清單內時，信裡的連結會退回 Site URL。
（`supabase/README.md` 第 3 節建議的 `/login` 寫法與目前程式不一致，請以本文件為準。）

## 步驟 5 — 關閉新使用者註冊

確認你的帳號可以登入之後：Supabase Dashboard → **Authentication → Sign In / Providers** → 關閉 **Allow new users to sign up**。

- 既有帳號仍可登入，其他人無法再註冊（App 會顯示 “New sign-ups are disabled for this app.”）。
- **不要**關閉整個 Email provider，否則你自己也無法登入。

---

## 免費方案限制與風險（請務必知道）

- **Supabase Free 沒有自動備份**，也沒有時間點還原。請定期在 App 的 **Settings → Data → Export JSON backup** 下載備份。
- **Supabase Free 專案閒置約 7 天會被暫停**；到 Dashboard 按 Restore 即可恢復（資料保留，但暫停期間 App 無法讀寫）。
- Free 方案最多 2 個進行中的專案；資料庫容量與流量對個人使用綽綽有餘，詳見 `docs/platform-notes.md` A1。
- Cloudflare 靜態檔案請求免費且不限次數；Git 自動建置每月有分鐘數上限（個人使用不會碰到）。
- 免費額度與政策可能變動，請以官方頁面為準；本專案不保證永久免費或永不停機。
- 忘記密碼的信件同樣受內建寄信限制；需要寄到其他信箱時要自行設定 custom SMTP（可能產生費用）。

## 絕對不要做的事

- 不要把 `service_role` 或 `sb_secret_…` key 放進任何 `VITE_*` 變數或提交到 Git（它會繞過 RLS）。
- 不要在 Supabase 關閉 RLS，或用 Dashboard 對資料表加上 `anon` 權限。

---

## 上線後手動驗收清單

**下面每一項都還沒有人做過。** 自動化測試只在 Chromium 與本機模擬環境跑過（見 [`docs/progress.md`](progress.md)），
不能代替這份清單。請做完一項，就自己在旁邊記下日期與結果；全部完成之前，不要把雲端同步、驗收 13、驗收 16 當成已完成。

### A. 真實 email 連結（驗收 1）

- [ ] 在登入頁點 **Forgot password?**，收到重設密碼的信，點信中連結會回到你的網站並能設定新密碼。
- [ ] 連結沒有導向 `localhost` 或錯誤網址（若有，回頭檢查步驟 4）。
- [ ] 註冊確認信只有在開放註冊時才會寄出。若你是用 Auto Confirm 建立帳號，這封信不會出現，這一項請記為「未測」，不要當成通過。

### B. 第二台電腦看到相同資料（驗收 13）

- [ ] 在正式網址建立專案、幾個任務、一條依賴線，並在 Gantt 拖曳一個任務的日期。
- [ ] 在另一台電腦（Mac 或 Windows）開啟同一個網址登入，看到完全相同的資料與日期。
- [ ] 在第二台電腦改一個任務；回到第一台電腦，切換到該分頁（或重新整理），看到修改。
      注意：目前是「回到分頁時更新」，不是即時推送，另一台一直開著不動不會自動變。
- [ ] 兩台的 Today／Overdue 一致（時區設定會跟著帳號同步）。
- [ ] DevTools Console 沒有 CSP 錯誤。
- [ ] 重新整理深層網址（例如 `/projects/<id>/gantt`）仍可正常開啟。
- [ ] 側邊欄顯示 Saved（不是 Local only — not synced）。

### C. 第二個帳號看不到資料（驗收 16）

- [ ] 在 Supabase Dashboard 新增第二個測試使用者（Add user，勾選 Auto Confirm）。
- [ ] 用私密視窗以第二個帳號登入：看到的是空的，看不到第一個帳號的專案；在這個帳號建立一個專案，回第一個帳號看不到它。
- [ ] 把第一個帳號某個專案的網址（含任務的 `?task=` 網址）貼到第二個帳號的視窗：顯示找不到，不會顯示內容。
- [ ] 測完在 Dashboard 刪除第二個測試使用者（它的資料會一併刪除）。
- [ ] 執行 `supabase/README.md` 第 2 節的查詢，結果符合預期；Dashboard 的 **Security Advisor** 沒有 RLS 相關錯誤。
- [ ] 匿名 curl 檢查（`supabase/README.md` 第 2 節）回傳 `permission denied`，而不是資料。

### D. 真實中文輸入法

- [ ] 用注音（或你平常用的輸入法）輸入中文任務名稱、專案名稱、搜尋關鍵字：選字時按 Enter 確認候選字，不會提前送出或關閉視窗。
- [ ] 選字過程中按 Esc，不會關掉對話框或清掉 Projects 的篩選框。
- [ ] 在 Safari 重複上面兩項（Safari 的按鍵順序與 Chrome 不同）。

### E. Safari 與 Firefox（10 分鐘，用乾淨的設定檔或私密視窗）

先在本機模式（不連雲端）或正式網址都可以。

- [ ] List：用把手拖曳任務到新位置，重新整理，順序保持。
- [ ] Board：把卡片拖到另一欄，也在同一欄內排序，重新整理。
- [ ] Gantt：拖曳長條、拖曳左右邊緣、從結尾把手拉出依賴線，重新整理後日期正確；拖曳時不會選取到文字。
- [ ] Task Modal：打開任務，在日期選擇器選開始與截止日，按 Cmd+Enter 儲存。
- [ ] Cmd+K 開啟搜尋，輸入、方向鍵、Enter 都正常；中文輸入法選字時 Enter 不會送出。
- [ ] Board 的「Add task」：欄位為空時點它、再點 Add task，欄位保持開著。
- [ ] Console 沒有 CSP 錯誤。

選用的自動化版本（每個瀏覽器約下載 250 MB，**從未執行過**）：
`npx playwright install webkit firefox`，然後 `npx playwright test -c playwright.crossbrowser.config.ts`。
Playwright 的 WebKit 不等於真正的 Safari，手動檢查仍然需要。

### F. Windows（只有在你會用 Windows 時）

- [ ] 在真實 Windows 電腦的 Chrome 或 Edge 開啟網站：版面對齊、沒有整頁橫向捲軸、字型正常。
- [ ] 快捷鍵是 Ctrl+K（不是 Cmd+K），說明視窗（`?`）與頂端列也顯示 Ctrl。
- [ ] 用微軟注音輸入中文，重複 D 的項目。

自動化測試只在 Mac 上用瀏覽器識別與顯示比例「模擬」Windows，沒有在真實 Windows 上跑過。

### G. 備份

- [ ] **Settings → Data → Export JSON backup** 下載備份，確認檔案可以開啟；之後定期重做（Supabase Free 沒有自動備份）。
