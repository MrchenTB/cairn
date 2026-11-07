# 部署指南：GitHub ＋ Vercel（網站）＋ Supabase（資料）

| 部分   | 服務                     | 負責                                          |
| ------ | ------------------------ | --------------------------------------------- |
| 程式碼 | GitHub Private           | 版本紀錄、Pull Request                        |
| 網站   | Vercel（Hobby）          | PR 產生 Preview，`master` 產生正式站          |
| 資料   | Supabase（Free），兩專案 | Staging 給測試與 Preview，Production 放真資料 |

日常開發與發布流程見根目錄的 [`CLAUDE.md`](../CLAUDE.md)。真實 Staging 的驗收結果見 [`production-readiness.md`](production-readiness.md) 第 7 節。

Vercel Hobby 限個人非商業使用，符合 Cairn 的用途。

**目前狀態（2026-11-07）：** 已正式部署，網址 <https://cairn-omega-blue.vercel.app>。Vercel 專案 `cairn`（帳號範圍 `zhao-xuan-chen-s-projects`），正式分支 `master`，資料在 `cairn-production`。下面的首次設定是紀錄，重建環境時照做。

## 首次設定

依序進行，每個階段確認成功才做下一個。第一次合併之前，`master` 不會有任何改動。

### 階段 1：GitHub Private Repository

1. 在專案資料夾執行 `gh auth login`，選 GitHub.com、HTTPS，用瀏覽器授權。
2. 確認 git 的 commit email（`git config user.email`）在 GitHub **Settings → Emails** 中，Vercel 靠它辨認作者。
3. 由 Claude 建立私有 repo，推送 `master` 與工作分支，並開第一個 PR。Repo 要放在**個人帳號**下：Vercel Hobby 不能部署 GitHub 組織底下的 private repo。

### 階段 2：Supabase Production

流程與 Staging 相同，詳細步驟見 [`supabase/README.md`](../supabase/README.md)。

1. 建立新專案（建議與 Staging 同區域）。資料庫密碼存入密碼管理工具。
2. **SQL Editor** 依檔名順序執行 `supabase/migrations/` 的每個檔案，再執行 `supabase/verify.sql`，確認全部 `pass = true`。
3. **Authentication → Users → Add user**，建立自己的帳號並勾選 Auto Confirm。密碼不要與測試帳號相同。
4. **Authentication → Sign In / Providers**，關閉 **Allow new users to sign up**。不要關閉 Email provider。
5. 把 Project ref 告訴 Claude，由它填入 `src/data/supabaseProjects.ts` 的 `PRODUCTION_PROJECT_REF`。Project ref 與 publishable key 都不是機密，但 publishable key 不需要給 Claude，下一階段直接填在 Vercel。

### 階段 3：建立 Vercel 專案

**新的 Vercel 專案，第一個 Git 部署一定會成為正式部署，不論是哪個分支。** 2026-11-07 實際發生：正式分支已設為 `master`，推送 PR 分支後，Vercel 仍把它部署成正式站。所以任何新專案都不得假設連接 Git 或推送分支不會部署：連接前先設好 Production 變數，並確認第一個會被推送的分支可以直接上線。

也不要用 Dashboard 的 Import：它會立刻部署 `master`，而當時的 `master` 沒有 `vercel.json`，會變成沒有安全標頭與環境防護的網站。

1. 到 <https://vercel.com/signup> 用 GitHub 帳號註冊（Hobby），停在匯入頁面，不要按 Import 或 Deploy。
2. 登入 CLI 並建立空專案，只建立設定，不部署：`npx vercel@latest login`、`npx vercel@latest project create cairn`。
3. 連接 GitHub：`npx vercel@latest link --yes --project cairn`、`npx vercel@latest git connect --yes`。`link` 會自動產生含暫時憑證的 `.env.local` 並修改 `.gitignore`，Cairn 用不到，請刪除該檔並還原 `.gitignore`。連接後確認 **Deployments** 是空的。
4. **Settings → Environments → Production → Branch Tracking**：確認正式分支是 `master`。
5. **Settings → Environment Variables**：勾選 **Enable access to System Environment Variables**。環境防護靠 `VERCEL_ENV` 判斷環境。
6. 同一頁先新增 Preview 的兩筆，再新增 Production 的兩筆，每筆只勾一個環境：

   | 變數                            | 環境       | 值                            |
   | ------------------------------- | ---------- | ----------------------------- |
   | `VITE_SUPABASE_URL`             | Preview    | Staging 的 Project URL        |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | Preview    | Staging 的 publishable key    |
   | `VITE_SUPABASE_URL`             | Production | Production 的 Project URL     |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | Production | Production 的 publishable key |

   Dashboard 的 Preview 選項可能只列出個別分支。要套用到所有 Preview 分支，改用 CLI 且不指定分支：`npx vercel@latest env add <名稱> preview --no-sensitive`（URL 可加 `--value`；key 由你在自己的終端機輸入）。

   不要勾 Development。範圍設錯時建置會失敗並說明原因（`src/data/supabaseProjects.ts`），不會連到錯的資料庫。但同一專案內 URL 和 key 配錯對時防護抓不到，請仔細核對。

7. **Settings → Deployment Protection**：確認 Vercel Authentication 為 **Standard Protection**，只有你登入 Vercel 後才能開 Preview。
8. **Settings → General → Vercel Toolbar**：Preview 設為 Off。工具列的腳本會被 CSP 擋下，留著會在 Console 產生無關的錯誤。
9. 全部設定完成後刪除本機的 `.vercel/`，並執行 `npx vercel@latest logout`。日常流程不需要 CLI，Preview 網址可從 PR 取得。

