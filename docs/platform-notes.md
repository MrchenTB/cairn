# Platform Notes：平台事實與套件版本查核

> 查核日：**2026-11-02**。除非另外註明，本文所有網址的存取日期都是 2026-11-02。
> 範圍：PRD §6、§6.1、§11 要求「以當下官網與實際執行狀況為準」的平台限制、安全設定與套件版本。
> 原則：只寫查得到的事實與實測結果。推論與建議都會標明；查不到的就寫「未驗證」，不猜。

**標記說明**

- 〔實測〕：在 repo 以外的暫存目錄實際安裝並執行過（做法見附錄 A）。
- 〔文件〕：讀過官方文件、changelog 或 release notes（網址在該段或第 E 節）。
- 〔npm〕：`npm view` 從 npm registry 查到的結果。
- 〔未驗證〕：本次無法確認，例如需要登入雲端帳號，或官方頁面不存在。

---

## 0. 先讀：依 2024–2025 年經驗做事會出錯的地方

| # | 領域 | 現況（2026-11-02） | 會出錯的舊做法 |
|---|---|---|---|
| 1 | Supabase Data API | 2026-05-30 起，**新專案**在 `public` 新建的表**不會自動**開放給 Data API（supabase-js／REST）。2026-10-30 起，**所有專案**都套用這個行為。〔文件〕 | 只寫 `create table` 加 RLS policy，沒寫 `GRANT`。結果 supabase-js 回 `42501 permission denied for table …`。 |
| 2 | Supabase CLI | **v3.0.0 今天（2026-11-02）才發布**。`db push`、`gen types`、`db dump` 等指令**預設改打本機 stack**，要加 `--remote` 才會推到雲端專案。改動雲端前會先問，直接按 Enter 等於**拒絕**；CI 必須加 `--yes`。〔文件〕〔實測 `--help`〕 | `npx supabase db push` 以為會推到已 link 的專案。 |
| 3 | Supabase API key | 前端改用 **publishable key**（`sb_publishable_…`），官方 React 範例的變數名是 `VITE_SUPABASE_PUBLISHABLE_KEY`。舊的 `anon`／`service_role` JWT key 會在 **2026 年底前**淘汰。〔文件〕 | 繼續用 `VITE_SUPABASE_ANON_KEY` 和舊 anon JWT。 |
| 4 | Supabase Auth 郵件 | 內建 SMTP **只寄給專案團隊成員的信箱**，**每小時 2 封**，而且不適合正式用途。〔文件〕 | 以為註冊確認信、重設密碼信可以寄到任意信箱。 |
| 5 | Supabase Free | **沒有任何自動備份或 PITR**。連續 7 天活動量太低，專案會被暫停；暫停後 1 年內可以在 Dashboard 恢復。〔文件〕 | 以為 Free 有每日備份。 |
| 6 | TypeScript 7 | `baseUrl` 已**移除**，寫了會直接報錯（TS5102）。`strict` 預設為 `true`，`types` 預設為 `[]`，`noUncheckedSideEffectImports` 預設為 `true`。**7.0 沒有 JS API**。〔實測〕〔文件〕 | 照 shadcn 文件在 tsconfig 加 `"baseUrl": "."`。 |
| 7 | shadcn CLI 4.x | **根目錄的 `tsconfig.json` 也要有 `compilerOptions.paths`**，否則元件會被寫進字面上的 `./@/components/...` 資料夾。要用 Radix 必須加 `--base radix`，不加時 `--defaults` 會選 Base UI 的 `base-nova` preset。產生的程式碼改用 `cn` 套件。〔實測〕 | 只在 `tsconfig.app.json` 設 alias；以為 shadcn 預設就是 Radix。 |
| 8 | React Router 8 | `react-router-dom` **已移除**。Data mode 的 `RouterProvider` 要從 `react-router/dom` 匯入，其他 API 從 `react-router` 匯入。套件改為 ESM-only，需要 Node ≥ 22.22.0、React ≥ 19.2.7。〔文件〕〔實測 build〕 | `import … from "react-router-dom"`。 |
| 9 | Vite 8 | 改用 Rolldown 和 Oxc。`build.rollupOptions` 改名為 `build.rolldownOptions`，並內建 `resolve.tsconfigPaths`。〔文件〕〔實測〕 | 繼續設定 esbuild 相關選項，或另裝 `vite-tsconfig-paths`。 |
| 10 | react-day-picker 10 | 推薦的套件名改為 `@daypicker/react`。`initialFocus`、`fromDate`、`toDate` 等 v9 舊 props **已刪除**，寫了會出型別錯誤。〔實測〕〔文件〕 | 照 2024 年 shadcn date-picker 範例寫 `<Calendar initialFocus />`。 |
| 11 | lucide-react 1.x | **品牌圖示全部移除**（`Github`、`Figma`、`Slack` 等）。圖示預設帶 `aria-hidden`。〔實測〕〔文件〕 | 用 `Github` icon。 |
| 12 | Vitest 5／jsdom | Vitest 5 需要 Node `^22.12 \|\| ^24 \|\| >=26`；`clearMocks` 預設為 `true`；不再往上層目錄找 config。jsdom 沒有 `ResizeObserver`、`matchMedia`、`scrollIntoView`。jest-dom 7 要求 `@testing-library/dom` 作為 peer。〔文件〕〔實測〕 | 沒有寫 polyfill，`cmdk` 測試直接 crash。 |
| 13 | Node 版本 | 本機是 **Node 23.9.0**（奇數版，已 EOL），不在 Vitest 5 和 jsdom 30 的 `engines` 範圍內，雖然實測可以跑。最新 LTS 是 24.22.2 和 26.13.0。〔npm〕〔實測〕 | `package.json` 的 `engines: >=22.12` 低於 react-router 8 要求的 22.22.0。 |
| 14 | Cloudflare | Pages 文件明確寫「Start new projects with Workers」。Workers Static Assets 的 SPA fallback **要自己設定**；沒有對應檔案時，連 `/assets/missing.js` 也會回 `200 index.html`。〔文件〕〔實測 wrangler dev〕 | 以為 Workers 跟 Pages 一樣會自動做 SPA fallback。 |
| 15 | 排序鍵 | fractional-indexing 的 key **區分大小寫**，必須用 code-unit 順序比較。DB 欄位要加 `COLLATE "C"`，JS 端不可用 `localeCompare`。〔實測〕 | `ORDER BY sort_order` 時依賴資料庫的 locale collation。 |
| 16 | 日期 | `new Date('2026-11-02')` 會被當成 **UTC 午夜**，在 UTC−8 會變成 11/01。〔實測〕 | 用 `new Date(str)` 處理日期型欄位。 |

---

## A. Supabase

### A1. Free plan 額度〔文件〕

來源：<https://supabase.com/pricing>

| 項目 | Free | 備註 |
|---|---|---|
| Database 容量 | 每個專案 500 MB | Shared CPU，500 MB RAM |
| MAU | 50,000 | 單人使用遠低於上限 |
| Egress | 5 GB，另有 5 GB cached egress | |
| File storage | 1 GB，單檔上限 50 MB | 本專案目前不需要 |
| 專案數 | 最多 2 個 active projects | 使用者若已經有其他 Free 專案，名額可能不夠 |
| 閒置暫停 | 1 週活動量太低就會暫停 | 見 A2 |
| 自動備份／PITR | **都沒有** | 見 A3 |
| Log 保留 | 1 天 | |
| Edge Functions | 每月 500,000 次 | 本專案不用 |
| Realtime | 200 個同時連線、每月 2M 則訊息 | 本專案 V1 不一定會用 |

Pro 方案每月 $25 起，包含每日備份（保留 7 天）、8 GB disk、250 GB egress。**未經使用者同意，不可以升級。**

### A2. 閒置暫停與恢復〔文件〕

來源：<https://supabase.com/docs/guides/platform/project-pausing>（`/free-project-pausing` 的內容相同）

- **觸發條件**：過去 7 天「使用者資料庫活動」不足。文件寫「通常每天有幾個對資料庫的使用者請求就夠了」。
- **通知**：暫停前大約一週會寄警告信，暫停後再寄一封確認信。
- **恢復步驟**：Dashboard → 選擇組織 → 選擇被暫停的專案 → **Resume project** → 確認。專案會帶著原本的資料和設定回來。
- **可恢復期限**：目前的官方文件寫「暫停後 **1 年**內」可以恢復。2024-06 的 changelog（<https://supabase.com/changelog/27497-paused-free-plan-projects-are-restorable-for-90-days>）寫的是 90 天，搜尋引擎的快取版本也還是 90 天。**以 2026-11-02 讀到的現行文件為準：1 年。** 超過期限後怎麼處理，文件沒有說明〔未驗證〕。
- **對 App 的影響（建議）**：使用者放假超過一週回來，專案可能已經暫停，此時所有 API 請求都會失敗。前端應該顯示明確的錯誤，例如「雲端服務無法連線，可能已被暫停」，不能 silent failure（PRD §5.4）。

### A3. 備份：Free 沒有，所以要做 App 層的 JSON 匯出〔文件〕

來源：<https://supabase.com/docs/guides/platform/backups>、pricing 頁

- 官方文件只說「Pro、Team、Enterprise 專案每天自動備份」。Free 專案**沒有**每日備份，也**沒有** PITR。
- 文件建議 Free 專案定期用 CLI 的 `supabase db dump` 自行匯出，並保存一份 off-site 備份。v3 版要寫成 `supabase db dump --remote -f backup.sql`。CLI v2 的 `db dump` 需要 Docker，v3 是否仍需要〔未驗證〕。
- **對使用者的意義**：在 Free 方案上，誤刪資料、寫壞 migration 或帳號出問題時，**Supabase 沒辦法幫你救回來**。PRD 要求 Settings 提供「Export / backup」，這就是唯一的保險。
- **建議的 App 層匯出（設計建議）**：
  - 用 supabase-js 依序讀出 `projects → phases → tasks → milestones → task_dependencies → user_preferences`。**每張表都要用 `.order('id').range(from, to)` 分頁**，因為 API 預設最多回傳 1000 列，超過的部分會被**直接截斷**（見 A10）。
  - 輸出 `{ "format": "cairn-backup", "schemaVersion": 1, "exportedAt": "…", "tables": { … } }`，並觸發瀏覽器下載。
  - 匯入時先用 zod 驗證，再用**一個 `security invoker` 的 RPC** 依相依順序 upsert。PostgREST 每個請求都在單一 transaction 中執行，失敗會整筆 rollback，見 A9。
  - 建議 UI 提示「最後一次匯出：N 天前」。

