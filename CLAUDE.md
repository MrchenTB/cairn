# Cairn

個人長期使用的專案管理工具，使用者只有擁有者一人，不做商業化與多人協作。同一份任務資料提供 List、Board、Gantt，加上 Overview、My Tasks、Timeline、全域搜尋。

- **原則：** 簡單、穩定、不遺失資料，優先於功能數量與企業級流程。沿用現有架構，不加不必要的工具或服務。
- **語言：** 回覆用繁體中文。App 介面文字與 `README.md` 用英文，其他文件用繁體中文。

## 技術與結構

React 19、TypeScript 7、Vite 8、Tailwind 4、zustand + immer（FIFO 寫入佇列、樂觀更新、欄位層級回滾）、react-router 8、Radix、Supabase（Auth、Postgres、RLS）、Vercel（靜態 SPA）。多個套件的主版本比訓練資料新，不確定 API 時先讀 `node_modules/` 內的型別。

| 位置                                 | 內容                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `src/domain/`                        | 純業務規則（排程、日期、驗證）                                                         |
| `src/data/`                          | 資料層、同步、Auth、環境防護（`supabaseProjects.ts`、`secretKeys.ts`）                 |
| `src/features/`                      | 各畫面：list、board、gantt、task-modal、settings 等                                    |
| `src/app/`、`components/`、`styles/` | 路由與外殼、共用元件、design tokens                                                    |
| `supabase/`                          | `migrations/`、`verify.sql`（唯讀檢查）                                                |
| `tests/`、`e2e*/`                    | DB／RLS、本機 Supabase 模擬器、Staging 檢查；各環境的 Playwright 測試                  |
| `vercel.json`                        | 安全標頭（CSP）、SPA fallback、建置設定                                                |
| `docs/`                              | `architecture.md`、`decisions.md`、`deployment.md` 等；`archive/` 為歷史報告，不再更新 |

工程規則以 `docs/architecture.md` 為準，新的取捨記為 `docs/decisions.md` 的下一個編號。已知問題見 `docs/production-readiness.md` 第 8 節（F1–F4 待修），不要順手修改，除非任務就是修它。

## 開發流程

使用者用自然語言提出需求，以下由 Claude 自行完成，不要求使用者操作 Git：

1. 從最新的 `master` 開功能分支（`feature/…`、`fix/…`、`chore/…`）。需求或取捨不明確時先問。
2. 實作並補必要的測試。
3. 跑下一節的檢查，確認沒有影響既有功能或資料。
4. 推送分支、建立 Pull Request，內文寫：改了什麼、怎麼驗收、是否動到資料庫。
5. 從 `gh pr checks` 或 PR 留言取得 Preview 網址，交給使用者驗收。
6. 使用者要修改就在同一分支繼續。**使用者明確同意發布後**才合併，用一般 merge commit（`gh pr merge --merge --delete-branch`），不用 squash、rebase 或強制推送。

Commit 只在功能分支。不直接推 `master`，不強制推送。專案指令前加 `export PATH=$HOME/.local/node/current/bin:$PATH;`（這台電腦預設的 Node 版本太舊）。長時間測試用 `caffeinate -i`，闔上筆電會造成假失敗。

## 測試

| 時機                    | 指令                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| 每次建立或更新 PR 前    | `npm run verify`（格式、lint、型別、建置、Vitest）                |
| 動到 UI 或互動          | `npm run test:e2e`（可先跑相關 spec）                             |
| 動到資料層、同步、Auth  | `npm run test:cloud`（本機模擬，不需帳號）                        |
| 動到 `vercel.json`、CSP | `npm run test:prod`                                               |
| 動到資料層或 migration  | `npm run test:staging:core`（真實 Staging，先跑 `check:staging`） |

回報實際結果。失敗就說失敗，略過就說略過。

## 環境隔離

| 使用處                | Supabase 專案  | 帳號                          |
| --------------------- | -------------- | ----------------------------- |
| `npm run dev`         | 無（本機模式） | 無                            |
| `npm run dev:staging` | Staging        | Preview 驗收帳號              |
| `test:staging`        | Staging        | 測試帳號 A、B（只放測試資料） |
| Vercel Preview        | Staging        | Preview 驗收帳號              |
| Vercel Production     | Production     | 使用者本人                    |

