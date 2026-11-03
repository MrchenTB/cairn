# Cairn — Plan clearly. Work simply.

給個人使用的輕量專案管理 Web App：同一份任務資料，提供 **List、Board（Kanban）、Gantt** 三種視圖，
加上 Overview、My Tasks、跨專案 Timeline 與全域搜尋。介面受 Linear 啟發（原創設計），
資料透過 **Supabase（Auth + Postgres + RLS）** 在不同電腦間同步，前端可免費部署在 **Cloudflare**。

> 狀態：開發中（本文件會隨每個階段更新；完成度與已知限制見 [`docs/progress.md`](docs/progress.md)）。

## 快速開始（本機）

需求：Node.js 22.12 以上（建議 24 LTS）、npm。

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
2. 打開專案的 **SQL Editor**，貼上並執行 `supabase/migrations/` 內的 SQL（建立資料表、RLS 權限、RPC）。
3. 在 **Project Settings → API** 複製 Project URL 與 **publishable（或 anon）key**。
4. 複製 `.env.example` 為 `.env.local` 並填入：
   ```bash
   cp .env.example .env.local
   ```
5. `npm run dev`，用 Email + 密碼註冊自己的帳號。
6. 建立好自己的帳號後，到 **Authentication → Providers / Settings** 關閉新使用者註冊（避免陌生人註冊）。

> ⚠️ 只有 publishable／anon key 可以放在前端。**永遠不要**把 service role key 放進 `.env.local` 或提交到 Git。

## 常用指令

| 指令 | 說明 |
|---|---|
| `npm run dev` | 開發伺服器 |
| `npm run build` | 型別檢查 + 產生正式版到 `dist/` |
| `npm run typecheck` | TypeScript 型別檢查 |
| `npm run lint` | oxlint |
| `npm test` | 所有 Vitest 測試（domain 單元測試、元件測試、資料庫／RLS 測試） |
| `npm run test:db` | 只跑資料庫 migration、約束與 RLS 測試（PGlite，不需 Docker） |
| `npm run test:e2e` | Playwright 端對端測試（本機模式） |

## 文件

- [`docs/architecture.md`](docs/architecture.md)：架構、資料模型、規則與重要取捨
- [`docs/decisions.md`](docs/decisions.md)：決策紀錄
- [`docs/design-research.md`](docs/design-research.md)：Linear 設計研究與 design tokens
- [`docs/gantt-evaluation.md`](docs/gantt-evaluation.md)：甘特圖套件評估
- [`docs/platform-notes.md`](docs/platform-notes.md)：Supabase／Cloudflare 免費方案與限制
- [`docs/progress.md`](docs/progress.md)：進度、測試結果、未完成事項