Node 版本由 `package.json` 的 `engines`（24.x）決定，建置設定由 `vercel.json` 決定，兩者都不用在 Vercel 設定。

### 階段 4：Staging 接受 Preview 網址

1. Staging 的 **Authentication → Users → Add user**，建立 Preview 驗收帳號（勾 Auto Confirm）。不要沿用測試帳號 A、B，自動測試遇到其中有非測試專案就會停止。
2. Staging 的 **Authentication → URL Configuration → Redirect URLs** 加入下面兩筆，`<slug>` 是 Vercel 帳號代稱，可在 Preview 網址的結尾看到：
   - `https://*-<slug>.vercel.app`
   - `https://*-<slug>.vercel.app/**`
3. Staging 的註冊可以在此時關閉。

### 階段 5：第一次 Preview 與發布

2026-11-07 的實際經過：第一次發布沒有走 Preview。推送 PR #1 的分支（`1f805d2`）時，Vercel 直接部署成正式站。使用者驗收後才以 merge commit 合併到 `master`，之後正式站改由 `master` 部署。Preview 變數與階段 4 在同一天補上。

1. 第一個 PR 重新建置後，從 PR 頁面打開 Preview 網址，用驗收帳號登入，走過「上線後手動驗收清單」的 B、E 兩組。建置紀錄應顯示 `Vercel preview build uses Supabase project …`，那是 Staging 的 ref。
2. 通過後，由你同意，Claude 合併 PR，Vercel 部署正式站。確認建置紀錄有 `Vercel production build uses Supabase project …`，且那是 Production 的 ref。
3. Production 的 **Authentication → URL Configuration**：Site URL 與 Redirect URLs 都設成正式網址（結尾不加 `/`）。不要加入 localhost。
4. 用自己的帳號登入正式站，建一個專案，確認側邊欄是 Saved，到 Production 的 Table Editor 看得到資料。
5. **Settings → Data → Export JSON backup** 匯出一次，確認備份流程可用。

本機模式的舊資料要搬上來時，先在本機模式匯出 JSON，再於正式站匯入。

## 部署被 Vercel 阻擋時

[官方文件](https://vercel.com/docs/git#deploying-private-git-repositories)說，Hobby 的 private repo 只部署專案擁有者的 commit，靠 commit 作者與 Vercel 登入連結比對。[社群也有人回報](https://community.vercel.com/t/hobby-account-private-repo-collaborators-deployment-blocked/1030)訊息為「commit author 沒有 contributing access」的阻擋，並懷疑 `Co-Authored-By` 署名也會觸發。官方沒有說明署名的影響。實測（2026-11-07）：帶 `Co-Authored-By` 署名的 commit 可以正常部署。若之後仍被阻擋，依序處理：

1. 確認 commit email 已加入 GitHub 帳號，且 Vercel 是用同一個 GitHub 帳號登入。
2. 仍被阻擋，就請 Claude 在之後的 commit 拿掉署名（`.claude/settings.json` 的 `attribution`），並重推最新一個 commit。
3. 還是不行，再考慮把 repo 改為公開或升級 Pro，這兩項都由你決定。

---

## 免費方案限制與風險（請務必知道）

- **Supabase Free 沒有自動備份**，也沒有時間點還原。請定期在 App 的 **Settings → Data → Export JSON backup** 下載備份。還原是把備份匯入成**新的副本**，不會覆蓋或合併既有資料。
- **Supabase Free 專案閒置約 7 天會被暫停**；到 Dashboard 按 Restore 即可恢復（資料保留，但暫停期間 App 無法讀寫）。
- Free 方案最多 2 個進行中的專案；資料庫容量與流量對個人使用綽綽有餘，詳見 `docs/platform-notes.md` A1。
- Vercel Hobby 的流量與建置額度對個人使用綽綽有餘；Instant Rollback 只能回到上一個部署。
- 免費額度與政策可能變動，請以官方頁面為準；本專案不保證永久免費或永不停機。
- 忘記密碼的信件同樣受內建寄信限制；需要寄到其他信箱時要自行設定 custom SMTP（可能產生費用）。

## 絕對不要做的事

- 不要把 `service_role` 或 `sb_secret_…` key 放進任何 `VITE_*` 變數或提交到 Git（它會繞過 RLS）。
- 不要在 Supabase 關閉 RLS，或用 Dashboard 對資料表加上 `anon` 權限。

---

## 上線後手動驗收清單

自動化測試已在真實 Staging 上通過（`production-readiness.md` 第 7 節），但只有 Chromium、同一台電腦，不能代替這份清單。除了標註的項目，都可以在 Preview 用驗收帳號做，不必動到正式資料。請做完一項，就自己記下日期與結果。

### A. 真實 email 連結（驗收 1）

- [ ] 在登入頁點 **Forgot password?**，收到重設密碼的信，點信中連結會回到你的網站並能設定新密碼。
- [ ] 連結沒有導向 `localhost` 或錯誤網址（若有，回頭檢查階段 4 或階段 5 的 Redirect URLs）。
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
- [ ] 執行 `supabase/verify.sql`，每一列 `pass = true`；Dashboard 的 **Security Advisor** 沒有 RLS 相關錯誤。
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
- [ ] Task Modal：打開任務，選開始與截止日（選了就存），改標題按 Enter，打一段描述後按 Esc，重新開啟確認都存到。
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