### A4. Postgres 版本與 `ON DELETE SET NULL (column_list)`〔文件〕〔實測〕

- **新的雲端專案預設 Postgres 17**。Changelog（2026-05-18，<https://supabase.com/changelog/46080-self-hosted-supabase-upgrading-from-pg-15-to-17-breaking-change>）原文是「Postgres 17 is what we currently default to on the Supabase platform」。CLI v3 執行 `supabase init` 產生的 `config.toml` 也是 `[db] major_version = 17`〔實測〕。
- 相關異動：Postgres 14 支援已在 2026-07-01 結束。2026-09 有 15.19／17.11 的 minor 更新，修正了 44 個 CVE。pg_graphql 對新專案預設**不再啟用**。
- **`ON DELETE SET NULL (col, …)`**：這是 PG15 新增的功能（<https://www.postgresql.org/docs/release/15.0/>）。PG17 文件寫道「A subset of columns can only be specified for `ON DELETE` actions」（<https://www.postgresql.org/docs/17/sql-createtable.html>），也就是欄位清單**只能用在 ON DELETE**，不能用在 ON UPDATE。Supabase 是 PG17，所以**支援**。
- 實測：在 PGlite（PG 18.6）跑了下面這段 SQL。刪除 phase 後，`phase_id` 變成 NULL，`user_id` 保持不變。

  ```sql
  constraint tasks_phase_fk foreign key (phase_id, user_id)
    references public.phases (id, user_id) on delete set null (phase_id)
  ```

  用途：以複合 FK 確保「任務只能指向同一位使用者（或同一專案）的 phase」。phase 被刪時只把 `phase_id` 清成 NULL，不會動到 NOT NULL 的 `user_id`／`project_id`。`parent_task_id`、`milestones.phase_id` 也可以用同樣做法。

### A5. API key 模型與環境變數〔文件〕

來源：<https://supabase.com/docs/guides/api/api-keys>、<https://supabase.com/docs/guides/getting-started/quickstarts/reactjs>

- **Publishable key**（`sb_publishable_…`）可以放在瀏覽器和原始碼裡。它能做到的事完全由 RLS 決定：沒登入時對應 `anon` role，登入後對應 `authenticated`。
- **Secret key**（`sb_secret_…`）對應 `service_role`，擁有 `BYPASSRLS`。**絕對不能進前端或 Git。**
- **舊的 `anon`／`service_role` JWT key**：官方文件寫「Supabase is deprecating the `anon` and `service_role` keys by the end of 2026」。新增 publishable／secret key 不會自動停用舊 key，要到 Settings → API Keys 手動停用。
- publishable／secret key **不是 JWT**，要放在 `apikey` header，不能放在 `Authorization: Bearer`。supabase-js 會自己處理，不需要手動加 header。
- **Vite 環境變數名稱**依官方 React quickstart：

  ```bash
  # .env.local（不要進 Git）；.env.example 只放名稱
  VITE_SUPABASE_URL=https://<project-ref>.supabase.co
  VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
  ```

  ```ts
  import { createClient } from '@supabase/supabase-js'
  export const supabase = createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  )
  ```

- `VITE_*` 的值會在 build 時**直接寫進 bundle**（<https://vite.dev/guide/env-and-mode>）。所以這些變數只能放公開值，publishable key 本來就屬於公開值。
- 型別：`npx supabase gen types --remote --lang typescript > src/lib/database.types.ts`，再用 `createClient<Database>(…)`〔實測 `--help`〕。

### A6. Auth：email + password〔文件〕〔實測：讀 supabase-js 原始碼〕

**預設值與流程**

- **Email 確認**：雲端專案**預設開啟**，本機和 self-hosted 預設關閉（<https://supabase.com/docs/guides/auth/passwords>）。設定位置在 Dashboard → Authentication → Sign In / Providers → Email → **Confirm email**。
- JS 端預設是 **implicit flow**：使用者點確認信連結後，官方說明是「your site receives the access token directly」，supabase-js 的 `detectSessionInUrl` 會自動讀取。要改成 PKCE，需要把確認信範本改成 `{{ .SiteURL }}/auth/confirm?token_hash=…`，再自己呼叫 `verifyOtp`。
- **內建 SMTP 的限制**（<https://supabase.com/docs/guides/auth/auth-smtp>）：
  - 只寄給「專案團隊成員」的信箱，其他收件人會得到 `Email address not authorized`。
  - 每小時 **2 封**，而且額度「可能未經通知就改變」。
  - 官方原文「not meant for production use」，不提供 SLA。
  - 改用 custom SMTP 後，預設上限為每小時 30 封，可以再調高。

**本專案建議的最短設定（單人使用）**

1. Dashboard → Authentication → Users → **Add user → Create new user**，輸入 email 和密碼，並勾選 *Auto Confirm User*，這樣就不需要寄確認信。這個 UI 選項來自社群文件，官方頁面沒有寫到，畫面標籤以實際 Dashboard 為準〔未驗證〕。
2. 關閉 **Allow new users to sign up**（Auth 的 general configuration，<https://supabase.com/docs/guides/auth/general-configuration>）。文件說明：「If this config is disabled, only existing users can sign in.」若用 CLI 管理設定，對應 `config.toml` 的 `[auth] enable_signup = false`。CLI v3 特別提醒：**不要**改 `[auth.email]` 底下的 `enable_signup`，那個會把整個 email provider 關掉，連既有使用者都無法登入。
3. 重設密碼（`resetPasswordForEmail`）走的是內建 SMTP，只有當使用者的 email 就是 Supabase 組織成員的 email 時才收得到，而且每小時 2 封。若要寄到其他信箱，需要設定 custom SMTP；這要使用者自己申請帳號，**不能自行開通付費服務**。

**Site URL／Redirect URLs**（<https://supabase.com/docs/guides/auth/redirect-urls>）

- 位置：Dashboard → Authentication → URL Configuration。
- **Site URL 預設是 `http://localhost:3000`**，這也是沒指定 `redirectTo`／`emailRedirectTo` 時的預設跳轉目標。部署後要改成正式網址。
- Vite dev server 預設跑在 **5173**，不是 3000。
- Redirect URLs 是 allow list。`*` 不會跨越 `.` 或 `/`，`**` 可以跨越任何字元。
- 建議設定（推論，請換成實際網域）：
  - Site URL：`https://cairn.<account>.workers.dev`（或自訂網域）
  - Redirect URLs：`http://localhost:5173/**`，再加上正式環境的**精確路徑**，例如 `https://cairn.<account>.workers.dev/reset-password`。官方建議正式環境用精確路徑。若有用 preview URL，再另外加上對應 pattern。

**Session 保存**〔實測：讀 `@supabase/supabase-js@2.118.0` 和 `auth-js` 原始碼〕

| 選項 | 預設值 |
|---|---|
| `persistSession` | `true`，存在 `localStorage` |
| `storageKey` | `sb-<project-ref>-auth-token` |
| `autoRefreshToken` | `true` |
| `detectSessionInUrl` | `true` |
| `flowType` | `'implicit'` |

- CLI `config.toml` 的預設值：`jwt_expiry = 3600`、`enable_refresh_token_rotation = true`〔實測〕。雲端專案的實際設定以 Dashboard 為準〔未驗證〕。
- SPA 的做法：啟動時呼叫一次 `getSession()`，再用 `onAuthStateChange` 監聽狀態。重新整理或換裝置後，session 會自動恢復。

### A7. Data API 曝露與預設權限：2026 年的重大改變〔文件〕〔實測〕

來源：<https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically>、<https://supabase.com/docs/guides/database/hardening-data-api>

**時間軸**

| 日期 | 事件 |
|---|---|
| 2026-04-28 | 建立專案時出現「Automatically expose new tables」選項 |
| 2026-05-30 | 新專案預設**不再**自動授權（分幾週逐步上線） |
| 2026-10-30 | **所有既有專案**也套用 |

**內容**

- 以前 `public` 的新表會自動 `grant select, insert, update, delete` 給 `anon`、`authenticated`、`service_role`，現在必須**自己 GRANT**。
- RLS 的行為沒有變，**GRANT 和 RLS 兩者都要有**。
- `public` 仍然是預設的 exposed schema。CLI `config.toml` 的預設值是 `schemas = ["public", "graphql_public"]`〔實測〕。
- 沒有 GRANT 時，PostgREST 會回 `42501`，訊息是 `permission denied for table <name>`，並附上需要的 GRANT 提示。
- Changelog 建議：**把 `GRANT` 和 `enable row level security`、policy 寫在同一個 migration 裡**。這個規則適用於 SQL Editor、migration、CLI 等所有建表方式。
- 函式：Postgres 預設會把 `EXECUTE` 授權給 `PUBLIC`。Hardening 文件建議執行 `alter default privileges for role postgres revoke execute on functions from public;`，再個別 `grant execute … to authenticated`（見 A9）。
- **本機 CLI stack 不一樣**：`config.toml` 有 `[api] auto_expose_new_tables`（預設註解掉），註解寫「Left unset, a fresh project falls back to `true`」〔實測〕。換句話說，本機可能仍會自動授權，但雲端不會。這會造成「本機測試通過、雲端卻 42501」。**解法：migration 一律寫明確的 GRANT／REVOKE**，兩邊都能正確運作；也可以在 config 設 `auto_expose_new_tables = false`，讓本機和雲端行為一致。

### A8. RLS 最佳實務：本專案的樣板〔文件〕〔實測：PGlite〕

來源：<https://supabase.com/docs/guides/database/postgres/row-level-security>

官方建議：

