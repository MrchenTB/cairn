# Cairn — Plan clearly. Work simply.

給個人使用的輕量專案管理 Web App：同一份任務資料，提供 **List、Board（Kanban）、Gantt** 三種視圖，
加上 Overview、My Tasks、跨專案 Timeline 與全域搜尋。介面受 Linear 啟發（原創設計），
資料透過 **Supabase（Auth + Postgres + RLS）** 在不同電腦間同步，前端可免費部署在 **Vercel**。

> 狀態：版本 1.0.0，功能已完成，並以本機自動化測試驗證；真實 Supabase Staging 驗收已通過；**Production 尚未建立**（見 [`docs/production-readiness.md`](docs/production-readiness.md) 第 7 節）。
> 已完成／待你操作／尚未完成的清單、驗收結果與已知限制見 [`docs/progress.md`](docs/progress.md)。

## 快速開始（本機）

需求：Node.js 24（`package.json` engines 為 `24.x`，`.node-version` 指定 24）、npm。

```bash
npm install
```

```bash
npm run dev
```

開啟 http://localhost:5173 。

- **沒有設定 Supabase 時**，App 以「本機模式」執行：資料只存在這個瀏覽器（localStorage），不需登入，
  側邊欄會明確顯示 **Local only — not synced**。適合先試用；**不是**雲端同步。
- 要跨電腦同步，請完成下方「Supabase 設定」，把金鑰填進 `.env.local` 後重新啟動。

## Supabase 設定（雲端資料庫與登入）

詳細步驟見 [`supabase/README.md`](supabase/README.md)。最短流程：

1. 在 https://supabase.com 建立免費專案。
2. 打開專案的 **SQL Editor**，依檔名順序貼上並執行 `supabase/migrations/` 內的**每一個** SQL（目前 2 個），再執行 `supabase/verify.sql` 確認全部 `pass`。
3. 在 **Project Settings → API** 複製 Project URL 與 **publishable（或 anon）key**。
4. 複製 `.env.example` 為 `.env.local` 並填入：
   ```bash
   cp .env.example .env.local
   ```
5. `npm run dev`，登入（或註冊）自己的帳號。Supabase 預設要求 email 確認，內建寄信服務有限制，建議改在 Dashboard 直接新增使用者並勾選 Auto Confirm，細節見 [`docs/deployment.md`](docs/deployment.md)。
6. 建立好自己的帳號後，到 **Authentication → Providers / Settings** 關閉新使用者註冊（避免陌生人註冊）。

部署到 Vercel 與上線後的驗收清單見 [`docs/deployment.md`](docs/deployment.md)。

> ⚠️ 只有 publishable／anon key 可以放在前端。**永遠不要**把 service role key 放進 `.env.local` 或提交到 Git。

## 常用指令

| 指令                 | 說明                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run dev`        | 開發伺服器                                                                                       |
| `npm run build`      | 型別檢查 + 產生正式版到 `dist/`                                                                  |
| `npm run typecheck`  | TypeScript 型別檢查                                                                              |
| `npm run lint`       | oxlint 程式碼檢查                                                                                |
| `npm test`           | 所有 Vitest 測試（domain 單元測試、元件測試、資料庫／RLS 測試）                                  |
| `npm run test:unit`  | 只跑單元與元件測試（不含資料庫）                                                                 |
| `npm run test:db`    | 只跑資料庫 migration、約束與 RLS 測試（PGlite，不需 Docker）                                     |
| `npm run test:e2e`   | Playwright 端對端測試（本機模式）                                                                |
| `npm run test:cloud` | Playwright 端對端測試（雲端模式，對本機模擬的 Supabase，不需帳號）                               |
| `npm run test:prod`  | 用正式版 build 與真實的 `vercel.json` 跑主要流程（CSP、深層網址、lazy chunks、不外洩測試程式碼） |
| `npm run preview`    | 在本機預覽已建置的 `dist/`（先執行 `npm run build`）                                             |

E2E 測試需要 Playwright 的 Chromium（第一次執行前：`npx playwright install chromium`）。目前自動化測試只在 Chromium 跑過；Safari 與 Firefox 請依 [`docs/deployment.md`](docs/deployment.md) 最後的清單手動檢查。各組測試的數字與日期見 [`docs/progress.md`](docs/progress.md) 第 3 節。

## 文件

- [`docs/production-readiness.md`](docs/production-readiness.md)：上線準備度：審查結果、風險、還缺什麼
- [`docs/cloud-test-plan.md`](docs/cloud-test-plan.md)：Staging 環境建立步驟與真實雲端驗收清單
- [`docs/deployment.md`](docs/deployment.md)：部署步驟（Supabase＋Vercel）與需要你親自完成的事項
- [`docs/architecture.md`](docs/architecture.md)：架構、資料模型、規則與重要取捨
- [`docs/decisions.md`](docs/decisions.md)：決策紀錄
- [`docs/design-research.md`](docs/design-research.md)：Linear 設計研究與 design tokens
- [`docs/gantt-evaluation.md`](docs/gantt-evaluation.md)：甘特圖套件評估
- [`docs/platform-notes.md`](docs/platform-notes.md)：Supabase／Cloudflare 免費方案與限制（早期的 Cloudflare 調查紀錄，網站現已改用 Vercel）
- [`docs/task-autosave-implementation.md`](docs/task-autosave-implementation.md)：Task Modal 自動儲存的互動規則、測試結果與限制
- [`CLAUDE.md`](CLAUDE.md)：開發工作流程（模型分工與委派方式）
- [`docs/progress.md`](docs/progress.md)：進度與驗收結果（已完成／待你操作／尚未完成）、測試結果、已知限制
- [`supabase/README.md`](supabase/README.md)：資料庫 migration、RLS 檢查與 Auth 設定的詳細步驟