- `vite.config.ts` 用 `src/data/supabaseProjects.ts` 強制執行：Preview 只能連 Staging，Production 不能連 Staging 也不能沒有設定，本機不能連 Production。不得放寬這個檢查。
- Production 的變數只放在 Vercel（Production 範圍）。本機不存在 Production 的設定檔。
- 所有 Preview 共用 Staging。自動測試只碰帳號 A、B 內名稱以 `[e2e] ` 開頭的專案，驗收帳號不受影響。同時間只保留一個含 migration 的 PR，否則其他 Preview 會對不上資料庫結構。
- 前端只用 publishable key。任何地方都不使用 service_role 或 `sb_secret_` key，也不向使用者索取。密碼與金鑰不輸出到終端機、文件或對話。

## 資料庫 Migration

1. 只新增檔案到 `supabase/migrations/`，不改已套用的 migration，並同步更新 `supabase/verify.sql` 與 `tests/db/`。
2. 只做向後相容的變更（新增欄位、資料表）。舊版前端在發布前後都要能運作，因為 Production 的 migration 先於合併。刪除或改名要分兩個版本。
3. 順序：`npm run test:db` → 請使用者在 **Staging** SQL Editor 執行 → `verify.sql` → `test:staging:core` → Preview 驗收。
4. 發布前，請使用者從正式站 **Settings → Data → Export JSON backup** 匯出並確認檔案可開啟，再經同意在 **Production** 執行與 `verify.sql`，最後才合併。

Supabase Free 沒有自動備份。JSON 還原會匯入成新副本，不會覆蓋既有資料。

## 發布與回復

- **發布：** 合併到 `master`，Vercel 自動部署正式站 <https://cairn-omega-blue.vercel.app>。之後確認部署成功、建置紀錄的 Supabase ref 是 Production，並提醒使用者開網站看一眼。
- **新的 Vercel 專案：** 第一個 Git 部署不論分支都會成為正式部署。重建或新增專案時，不得假設連接 Git 或推送分支不會部署。
- **回復網站：** Vercel → Instant Rollback（Hobby 只能回到上一個部署）。回復後自動部署會暫停，修好時要按 **Undo Rollback** 才恢復。接著用 `git revert` 開 PR 修正 `master`。
- **回復資料：** migration 沒有自動復原。依回復前的 JSON 備份匯入，或另外寫修正 migration。

## 必須先取得使用者明確同意

- 合併到 `master`、發布正式版本、Vercel 的 Production 操作
- 對 Production Supabase 的任何操作，或任何可能遺失資料的操作
- 涉及金鑰、權限、RLS、Auth、CSP 或環境防護的重要修改（先說明影響）
- 刪除遠端分支以外的 GitHub、Vercel、Supabase 資源，或變更其設定
- 新增付費服務或大型相依套件

需要使用者登入外部平台時，一次只帶一個階段，確認成功才繼續。`.claude/settings.json` 對合併、推送 `master`、強制推送、Vercel 與 Supabase CLI 設有確認提示。

# 模型分工

主對話用 Opus（使用者設定 `model: opus`），負責判斷、規劃與委派；執行交給 Sonnet。依任務複雜度分配模型，不必每件事都開 Agent。

| 模型       | 負責                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Opus 5.5   | 系統架構設計與技術選型、複雜問題分析與除錯策略、新功能的需求分析與實作規劃、跨模組整合與重要重構、需要權衡取捨的技術決策、重要程式碼的架構審查 |
| Sonnet 5.5 | 依既定規劃寫程式、一般功能實作與修改、UI/UX 細節調整、常規 Bug 修復、單元測試、文件更新與程式碼整理、其他需求明確且做法單純的任務              |

## 委派方式

- 重要任務由 Opus 規劃後再委派；需求明確的工作不必先規劃，直接交給 `implementer`（Sonnet）。
- 幾個工具呼叫就能完成的小事，在目前的對話直接做，不開 Agent。
- `Explore` 和 `general-purpose` 預設繼承主對話的 Opus，呼叫時要傳 `model: sonnet`，只有上表 Opus 範圍內的工作才用 Opus。`Plan` 留在 Opus。
- Workflow 腳本的 `agent()` 一律明確傳 `model`，不要依賴繼承。

## 回報與接手

Sonnet 遇到架構性問題、重大技術取捨或需求不明確時不自行決定：停下來回報問題、可行選項與建議。Opus 判斷後用 `SendMessage` 接續同一個 Agent，不重新分析。Workflow 中的 Agent 無法中途詢問，把問題列在回報裡，其餘工作繼續做。