- 用 `(select auth.uid())` 包住 `auth.uid()`。這會讓 planner 產生 initPlan，每個 statement 只算一次，不會每列都重算。
- policy 一律寫 `to authenticated`，這樣 `anon` 請求根本不會去評估這條 policy。
- 「Add an index on every column your policies filter on」，所以每張表都要對 `user_id` 建索引。
- 沒登入時 `auth.uid()` 是 `NULL`，`NULL = user_id` 永遠為假。所以 policy 會靜默地什麼都不回傳，不會報錯。
- 「Enable RLS on every table in an exposed schema」。

**樣板**：已在 PGlite 實測過隔離效果。實測用的是 `for all` 單一 policy，下面的四條分開寫法語意相同。

```sql
create table public.projects (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  name       text not null check (char_length(name) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_user_id_idx on public.projects (user_id);
alter table public.projects enable row level security;

create policy projects_select_own on public.projects for select to authenticated
  using ((select auth.uid()) = user_id);
create policy projects_insert_own on public.projects for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy projects_update_own on public.projects for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy projects_delete_own on public.projects for delete to authenticated
  using ((select auth.uid()) = user_id);

-- 2026 起必須明確授權；只給 authenticated，anon 一律收回
revoke all on table public.projects from anon;
grant select, insert, update, delete on table public.projects to authenticated;
```

**PGlite 實測結果**

- U1 只看得到自己的列。
- U1 插入 `user_id = U2` 的資料會被擋：`42501 new row violates row-level security policy`。
- U1 對 U2 的資料 update／delete 影響 0 列。
- anon 執行 `select` 會得到 `42501 permission denied for table`。
- 清空 claims 後看得到 0 列。
- `check (due_date >= start_date)` 會被正確觸發。

**其他規則**

- 子表（tasks、phases、milestones、task_dependencies）**也要有自己的 `user_id` 和 policy**，不要在 policy 裡 join `projects`。這樣寫比較快，也和官方的效能建議一致。
- 用複合 FK `(project_id, user_id) → projects(id, user_id)` 防止把資料掛到別人的專案底下，這需要 `projects` 有 `unique (id, user_id)`。
- Lint：推上雲端後執行 `npx supabase db advisors --remote --type security`〔實測 `--help`〕，或到 Dashboard 的 Security Advisor 檢查。相關規則（<https://supabase.com/docs/guides/database/database-advisors>）：
  - `0013_rls_disabled_in_public`（ERROR）
  - `0003_auth_rls_initplan`（沒包 `select`）
  - `0011_function_search_path_mutable`
  - `0028`／`0029`：anon 或 authenticated 可以執行 security definer 函式
  - `0006_multiple_permissive_policies`

### A9. 函式（RPC）的安全設定〔文件〕〔實測：PGlite〕

來源：<https://supabase.com/docs/guides/database/functions>、hardening 文件

- **預設且建議使用 `security invoker`**，這樣 RLS 照常生效。用 `security definer` 時**必須**加 `set search_path = ''`，而且函式內所有物件都要寫完整的 schema 名稱，例如 `public.tasks`。
- 實測：definer 函式由表的擁有者執行，**會繞過 RLS**。同樣的 `count(*)`，invoker 版回 1，definer 版回 2。在 `search_path = ''` 下寫沒加 schema 的 `from notes`，呼叫時會報 `42P01 relation "notes" does not exist`。
- **一律收回 EXECUTE**。官方文件的 SQL 如下，實測 anon 呼叫會得到 `42501 permission denied for function`：

  ```sql
  revoke execute on function public.reschedule_tasks(jsonb) from public, anon;
  grant  execute on function public.reschedule_tasks(jsonb) to authenticated;
  -- 一次處理未來建立的函式（官方 hardening 文件）
  alter default privileges for role postgres revoke execute on functions from public;
  ```

  注意：被 RLS policy 呼叫的 helper 函式也受影響，要記得 `grant execute … to authenticated`。
- **原子性**：PostgREST 會把每個請求（包含 RPC）放在單一 transaction 裡執行，任何錯誤都會 rollback（<https://docs.postgrest.org/en/stable/references/transactions.html>）。所以 PRD 要求「Auto 排程確認後原子寫入」，用一個 invoker RPC 一次 update 多筆就能做到。
- 如果真的需要 definer，建議放在**沒有 expose 的 schema**（例如 `private`）。這是 hardening 文件的建議。

### A10. PostgREST 預設最多 1000 列與分頁〔文件〕〔實測：config〕

- 「By default, Supabase projects return a maximum of 1,000 rows. This setting can be changed in your project's API settings.」（<https://supabase.com/docs/reference/python/select>）。CLI `config.toml` 也是 `[api] max_rows = 1000`〔實測〕。
- 超過的部分會被**截斷**，不會報錯。匯出、搜尋、跨專案 Timeline 等可能超過 1000 列的地方都要分頁。
- `.range(from, to)` 是 **0-based、包含兩端**，而且「respects the query order」，所以**一定要搭配 `.order(...)`**（<https://supabase.com/docs/reference/javascript/range>）。
- 需要總數時用 `.select('*', { count: 'exact' })`，或者在迴圈中每次取 1000 列，直到回傳數量小於 1000。

### A11. 不用 Docker 執行 migration：最短可靠步驟〔文件〕〔實測：CLI 3.0.0 `--help`、`init`、`migration new`〕

**選項 1：SQL Editor（最簡單，完全不用 CLI）**

1. Dashboard → SQL Editor。
2. 依檔名的時間順序，把 `supabase/migrations/*.sql` 逐一貼上並執行。

缺點：不會寫進 `supabase_migrations.schema_migrations`。之後如果要改用 CLI，要先把這些版本標記成已套用：`npx supabase migration repair --status applied <version…> --remote`。官方也提醒不要在雲端直接改 schema，否則 `db push` 可能因為歷史不同步而失敗。

**選項 2：Supabase CLI v3（建議；push 到雲端不需要 Docker）**

用 `npx` 指定版本，或加進 devDependencies 並 **pin 精確版本**：

```bash
npx supabase@3.0.0 login                      # 開瀏覽器授權，產生 personal access token（使用者操作）
npx supabase@3.0.0 init                       # 只做一次，產生 supabase/config.toml（可進 Git）
npx supabase@3.0.0 migration new init_schema  # 產生 supabase/migrations/<timestamp>_init_schema.sql
npx supabase@3.0.0 link <project-ref>         # ref 在 Dashboard URL 或 Settings 裡
npx supabase@3.0.0 db push --remote --dry-run # 先看會套用哪些 migration
npx supabase@3.0.0 db push --remote           # 會詢問確認，Enter 等於拒絕；CI 要加 --yes
npx supabase@3.0.0 db advisors --remote --type security
```

說明：

- **v3 的 `db push` 預設目標是本機 stack**，一定要加 `--remote`。
- `link --password` 在 v3 會被忽略。`db push --remote` 的 `--password` 是選填；不給時，scoped token 需要 `database_write` 權限（help 原文）。
- `--linked`、`--project-ref`、`--db-url` 這幾個 flag 已 deprecated，但仍可用，只會印出警告。
- 這組流程**沒有對真實專案執行過**〔未驗證〕，因為需要使用者登入。
- 官方 v2→v3 遷移指南（<https://supabase.com/docs/guides/local-development/cli/migrating-to-v3>）在 2026-11-02 **回 404**。另外，官方 migration 教學頁（<https://supabase.com/docs/guides/deployment/database-migrations>）還在用 v2 的寫法 `supabase db push`（沒有 `--remote`）。**文件和 CLI 目前不同步。**
- 如果要避開剛發布的 v3：最後一個 v2 是 **2.122.0**。在 v2，`supabase db push` 預設就推到已 link 的專案，可以用 `npx supabase@2.122.0 …`。
- CLI v3 的 npm 套件改用平台 optional dependencies（`@supabase/cli-darwin-arm64` 等），沒有 postinstall 下載步驟〔npm〕。
- 不需要 Docker 的指令：`init`、`login`、`link`、`migration new`、`db push --remote`、`gen types --remote`、`db advisors --remote`。這是依 CLI help 和 release notes 推論的：這些指令都是直接連線，或只呼叫 Management API。啟動本機 stack（`supabase start`）才需要 Docker 或 Podman，v3 另有實驗性的 `--runtime native`。本機裝有 Docker，所以**沒有在「沒有 Docker」的環境實測**〔未驗證〕。

**Migration 內容的檢查清單**

- 每張表都要有：`enable row level security`、`to authenticated` 的 policy、`grant … to authenticated`、`revoke all … from anon`、`user_id` 索引。
- 每個函式都要有：`set search_path = ''`（invoker 也建議加）、`revoke execute … from public, anon`、`grant execute … to authenticated`。
- **不要**在 migration 裡 `create role`（雲端已經有這些 role），也不要動 `auth`、`storage`、`realtime` schema。自 2025-04-21 起，這些 schema 禁止建立或刪除表和函式〔文件：database changelog〕。

---

## B. Cloudflare

### B1. Pages 還是 Workers Static Assets？〔文件〕

- Pages 文件首頁有一個 banner，標題是「Are you sure you want to use Pages?」，內文寫「[Workers] is Cloudflare's primary platform for building applications. **Start new projects with Workers.**」（<https://developers.cloudflare.com/pages/>）。Pages 沒有被宣告淘汰，但**新專案官方建議用 Workers**。
- **本專案建議**：用 Workers 的 assets-only 部署，也就是沒有 Worker script、只放靜態檔。Pages 仍可用，兩者都免費（見下表）。

| 項目 | Workers Static Assets（Free） | Pages（Free） |
|---|---|---|
| 靜態檔請求 | 免費、不限次數，不計入 Worker 的請求額度 | 免費 |
| Worker script 請求 | 每天 100,000 次（UTC 午夜重置）；assets-only 沒有 script，所以不適用 | Pages Functions 才會用到 |
| 每個版本或網站的檔案數 | 20,000（Paid 100,000，需 wrangler ≥ 4.34） | 20,000 |
| 單檔大小 | 25 MiB | 25 MiB |
| Git 自動建置 | Workers Builds：每月 3,000 build minutes、1 個並行、20 分鐘 timeout | 每月 500 次 build、1 個並行、20 分鐘 timeout |
| `_headers`／`_redirects` | 支援（檔案放在 assets 目錄） | 支援。`_headers` 最多 100 條，每行 ≤ 2,000 字元；`_redirects` 最多 2,000 條靜態加 100 條動態 |
| SPA fallback | **要自己設定** `not_found_handling = "single-page-application"` | **自動**：沒有頂層 `404.html` 時，就當成 SPA |
| Build image 預設 Node | 24.22.1（npm 10.9.2） | 22.23.4（v3 image） |

來源：

- <https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/>
- <https://developers.cloudflare.com/workers/platform/limits/>
- <https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/>
- <https://developers.cloudflare.com/pages/platform/limits/>
- <https://developers.cloudflare.com/workers/ci-cd/builds/build-image/>
- <https://developers.cloudflare.com/pages/configuration/build-image/>

### B2. SPA fallback 行為〔文件〕〔實測：wrangler 4.156.1 dry-run 與 wrangler dev〕

已實測可用的 assets-only 設定（`wrangler deploy --dry-run` 通過，沒有 `main`）：

```jsonc
// wrangler.jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "cairn",
  "compatibility_date": "2026-11-02",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  }
}
```

用 `wrangler dev` 實測的結果：

- `GET /projects/123/gantt`（帶 `Sec-Fetch-Mode: navigate`）回 `200`，內容是 index.html。重新整理和直接開深層網址都沒問題。
- `GET /assets/missing.js`（非導覽請求）**也回 `200 text/html`**，內容同樣是 index.html。原因是 assets-only 沒有 Worker script，所有找不到的路徑都會走 SPA fallback。
- 實際影響：部署新版後，還開著舊分頁的使用者在動態載入舊 chunk 時，會拿到 HTML 而不是 JS。建議照 Vite 官方做法監聽 `vite:preloadError` 後重新整理頁面（<https://vite.dev/guide/build>）：

  ```ts
  window.addEventListener('vite:preloadError', () => window.location.reload())
  ```

- HTML 的預設回應標頭是 `Cache-Control: public, max-age=0, must-revalidate`，並帶有 `ETag`。

### B3. `_headers` 與安全標頭（CSP）〔文件〕〔實測：檔案會被套用〕

- 放在 `public/_headers`，Vite build 時會把它複製到 `dist/_headers`〔實測〕。Workers 和 Pages 都會讀取這個檔案。
- `_headers` 只套用到**靜態資產的回應**，不會套用到 Worker script 或 Pages Functions 產生的回應。
- 若同一個 header 被多條規則命中，值會**用逗號合併**。所以 `Cache-Control` 不要同時寫在 `/*` 和 `/assets/*` 兩條規則裡。
- 支援 splat（`*`、`:splat`）和 placeholder。
- 實測：`wrangler dev` 的 SPA fallback 回應也帶有 `_headers` 設定的標頭。

建議初稿（推論，部署後要在瀏覽器 console 確認沒有 CSP violation）：

```text
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://<project-ref>.supabase.co wss://<project-ref>.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Frame-Options: DENY

/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

各指令的理由：

- `script-src 'self'`：Vite 產生的 `index.html` 只有 `<script type="module" src="/assets/…">`，**沒有 inline script**〔實測 build 輸出〕。
- `style-src` 必須包含 `'unsafe-inline'`：以下套件執行時會動態插入 `<style>` 元素〔實測：檢查原始碼〕。靜態託管無法替每個請求產生 nonce，所以只能放寬 style。
  - `sonner`
  - `react-style-singleton`，由 Radix 透過 `react-remove-scroll` 使用
  - `framer-motion` 的 `AnimatePresence`／`PopChild`
- `connect-src`：一定要包含 Supabase 專案網域。`wss:` 只有使用 Realtime 時才需要。
- `font-src`：`@fontsource-variable/*` 的字型會被打包成 `/assets/*.woff2`。小於 4 KB 的資源可能被 Vite 內嵌成 `data:`，所以要允許 `data:`。

### B4. 部署方式〔文件〕〔實測：dry-run〕

**Workers：本機 CLI（最短）**

```bash
npm run build                  # VITE_* 變數在這一步寫入 bundle（從 .env.production.local 或 shell env 讀取）
npx wrangler@4.156.1 login     # 瀏覽器 OAuth（使用者操作）
npx wrangler@4.156.1 deploy    # 讀取 wrangler.jsonc，上傳 dist/
```

wrangler 需要 Node ≥ 22。

**Workers Builds（Git 整合）**

- Dashboard 連接 repo 後設定：
  - Build command：`npm run build`
  - Deploy command：預設的 `npx wrangler deploy`
  - 在 **Settings → Build → Build variables and secrets** 設定 `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`，以及（可選）`NODE_VERSION`。
- 官方說明：「Build variables will not be accessible at runtime」。Vite 需要的正好是 **build 時**的變數，所以要設在 build variables，**不是** wrangler 的 runtime `vars`（<https://developers.cloudflare.com/workers/ci-cd/builds/configuration/>）。

**Pages（替代方案）**

- Direct Upload：`npx wrangler pages project create`，再 `npx wrangler pages deploy dist`。**選了 Direct Upload 之後，無法再改成 Git 整合**（<https://developers.cloudflare.com/pages/get-started/direct-upload/>）。
- Git 整合：框架 preset 選 Vite／React，build command `npm run build`，輸出目錄 `dist`。環境變數設在 Pages 專案的 Settings，build 時可以讀到。

**`@cloudflare/vite-plugin`（1.67.0，peer：vite ^6.1 || ^7 || ^8、wrangler ^4.156.1）**：官方 React 教學會用它。但純靜態 SPA **不一定要用**，上面的 assets-only 設定已經用 dry-run 驗證可行。

### B5. Vite 的 build-time 環境變數與 Node 版本〔文件〕

- `VITE_*` 會在 build 時被**靜態替換**進 bundle。已經存在的 `process.env` 變數優先，`.env*` 檔不會覆蓋它們。所以在 CI 用 shell 或 build variables 注入就可以（<https://vite.dev/guide/env-and-mode>）。
- TypeScript 型別：在 `src/vite-env.d.ts` 擴充 `ImportMetaEnv` interface，宣告 `VITE_SUPABASE_URL` 等變數。
- 建議在 repo 根目錄加 `.node-version`，內容寫 `24`。Workers Builds 和 Pages 都會讀 `.node-version`／`.nvmrc`。Workers Builds 要指定 npm 版本只能用 `package.json` 的 `"packageManager": "npm@<精確版本>"`，不能寫範圍。

---

## C. 套件版本與相容性

### C1. 版本矩陣〔npm：2026-11-02 `npm view`〕

「repo 宣告」欄是 2026-11-02 21:10 讀到的 `package.json`。

| 套件 | 最新版 | 發布日 | engines／peer 重點 | repo 宣告 | 結論 |
|---|---|---|---|---|---|
| react／react-dom | 19.3.1 | 2026-10-14 | | ^19.3.1 | OK |
| react-router | 8.5.1 | 2026-10-27（8.0.0：2026-06-17） | node ≥ 22.22.0；react ≥ 19.2.7 | ^8.5.1 | OK，但 engines 要調高（見 C2） |
| react-router-dom | 7.18.5（只有 v7 線） | | | 未使用 | v8 已不發行 |
| vite | 8.3.5 | 2026-10-21 | node ^20.19 \|\| ≥ 22.12 | ^8.3.5 | OK |
| @vitejs/plugin-react | 6.2.1 | 2026-11-02 | peer vite ^8 | ^6.1.2 | OK |
| typescript | 7.0.2 | 2026-07-08（7.1.0-beta 在 `beta` tag） | | ~7.0.2 | OK |
| @typescript/typescript6 | 6.0.2 | | 提供 6.0 的 JS API 和 `tsc6` | 未使用 | 只有工具需要 TS API 時才裝 |
| oxlint | 1.90.0 | 2026-10-27 | type-aware 需要 peer `oxlint-tsgolint` ≥ 7.0.2005 | ^1.89.0 | OK |
| tailwindcss／@tailwindcss/vite | 4.3.3 | 2026-07-16 | 插件 peer vite ^5.2 … ^8 | ^4.3.3 | OK |
| shadcn（CLI） | 4.23.0 | 2026-10-27 | node ≥ 20.18.1 | 未安裝 | 用 `npx shadcn@4.23.0` |
| radix-ui | 1.8.1 | 2026-10-12 | react ^16.8 … ^19 | ^1.8.1 | OK |
| lucide-react | 1.66.0 | 2026-10-31（1.0.0：2026-03-23） | | ^1.66.0 | 注意品牌圖示已移除 |
| cmdk | 1.1.1 | 2025-03-14 | react ^18 \|\| ^19 | ^1.1.1 | OK（已久未更新，但可正常運作） |
| sonner | 2.0.8 | 2026-08-09 | react ^18 \|\| ^19 | ^2.0.8 | OK |
| react-day-picker | 10.0.2 | 2026-09-30 | 相依 date-fns ^4.1、@date-fns/tz ^1.4.1 | ^10.0.2 | OK；`@daypicker/react@10.0.2` 是新名稱，內部依賴 react-day-picker 10.0.2 |
| date-fns | 4.4.0 | 2026-05-29 | | 間接安裝 | 建議直接列入 dependencies |
| zustand | 5.0.16 | 2026-10-22 | peer immer ≥ 9.0.6、react ≥ 18 | ^5.0.16 | OK |
| immer | 11.2.9 | 2026-10-22（11.0.0：2025-11-23） | | ^11.2.9 | OK |
| @dnd-kit/core | 6.3.1 | 2024-12-05 | react ≥ 16.8 | ^6.3.1 | OK |
| @dnd-kit/sortable | 10.0.0 | 2024-12-04 | peer @dnd-kit/core ^6.3.0 | ^10.0.0 | OK |
| @dnd-kit/modifiers | 9.0.0 | 2024-12-04 | peer @dnd-kit/core ^6.3.0 | ^9.0.0 | OK |
| @dnd-kit/react | 0.5.3 | 2026-10-31 | | 未使用 | 新 API，尚未到 1.0，不建議採用 |
| fractional-indexing | 4.0.0 | 2026-06-25 | ESM | ^4.0.0 | OK |
| zod | 4.6.7 | 2026-10-12 | | ^4.6.7 | OK |
| motion | 14.9.0 | 2026-10-30 | react ^18 \|\| ^19 | ^14.9.0 | OK |
| vitest | 5.0.5 | 2026-10-15 | node ^22.12 \|\| ^24 \|\| ≥ 26；peer vite ^6.4 \|\| ^7 \|\| ^8（**必要**） | ^5.0.5 | OK |
| jsdom | **30.1.3** | 2026-10-15 | node ^22.22.2 \|\| ^24.15 \|\| ≥ 26 | **^27.0.1**（實裝 27.0.1） | 可接受，理由見 C18 |
| @testing-library/react | 16.3.3 | 2026-08-27 | peer **@testing-library/dom ^10**（必要） | ^16.3.3 | 建議把 dom 明列為 devDependency |
| @testing-library/jest-dom | 7.0.1 | 2026-08-09 | node ≥ 22；peer @testing-library/dom ≥ 10 < 11（必要） | ^7.0.1 | 同上 |
| @testing-library/user-event | 14.6.8 | 2026-10-13 | | ^14.6.8 | OK |
| @playwright/test | 1.64.1 | 2026-10-14 | node ≥ 20 | ^1.64.1 | OK |
| @electric-sql/pglite | 0.5.14 | 2026-10-31 | 內含 **PostgreSQL 18.6** | ^0.5.14 | 可用來測 RLS（見 C20） |
| @supabase/supabase-js | 2.118.0 | 2026-10-15 | node ≥ 22（build 時）；`@opentelemetry/api` 是 optional peer | ^2.118.0 | OK；`next` tag 上已有 3.0.0-next.29 |
| supabase（CLI） | 3.0.0 | **2026-11-02** | 最後一個 v2 是 2.122.0 | 未安裝 | 見 A11 |
| wrangler | 4.156.1 | 2026-11-01 | node ≥ 22 | 未安裝 | 見 B4 |

### C2. Node.js 執行環境〔npm〕〔實測〕

- Node 最新版（<https://nodejs.org/dist/index.json>）：
  - **24.22.2 LTS（Krypton）**，2026-10-27
  - **26.13.0 LTS（Lithium）**，2026-10-28
  - 22.23.4 LTS（Jod），2026-10-20
- 本機的 **23.9.0** 是奇數版，已經 EOL。
- 交集計算：react-router 8 需要 ≥ 22.22.0；jsdom 30 需要 ^22.22.2 || ^24.15 || ≥ 26；Vitest 5 需要 ^22.12 || ^24 || ≥ 26。三者交集是 **≥ 22.22.2 的 22.x，或 ≥ 24.15，或 ≥ 26**。repo 目前寫的 `"engines": { "node": ">=22.12" }` **低於 react-router 8 的最低要求**。
- 建議：`engines` 改成 `"^22.22.2 || ^24.15.0 || >=26"`，加 `.node-version`（內容 `24`），本機升級到 Node 24 LTS。Workers Builds 預設的 24.22.1 也符合。
- 實測：在 Node 23.9 上，Vite 8 build、Vitest 5 搭配 jsdom 30、PGlite 都**可以跑**，只會出現 npm 的 EBADENGINE 警告。這和 `docs/decisions.md` 的 D3 一致，但不在官方支援範圍內。

### C3. React 19.3〔文件〕

來源：<https://react.dev/blog/2026/09/09/react-19-3>

- 19.3（2026-09-09）的新功能：`<ViewTransition>` 正式穩定、Fragment refs、`react-dom` 的 `browser()`、Trusted Types 支援，以及 Transition 改為各自獨立渲染。
- 官方文章沒有列出 breaking change。
- 實測：dnd-kit、motion、cmdk、radix、sonner、DayPicker、zustand 在 React 19.3.1 + jsdom 下都能渲染，`console.error` 為 0。

### C4. React Router 8（相對 v7）〔文件：套件內 CHANGELOG.md 與 docs〕〔實測：TS 7 型別檢查與 Vite build〕

- **移除 `react-router-dom`**：`RouterProvider` 和 `HydratedRouter` 從 `react-router/dom` 匯入，其他全部從 `react-router` 匯入。
- `react-router` 根路徑**也有** export `RouterProvider`（d.ts 中查得到），但 v8 官方的 data mode 安裝文件寫的是 `/dom`。`/dom` 版本內含 `react-dom` 的 `flushSync`。

  ```tsx
  import { createBrowserRouter } from 'react-router'
  import { RouterProvider } from 'react-router/dom'
  const router = createBrowserRouter([{ path: '/', Component: Root, children: [/* … */] }])
  createRoot(el).render(<RouterProvider router={router} />)
  ```

- Declarative mode 仍然是 `import { BrowserRouter, Routes, Route } from 'react-router'`。
- 其他 v8.0.0 的破壞性變更：
  - 套件改為 **ESM-only**。
  - 最低需求 **Node 22.22.0、React 19.2.7**。
  - **middleware 永遠啟用**：`loader`／`action` 收到的 `context` 一律是 `RouterContextProvider`。
  - 移除 v7 所有 `future.v8_*` flags。
  - route object 不再接受 `hasErrorBoundary`。
  - meta API 的 `data` 改名為 `loaderData`。
- 8.5.0：React Router 自己的 view transition API（`viewTransition` prop 等）**已 deprecated**，改用 React 19.3 的 `<ViewTransition>`。
- 未來：官方預估 v9 在 2027 年中推出，屆時需要 Node 24 以上。

### C5. Vite 8 與 @vitejs/plugin-react 6〔文件〕〔實測〕

**Vite 8**（<https://vite.dev/guide/migration>）

- Rolldown 取代 esbuild + Rollup，Oxc 取代 esbuild 做轉譯和 JS 壓縮。
- 改名：
  - `build.rollupOptions` 改為 **`build.rolldownOptions`**（舊名 deprecated）
  - `optimizeDeps.esbuildOptions` 改為 `optimizeDeps.rolldownOptions`
  - `esbuild` 選項改為 `oxc`
- CSS 壓縮預設改用 Lightning CSS。
- `output.manualChunks` 的物件形式已移除。
- 預設瀏覽器目標：Chrome／Edge 111、Firefox 114、Safari 16.4。
- 需要 Node ^20.19 || ≥ 22.12。

**`resolve.tsconfigPaths: true`**（預設 `false`）

- 用途：直接讀 tsconfig 的 `paths`，不必再另外寫 `resolve.alias`。
- 文件限制：只套用在「被某個 tsconfig 的 `files`／`include` 涵蓋到的檔案」。
- 實測：
  - `paths` 不寫 `baseUrl` 也能正確解析。
  - 搭配 Vite 範本那種「根 `tsconfig.json` 是 `files: []` + references」的結構，`tsc -b && vite build` 也能通過。

**@vitejs/plugin-react 6**

- 改用 Oxc 做 Fast Refresh 和 JSX 轉換，**不再有 `babel` 選項**。
- 啟用 React Compiler 有兩種方式：
  - `react({ compiler: true })`：實驗性，需要另外安裝 `oxc-transform-react`。
  - `@rolldown/plugin-babel` 搭配 `reactCompilerPreset()`。

### C6. TypeScript 7（原生編譯器）〔實測：7.0.2〕〔文件〕

來源：<https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>

**實測**：每個項目都跑過一次 `tsc`。

| 設定 | TS 7.0.2 的結果 |
|---|---|
| `"baseUrl": "."` | **error TS5102**：「Option 'baseUrl' has been removed」，並建議改用 `"paths": {"*": ["./*"]}` |
| `moduleResolution: "node"`（node10） | error TS5108：已移除 |
| `target: "es5"`、`downlevelIteration`、`esModuleInterop: false`、`module: "amd"`、`outFile` | 全部報錯：已移除 |
| 不寫 `strict` | **預設 `strict: true`**，實測會出現 implicit any 錯誤和 `possibly undefined` 錯誤 |
| 不寫 `types` | **預設 `[]`**：`@types/*` 不再自動載入，實測 `React` namespace 找不到。測試相關的全域型別必須明列，例如 `"types": ["vite/client", "@testing-library/jest-dom/vitest"]` |
| `import './x.css'` | `noUncheckedSideEffectImports` **預設 `true`**。沒有 `vite/client` 型別時會報 TS2882 |
| `paths` 不寫 `baseUrl` | 可正常解析，以 tsconfig 所在目錄為基準 |
| `tsc -b` 搭配 project references | 可正常運作 |

**官方公告重點**

- 7.0 **沒有 JS／programmatic API**，7.1 才會提供新的 API。
- 需要 TS API 的工具（例如 typescript-eslint）要搭配 `@typescript/typescript6`（提供 `tsc6`），官方建議用 npm alias 讓兩版並存。
- 其他預設值：`module` 預設 `esnext`，`rootDir` 預設 `./`。
- 本專案的工具鏈（Vite/Oxc、oxlint/tsgolint、Vitest）都不依賴 TS JS API。shadcn 雖然用 `ts-morph`，但它自帶 TS，實測 init 和 add 都能正常執行。

**其他**

- 編輯器：7.0 公告時，VS Code 需要安裝 `TypeScriptTeam.native-preview` 擴充。公告說內建支援「in the coming weeks」，現在是否已內建〔未驗證〕。
- repo 開了 `erasableSyntaxOnly: true`，所以**不能使用 `enum`、`namespace`、constructor parameter properties**。請用 union type 或 `as const` 物件代替。

### C7. oxlint〔實測〕

- 1.90.0 可用的規則：`react/rules-of-hooks`、`react/exhaustive-deps`、`react/only-export-components`。type-aware 規則如 `typescript/no-floating-promises`，需要另外安裝 `oxlint-tsgolint`（7.0.2005），並設定 `"options": { "typeAware": true }` 或加 `--type-aware`。
- 實測：在 TS 7 風格的 tsconfig（沒有 `baseUrl`）下，`no-floating-promises` 能正確報錯。

### C8. Tailwind CSS 4.3〔文件：GitHub release v4.3.0〕

- 4.3 只有新增功能，沒有破壞性變更。新增的 utilities 有 `scrollbar-*`、`scrollbar-gutter-*`、`zoom-*`、`tab-*`、`@container-size`；`@variant` 也支援堆疊和複合 variant。
- 設定方式和 4.0 相同：`@tailwindcss/vite` plugin 加上 CSS 的 `@import "tailwindcss";`，**不需要 `tailwind.config.js`**，主題用 `@theme` 定義。
- 實測：Vite 8 build 能正確輸出自訂 `@theme` token。

### C9. shadcn CLI 4.x、radix-ui 1.8 與路徑別名（不用 baseUrl）〔實測：shadcn 4.23.0〕

**非互動初始化**：在 Vite 8 + TS 7 的專案上實測可行。

```bash
npx shadcn@4.23.0 init --base radix --preset nova --template vite --yes --no-monorepo --no-rtl
npx shadcn@4.23.0 add dialog popover calendar command dropdown-menu tooltip sonner --yes
```

**旗標行為**

- 沒有 `--preset` 時會出現互動選單，選項有 Nova、Vega、Maia、Lyra、Mira、Luma、Sera、Rhea、Custom。
- `-b, --base` 可選 `base`、`radix`、`aria`。
- `-d, --defaults` 等於 `--template=next --preset=base-nova`，也就是 **Base UI，不是 Radix**。

**產生的 `components.json`**

- `"style": "radix-nova"`
- `"tailwind": { "config": "" }`：v4 不需要 config 檔
- `"iconLibrary": "lucide"`
- aliases 為 `@/components`、`@/lib/utils`、`@/components/ui`、`@/lib`、`@/hooks`

**會新增的 dependencies**

- `radix-ui`、`class-variance-authority`、`lucide-react`、`tw-animate-css`、`@fontsource-variable/geist`
- **`cn`**（0.5.2）：「clsx + tailwind-merge 的替代品」。產生的 `lib/utils.ts` 只有一行 `export { cn } from "cn"`，**元件也是直接 `import { cn } from "cn"`**，不經過 `@/lib/utils`。repo 目前用的是 clsx + tailwind-merge 自己寫的 `cn`，所以從 CLI 加元件後要嘛安裝 `cn`，要嘛把 import 改掉。
- **`shadcn` 本身會被列為 runtime dependency**，因為 `index.css` 會 `@import "shadcn/tailwind.css"`。
- 加 `calendar` 會一起帶進 `react-day-picker ^10.0.2` 和 `date-fns`。
- 加 `sonner` 會帶進 **`next-themes`**，元件內部用它的 `useTheme()`。本專案有自己的主題 store，建議修改這個元件改讀自己的 store。
- 加 `tooltip` 後，需要在 App 外層包 `TooltipProvider`。

**路徑別名（重要）**

- shadcn 用 `tsconfig-paths` 讀**根目錄的 `tsconfig.json`**。這個套件不追 `references`，只追 `extends`。沒有 `baseUrl` 時，會以 tsconfig 所在目錄為基準，所以 TS 7 也沒問題。
- **實測：如果根 `tsconfig.json` 沒有 `compilerOptions.paths`**，init 時「Validating import alias」仍會顯示通過，但檔案會被寫到**字面上的 `./@/components/ui/button.tsx` 和 `./@/lib/utils.ts`**。
- 正確寫法：根 tsconfig 和 app tsconfig 都要有 `paths`，**兩邊都不能寫 `baseUrl`**。shadcn 官方 Vite 文件仍然寫了 `"baseUrl": "."`，照抄的話 TS 7 會報 TS5102。

  ```jsonc
  // tsconfig.json（根）
  { "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }],
    "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }
  // tsconfig.app.json
  { "compilerOptions": { /* … */ "paths": { "@/*": ["./src/*"] } }, "include": ["src"] }
  ```

  Vite 端可以用 `resolve: { tsconfigPaths: true }`〔實測〕，也可以沿用 `resolve.alias: { '@': path.resolve(import.meta.dirname, 'src') }`。
- 另一種做法：shadcn 文件也支援 `package.json#imports`（例如 `#/…`）作為 alias 來源。
- 實測：在 shadcnprobe 專案裡加入 dialog、popover、calendar、command、dropdown-menu、tooltip、sonner 之後，`tsc -b` 為 0 錯誤，`vite build` 也成功。

**radix-ui 1.8.1**

- 統一套件，用法是 `import { Dialog, Popover, Slot } from 'radix-ui'`。
- `exports` 有 `"./*"`，官方 2026-07-20 的 release 也說明支援 `radix-ui/accordion` 這類**單一 primitive 子路徑**。
- 2026 年的 release 修正了多個 React 19.2 以上的問題，包括 focus 管理、re-render loop、stale handler（<https://www.radix-ui.com/primitives/docs/overview/releases>）。

### C10. lucide-react 1.x〔實測：1.66.0〕〔文件〕

來源：<https://lucide.dev/guide/version-1>、<https://lucide.dev/guide/react/migration>

- **品牌圖示全部移除**：Chromium、Codepen、Codesandbox、Dribbble、Facebook、Figma、Framer、Github、Gitlab、Instagram、LinkedIn、Pocket、RailSymbol、Slack。實測 `Github`、`Twitter`、`Chrome`、`Figma`、`Slack` 都不存在。
- 1.x 的其他變更：
  - 圖示**預設 `aria-hidden="true"`**。需要讓螢幕閱讀器讀到時，要加 `aria-label` 或 `title`。
  - 移除 UMD build。
  - 新增 `LucideProvider`，可以設定預設 props。
- **舊別名仍然存在**（實測可 import）：`Home`、`Loader2`、`CheckCircle`、`AlertTriangle`、`MoreHorizontal`、`Edit`、`Trash2`、`GanttChart`。它們在 d.ts 裡是 `TriangleAlert as AlertTriangle` 這種 re-export，`*Icon` 後綴的名稱也都有。新程式碼建議用正式名稱，例如 `House`、`LoaderCircle`、`TriangleAlert`、`Ellipsis`、`Pencil`、`ChartGantt`。

### C11. cmdk 1.1.1 與 sonner 2〔實測〕〔文件〕

**cmdk**

- 最後一次發布是 2025-03-14，peer 支援 React 19。
- jsdom 測試需要 `ResizeObserver` 和 `Element.prototype.scrollIntoView` 的 polyfill，否則會直接拋出 `ReferenceError`（實測）。

**sonner 2.0.8**

- v2 主要是修 bug，beta.3 移除了 deprecated props。
- 2.0.7 開始支援多個 `<Toaster />`。
- 執行時會插入 `<style>`（與 CSP 的關係見 B3）。

### C12. react-day-picker 10 與「只有日期」的處理〔實測〕〔文件〕

來源：<https://daypicker.dev/upgrading>

**v9 → v10 的變更**

- 推薦改用 `@daypicker/react`，舊名 `react-day-picker` 仍可用。CSS 改為 `import '@daypicker/react/style.css'`；用 shadcn 元件時不需要這個 CSS。
- **刪除 v9 的舊 props 和別名**：

  | 刪除 | 改用 |
  |---|---|
  | `initialFocus` | `autoFocus` |
  | `fromDate`／`toDate` | `hidden={{ before, after }}`，再搭配 `startMonth`／`endMonth` |
  | `fromMonth`／`toYear` 等 | `startMonth`／`endMonth` |
  | `onDayKeyUp` 等事件 | 自訂 `DayButton` 元件 |
  | `components.Button` | `PreviousMonthButton`／`NextMonthButton` |
  | 舊的 `classNames` key（例如 `table`） | `month_grid` 等新名稱 |

- 實測：`<Calendar initialFocus />`、`fromDate`、`toDate` 都會被 TS 7 報 TS2322。`autoFocus`、`hidden`、`startMonth`、`endMonth` 可以通過。
- 非公曆曆法改為獨立的 `@daypicker/*` 套件。
- `timeZone` prop 從 9.1.1 開始有。`noonSafe` 從 9.13 開始有，標記為 experimental。

**只有日期（`YYYY-MM-DD`）的做法**（實測與建議）

- **不要**用 `new Date('2026-11-02')`。這會被解析成 **UTC 午夜**：
  - 在 `TZ=America/Los_Angeles` 下 `format` 出來是 **2026-11-01**。
  - 在 Asia/Taipei 下剛好看不出問題，所以在台灣測試時特別容易漏掉。
- 正確做法：
  - 轉成 `Date`：`parseISO('2026-11-02')`，結果是**本地午夜**。實測在兩個時區都正確。
  - 轉回字串：`format(d, 'yyyy-MM-dd')`。
  - 加減天數：`addDays`。
  - 計算天數差：`differenceInCalendarDays`。
- DayPicker 的 `selected` 用 `parseISO(value)`，`onSelect` 回傳的 `Date` 用 `format(d, 'yyyy-MM-dd')` 轉回字串。不要傳 `timeZone`，用瀏覽器本地時間即可。
- 資料庫欄位用 `date` 型別，PostgREST 會回傳 `'YYYY-MM-DD'` 字串，前端全程以字串保存（與 `docs/decisions.md` D9 一致）。

### C13. zustand 5 + immer 11〔實測〕〔文件〕

**正確的 import 路徑（實測可用）**

```ts
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { useShallow } from 'zustand/react/shallow' // 官方文件寫 'zustand/shallow'，兩個路徑都有
const useStore = create<State>()(immer((set) => ({ /* … */ })))
```

**zustand v5 的破壞性變更**（<https://github.com/pmndrs/zustand/blob/main/docs/reference/migrations/migrating-to-v5.md>）

- 移除 default export。
- 最低需要 React 18。
- **selector 回傳新的 reference 可能造成無限迴圈**，錯誤訊息是「Maximum update depth exceeded」。解法是用 `useShallow`。
- `setState(…, true)` 的型別變嚴格。
- persist middleware 在建立 store 時不再立即寫入。

**immer 11**（<https://github.com/immerjs/immer/releases>）

- 11.0 的破壞性變更：「enable loose iteration by default」，並重寫了 finalization 機制以提升效能。
- 11.1 新增**選用的** `enableArrayMethods` plugin。啟用後，`filter`、`find` 等方法的 callback 參數**不再是 draft**，在 callback 裡修改會直接改到原物件。**不建議啟用。**
- 11.2 新增 `isModified`。
- 實測：zustand + immer 的更新會產生新 reference，結果仍然被 freeze。

### C14. dnd-kit〔npm〕〔實測：渲染〕

- `@dnd-kit/core` 6.3.1、`@dnd-kit/sortable` 10.0.0、`@dnd-kit/modifiers` 9.0.0 都是 2024-12 發布的，之後沒有新版。peer 是 `react >= 16.8`。
- sortable 10.0.0 只是配合 core 6.3.0 的相依升級，沒有 API 變更。core 6.3 新增了 `onDragPending`／`onDragAbort` 事件；6.3.1 把 `Tab` 加入結束拖曳的預設按鍵。
- 實測：React 19.3 + jsdom 下，`DndContext`、`SortableContext`、`useSortable`、`KeyboardSensor` 都能正常渲染，沒有錯誤。**實際拖曳互動沒有測**，需要用 Playwright 在真實瀏覽器驗證。
- 維護者的新 API `@dnd-kit/react` 目前是 0.5.3，還沒到 1.0，維持用 core 和 sortable 較穩。

### C15. fractional-indexing 4.0.0〔實測〕〔文件：README 與 d.ts〕

- API：
  - `generateKeyBetween(a, b, digits?, intDigits?)`
  - `generateNKeysBetween(a, b, n, digits?, intDigits?)`
  - 常數 `BASE_62_DIGITS`、`BASE_52_DIGITS`
- 4.0 新增 `intDigits`。注意：**明確傳入 `digits` 時，連傳 `BASE_62_DIGITS` 也一樣**，產生的 key 會是 self-headed 格式，例如 `"50"`。只有完全省略 `digits`，才會得到傳統的 `a0`／`Zz` 格式。**建議一律不要傳 digits。**
- 實測結果：

  | 呼叫 | 結果 |
  |---|---|
  | `(null, null)` | `a0` |
  | 往後加一個 | `a1` |
  | 往前加一個 | `Zz` |
  | `(a0, a1)` | `a0V` |
  | 兩個參數反過來傳 | 回傳中間值（文件：「they may be passed in either order」） |
  | 兩個參數相同 | 拋出錯誤 |

- **排序必須用 code-unit 順序**：實測 `localeCompare` 會把 `Zz` 排到 `b00` 後面，是錯的。JS 端用 `<`／`>` 比較，Postgres 欄位用 `collate "C"`（實測順序正確：`Zz, a0, a0V, a1, b00`）。Supabase 雲端資料庫的預設 collation〔未驗證〕，所以**一定要在欄位上明確指定**。這已經是 `docs/decisions.md` 的 D8。

### C16. zod 4.6〔實測〕

- `import { z } from 'zod'` 就是 v4，`zod/v3` 和 `zod/mini` 是另外的子路徑。
- 實測：
  - `z.iso.date()` 可以驗證 `YYYY-MM-DD`。
  - 錯誤自訂改用 `{ error: '…' }`。
  - 錯誤代碼是 `too_small`、`invalid_format` 等。
  - **`ZodError.errors` 已不存在**，請用 `.issues`。
  - `z.flattenError()` 和 `z.treeifyError()` 可用；`.flatten()` 仍在，但屬於舊 API。
  - `z.string().email()` 還能用（deprecated），新寫法是 `z.email()`。
- **陷阱**：`z.uuid()` 採嚴格的 RFC 檢查，`11111111-1111-1111-1111-111111111111` 這種假 UUID 會**驗證失敗**；`z.guid()` 比較寬鬆。測試資料請用 `crypto.randomUUID()` 產生。

### C17. motion 14〔文件：CHANGELOG〕〔實測：渲染〕

- 用法仍是 `import { motion, AnimatePresence, MotionConfig } from 'motion/react'`。
- 13.0：移除選用的 `@emotion/is-prop-valid` 依賴。需要的話改成 `<MotionConfig isValidProp>`。
- 14.0：移除內部 API。這是為了 pin 住 `framer-motion`、`motion-dom` 等內部套件的版本，對一般用法沒有影響。
- PRD 要求尊重 reduced motion，可以用 `<MotionConfig reducedMotion="user">`（實測可渲染）。

### C18. Vitest 5 + jsdom + Testing Library〔實測〕〔文件〕

來源：<https://vitest.dev/guide/migration>

**Vitest 5 的變更**

- 需要 Vite ≥ 6.4、Node ≥ 22.12。`vite` 不再是 vitest 的直接相依（peer）。
- `clearMocks` 預設為 `true`。
- 沒有 await 的 async assertion 會讓測試失敗。
- **不再往上層目錄找 config**。
- `test.projects` 的 `extends` 預設為 `true`。
- 輸出移到 `.vitest/`，`json`／`junit` reporter 預設寫成檔案。
- 移除 `vitest/environments`、`vitest/reporters` 等入口，以及 `bench`。

**jest-dom 7**

- setup 檔仍然寫 `import '@testing-library/jest-dom/vitest'`。
- 型別要放進 tsconfig 的 `types`，例如 `["vite/client", "@testing-library/jest-dom/vitest"]`（TS 7 實測可用）。
- 7.0 起 `@testing-library/dom` 改為**必要 peer**，最低需要 Node 22。

**實測可用的組合**

- Vitest 5.0.5 + jsdom **30.1.3** + RTL 16.3.3 + jest-dom 7.0.1。所有測試都在本機 Node 23.9 上執行。
- 設定 `globals: false` 時，RTL 不會自動 cleanup，要在 setup 裡自己寫 `afterEach(cleanup)`。

**jsdom 30.1.3 缺少的 API**（實測）

- 缺少：`ResizeObserver`、`window.matchMedia`、`Element.prototype.scrollIntoView`、`hasPointerCapture`、`IntersectionObserver`。
- 已有：`PointerEvent`、`DOMRect`。
- 建議放在 setup 的 polyfill（已驗證）：

  ```ts
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  Element.prototype.scrollIntoView ??= function () {}
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false })) as typeof window.matchMedia
  ```

**DB 測試要分開成獨立的 project**（實測）

- 在單一 config 用 `// @vitest-environment node` 跑 PGlite 測試，會因為全域 DOM setup 檔裡用到 `window` 而失敗（`ReferenceError: window is not defined`）。
- 改用 `test.projects`，把 `ui`（jsdom + setup）和 `db`（node，沒有 DOM setup）分開後，5 個測試全部通過。repo 的 scripts 已經有 `--project db` 的設計。

**jsdom 版本**

- repo 目前用 jsdom 27.0.1。它的 `engines` 是 `>=20`，所以 Node 23 不會出現 EBADENGINE 警告；27.1 以後才排除 Node 23。
- 這個選擇合理。等改用 Node 24 以後，就可以升到 `^30.1.3`（實測可用）。

### C19. Playwright 1.64〔文件：<https://playwright.dev/docs/release-notes>〕

- 1.64 的破壞性變更：
  - device descriptor 的 `screen` 現在會被轉送，`window.screen` 和 media query 會反映模擬的尺寸。
  - 測試檔中的 JSX 改依照 `tsconfig.json` 處理。
  - **預設模式下，缺少 snapshot 時會寫入 snapshot，然後讓測試失敗**；`--update-snapshots=missing` 則會通過。
  - 在隱藏 iframe 裡的元素會被視為 hidden。
- 1.63 起不再支援 Ubuntu 20.04；1.62 起不再支援 Debian 11。
- 需要 Node ≥ 20〔npm〕。
- 測 dnd-kit 拖曳時，要用 `page.mouse.down()` 加上多次 `mouse.move()`，才能越過 `activationConstraint`。這是一般做法，本次沒有實測。

### C20. PGlite 0.5：能不能跑我們的 migration 和 RLS 測試？〔實測：0.5.14〕

**可以。** 實測項目全部通過，腳本做法見附錄 A：

| 能力 | 結果 |
|---|---|
| 版本 | `PostgreSQL 18.6 (PGlite 0.5.14)`，預設使用者 `postgres` 是 superuser |
| `CREATE ROLE anon／authenticated／service_role … NOLOGIN` | OK |
| `SET ROLE authenticated`、`RESET ROLE`、`SET LOCAL ROLE`（在 transaction 內） | OK，transaction 結束後會恢復為 `postgres` |
| `set_config('request.jwt.claims', '{"sub": …}', false/true)` 搭配自製 `auth.uid()` | OK |
| 非 superuser 角色的 RLS 是否生效 | **生效**：資料隔離、`WITH CHECK` 擋下、跨使用者 update／delete 影響 0 列 |
| 沒有 GRANT 時 | `42501 permission denied for table` |
| `REVOKE EXECUTE … FROM public, anon` | anon 呼叫時得到 `42501 permission denied for function` |
| security definer 與 invoker | definer 會繞過 RLS，invoker 不會（行為和雲端相同） |
| `ON DELETE SET NULL (phase_id)` | OK |
| `collate "C"` 排序 | OK |
| changelog 中的 `alter default privileges …` 語句 | OK |
| `gen_random_uuid()` | OK，PG13 起內建 |

**測試 harness 建議**（依上述實測整理）

1. 建立 PGlite。
2. 建立 Supabase 的模擬環境：
   - `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;`
   - `create schema auth;` 和 `auth.users(id uuid primary key)`
   - `auth.uid()`，內容是 `select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid`
   - `grant usage on schema auth, public …`
3. 用 `db.exec(sql)` 依檔名順序執行 `supabase/migrations/*.sql`。
4. 寫一個 `asUser(sub, fn)` helper：在 `db.transaction` 裡依序執行 `set local role authenticated` 和 `select set_config('request.jwt.claims', $1, true)`。這和 PostgREST 的作法相同：設定只在 transaction 內有效，結束後變回空字串。

**限制**

- PGlite 是 **PG 18.6**，Supabase 是 **PG 17**。在 PGlite 測過，不代表 PG17 一定能跑。migration **不要使用 PG18 才有的功能**，例如 `uuidv7()`、virtual generated column、`RETURNING` 裡的 `OLD`／`NEW`。
- harness 只模擬了 `auth.uid()`，**沒有 PostgREST 這一層**，所以 1000 列上限、HTTP 錯誤格式、`apikey` 驗證都不在測試範圍內。
- 沒有 `extensions` schema。`pg_available_extensions` 查不到 pgcrypto 等擴充，因為 PGlite 的擴充要從 JS 載入。migration 裡**不要依賴 `create extension`**。
- 測試必須跑在 Vitest 的 `environment: 'node'` project，見 C18。

---

## D. 未驗證或需要使用者完成的事項

1. **對真實 Supabase 專案執行**以下流程（需要使用者登入，或提供 access token 和 project ref）：
   - `supabase link`
   - `db push --remote`
   - `db advisors --remote`
   - 檢查新專案的 Data API exposure 設定和實際 GRANT 狀態
2. Supabase 雲端資料庫的預設 collation。用 `collate "C"` 可以避開這個問題。
3. Dashboard 的「Add user → Auto Confirm User」選項名稱，以及關閉註冊的確切位置。
4. 暫停超過 1 年後怎麼處理；`supabase db dump` v3 是否需要 Docker。
5. CSP 初稿在真實瀏覽器裡是否完全沒有 violation，特別是 Supabase Auth 和字型。
6. Supabase CLI v3.0.0 剛發布不到一天，官方 v3 遷移指南目前是 404。要用 v3 還是 pin 2.122.0，等使用者第一次 push 時再決定。
7. VS Code 是否已內建 TS 7 語言服務。

---

## E. 來源清單（存取日 2026-11-02）

**Supabase**

- <https://supabase.com/pricing>
- <https://supabase.com/docs/guides/platform/project-pausing>
- <https://supabase.com/docs/guides/platform/free-project-pausing>
- <https://supabase.com/changelog/27497-paused-free-plan-projects-are-restorable-for-90-days>（舊資訊，經搜尋結果取得）
- <https://supabase.com/docs/guides/platform/backups>
- <https://supabase.com/docs/guides/platform/upgrading>
- <https://supabase.com/changelog?tags=database>
- <https://supabase.com/changelog/46080-self-hosted-supabase-upgrading-from-pg-15-to-17-breaking-change>
- <https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically>（以及同網址的 `.md` 版）
- <https://supabase.com/docs/guides/api/api-keys>
- <https://supabase.com/docs/guides/getting-started/quickstarts/reactjs>
- <https://supabase.com/docs/guides/auth/passwords>
- <https://supabase.com/docs/guides/auth/auth-smtp>
- <https://supabase.com/docs/guides/auth/general-configuration>
- <https://supabase.com/docs/guides/auth/redirect-urls>
- <https://supabase.com/docs/reference/javascript/initializing>
- <https://supabase.com/docs/reference/javascript/range>
- <https://supabase.com/docs/reference/python/select>
- <https://supabase.com/docs/guides/database/postgres/row-level-security>
- <https://supabase.com/docs/guides/database/functions>
- <https://supabase.com/docs/guides/database/hardening-data-api>
- <https://supabase.com/docs/guides/database/database-advisors>
- <https://supabase.com/docs/guides/deployment/database-migrations>
- <https://supabase.com/docs/reference/cli/supabase-db-push>
- <https://github.com/supabase/cli/releases/tag/v3.0.0>（另以 GitHub API 取得完整 release notes）
- <https://supabase.com/docs/guides/local-development/cli/migrating-to-v3>（**404**）

**PostgREST／Postgres**

- <https://docs.postgrest.org/en/stable/references/transactions.html>
- <https://www.postgresql.org/docs/17/sql-createtable.html>
- <https://www.postgresql.org/docs/release/15.0/>

**Cloudflare**

- <https://developers.cloudflare.com/pages/>
- <https://developers.cloudflare.com/workers/static-assets/>
- <https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/>
- <https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/>
- <https://developers.cloudflare.com/workers/static-assets/headers/>
- <https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/>
- <https://developers.cloudflare.com/workers/platform/limits/>
- <https://developers.cloudflare.com/workers/platform/pricing/>
- <https://developers.cloudflare.com/workers/ci-cd/builds/configuration/>
- <https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/>
- <https://developers.cloudflare.com/workers/ci-cd/builds/build-image/>
- <https://developers.cloudflare.com/workers/framework-guides/web-apps/react/>
- <https://developers.cloudflare.com/workers/vite-plugin/>
- <https://developers.cloudflare.com/pages/platform/limits/>
- <https://developers.cloudflare.com/pages/configuration/serving-pages/>
- <https://developers.cloudflare.com/pages/configuration/headers/>
- <https://developers.cloudflare.com/pages/configuration/build-configuration/>
- <https://developers.cloudflare.com/pages/configuration/build-image/>
- <https://developers.cloudflare.com/pages/get-started/direct-upload/>

**前端與工具**

- <https://vite.dev/guide/migration>
- <https://vite.dev/config/shared-options>
- <https://vite.dev/guide/env-and-mode>
- <https://vite.dev/guide/build>
- <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>
- <https://devblogs.microsoft.com/typescript/>（7.1 Beta：2026-10-20）
- <https://react.dev/blog/2026/09/09/react-19-3>
- <https://ui.shadcn.com/docs/installation/vite>
- <https://ui.shadcn.com/docs/components-json>
- <https://www.radix-ui.com/primitives/docs/overview/releases>
- <https://lucide.dev/guide/version-1>
- <https://lucide.dev/guide/react/migration>
- <https://daypicker.dev/upgrading>
- <https://github.com/pmndrs/zustand/blob/main/docs/reference/migrations/migrating-to-v5.md>
- <https://github.com/immerjs/immer/releases>
- <https://github.com/emilkowalski/sonner/releases>
- <https://github.com/testing-library/jest-dom/releases>
- <https://github.com/tailwindlabs/tailwindcss/releases/tag/v4.3.0>
- <https://raw.githubusercontent.com/motiondivision/motion/main/CHANGELOG.md>
- <https://vitest.dev/guide/migration>
- <https://playwright.dev/docs/release-notes>
- <https://nodejs.org/dist/index.json>

**npm 套件內的文件**（2026-11-02 安裝的版本）

- `react-router@8.5.1` 的 `CHANGELOG.md` 和 `docs/`
- `fractional-indexing@4.0.0` 的 README 和 d.ts
- `react-day-picker@10.0.2` 的 README 和 props d.ts
- `@vitejs/plugin-react@6.2.1` 的 README
- `@testing-library/jest-dom@7.0.1` 的 README
- `@dnd-kit/*` 的 CHANGELOG
- `typescript@7.0.2` 的 `package.json`

---

## 附錄 A：實測做法（可重現）

所有實測都在 repo **以外**的 scratchpad 目錄進行，**沒有**在 repo 執行 `npm install`，也沒有修改 repo 中本文件以外的任何檔案。

1. **版本查詢**：用 `npm view <pkg> version time dist-tags engines peerDependencies` 查詢 40 多個套件。
2. **套件檢查**：把 C1 表列的版本以 `npm install --ignore-scripts` 裝進獨立目錄，再閱讀 README、CHANGELOG 和 d.ts。
3. **TS 7.0.2**：準備多種 tsconfig 變體並逐一跑 `tsc`，用來確認 baseUrl、node10、es5、esModuleInterop、amd/outFile 的錯誤，以及 strict 和 types 的預設值；另外用 `tsc --help --all` 讀取預設值。
4. **Vite 8.3.5 build**：組合是 React 19.3、React Router 8 data mode、Tailwind 4.3 `@theme`、`resolve.tsconfigPaths`，以及 `public/_headers`。用來確認 `_headers` 會被複製到 dist，且 index.html 沒有 inline script。
5. **shadcn 4.23.0**：
   - 在 Vite 8 + TS 7 專案跑 `init --base radix --preset nova --template vite`，再 `add` 7 個元件，最後確認 `tsc -b` 和 `vite build` 都通過。
   - 另做一組根 tsconfig 沒有 `paths` 的對照，確認檔案會被寫到 `./@/`。
6. **Vitest 5.0.5 + jsdom 30.1.3 + RTL 16.3.3 + jest-dom 7.0.1**（Node 23.9）：
   - 跑元件測試。
   - 跑 React 19.3 相容性 smoke test：dnd-kit、motion、cmdk、radix Dialog、sonner、DayPicker、zustand+immer+useShallow。
   - 偵測 jsdom 缺少哪些 API。
   - 驗證 `test.projects` 拆成 ui 和 db 兩組。
7. **PGlite 0.5.14**：用兩支腳本測 roles、SET ROLE、claims、RLS、grants、EXECUTE revoke、definer 與 invoker、`ON DELETE SET NULL (col)`、`collate "C"`、default privileges；並在 Vitest node project 中跑 3 個 RLS 測試。
8. **wrangler 4.156.1**：
   - 對 assets-only 的 `wrangler.jsonc` 跑 `deploy --dry-run`。
   - 啟動 `wrangler dev`，用 curl 打深層路由、不存在的 asset 和 `_headers`。測完已停止。
9. **Supabase CLI 3.0.0**：查看 `--version`、`db push`、`link`、`login`、`migration new`、`db advisors`、`gen types`、`migration repair`、`db dump` 的 `--help`；在暫存目錄執行 `supabase init` 和 `migration new`，並閱讀產生的 `config.toml`。
10. **oxlint 1.90.0 + oxlint-tsgolint 7.0.2005**：確認 type-aware 的 `no-floating-promises` 可以在 TS 7 風格的 tsconfig 下運作。
11. **其他執行期檢查**：
    - date-fns 4.4：在 `TZ=America/Los_Angeles` 和 `Asia/Taipei` 下比較 `parseISO` 和 `new Date(str)`。
    - zod 4.6.7：檢查 API 差異。
    - fractional-indexing 4.0.0：檢查 key 產生與排序。
    - lucide-react 1.66.0：檢查有哪些名稱可以 import。
