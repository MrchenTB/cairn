# Cairn 的 Supabase 資料庫

這個資料夾包含 Cairn 雲端模式需要的資料庫設定：

| 檔案                                        | 內容                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `migrations/20261102000000_init.sql`        | 基礎 schema：6 張表、RLS policy、trigger、3 個 RPC、權限設定                                        |
| `migrations/20261106000000_phase_color.sql` | 階段顏色：`phases.color`，以及會保留顏色的 `import_workspace`                                       |
| `verify.sql`                                | 只讀的檢查腳本：schema、RLS、權限是否都正確（第 2 節）                                              |
| `config.toml`                               | Supabase CLI 設定（由 CLI 3.0.0 的 `supabase init` 產生後調整），供 `supabase link`／`db push` 使用 |

資料模型以 `docs/architecture.md` §4 為準；平台事實（CLI v3、2026 年權限預設變更、Free 方案限制）見 `docs/platform-notes.md` 的 A 節。

> 前端（Cloudflare）部署完成**不代表**資料庫已設定好。下面的步驟需要你登入自己的 Supabase 帳號親自完成。

---

## 0. 開始前

1. 在 <https://supabase.com/dashboard> 建立專案（Free 方案即可，不需升級）。
2. 記下兩樣東西：
   - **Project ref**：Dashboard 網址 `…/project/<project-ref>` 中的那一段。
   - **資料庫密碼**：建立專案時設定的密碼（忘記可在 Project Settings → Database 重設）。
3. 需要 **PostgreSQL 15 以上**（`ON DELETE SET NULL (phase_id)` 是 PG15 的語法）。新專案預設是 17，可在 SQL Editor 執行 `show server_version;` 確認。
4. 第一次設定要**依檔名順序套用全部 migration**（目前 2 個）。`init` 只能用在全新的空專案，對已經套用過的專案重跑會因「物件已存在」而失敗（不會刪除資料）。

---

## 1. 套用 migration（擇一）

### 方法 A：Dashboard 的 SQL Editor（最簡單，不需安裝任何工具）

1. Dashboard → 你的專案 → **SQL Editor** → 新增一個 query。
2. 打開 `supabase/migrations/20261102000000_init.sql`，**整份**複製貼上，按 **Run**。
3. 開新的 query，對 `supabase/migrations/20261106000000_phase_color.sql` 做一樣的事。順序不能反。
4. 都沒有錯誤就完成了，接著做第 2 節的檢查。

注意：

- SQL Editor 不會記錄 migration 歷史。之後若改用 CLI（方法 B）管理 migration，要先把這些版本標記為「已套用」，否則 `db push` 會想再跑一次而失敗：

  ```bash
  npx supabase@3.0.0 migration repair --status applied 20261102000000 20261106000000 --remote
  ```

- 如果執行失敗、而且專案是**剛建立、沒有任何資料**的，可以先執行下面這段清除 Cairn 的物件，修正問題後再重跑一次（已在測試環境驗證過可以清乾淨並重新套用）：

  <details>
  <summary>清除 Cairn 物件（會刪除所有 Cairn 資料表與資料，只能用在全新專案）</summary>

  ```sql
  drop table if exists public.task_dependencies, public.milestones, public.tasks, public.phases,
    public.projects, public.user_preferences cascade;
  drop function if exists public.apply_task_schedule(jsonb), public.delete_task(uuid, boolean, jsonb),
    public.import_workspace(jsonb), public.tg_set_updated_at(), public.tg_immutable_columns(),
    public.tg_tasks_hierarchy(), public.tg_tasks_subtask_phase(), public.tg_tasks_phase_to_subtasks(),
    public.tg_tasks_completed_at(), public.tg_task_dependencies_rules();
  ```

  </details>

### 方法 B：Supabase CLI（建議；之後新增 migration 比較方便）

在 repo 根目錄執行（指令會讀取這個資料夾的 `config.toml` 與 `migrations/`）：

```bash
npx supabase@3.0.0 login                             # 開瀏覽器授權（你本人操作）
npx supabase@3.0.0 link --project-ref <project-ref>  # 連結雲端專案
npx supabase@3.0.0 db push --remote --dry-run        # 先預覽：第一次應該列出 2 個 migration
npx supabase@3.0.0 db push --remote                  # 正式套用；出現確認提示時輸入 y
```

重點：

- **CLI v3（2026-11-02 發布）的 `db push` 預設目標是「本機」**，一定要加 `--remote` 才會推到雲端專案。確認提示直接按 Enter 等於**取消**。
- 若被詢問資料庫密碼，輸入第 0 節記下的密碼。
- 依 CLI 說明，推到雲端專案不需要啟動本機 Docker stack（只有 `supabase start` 需要）；這點尚未在沒有 Docker 的電腦上實測。
- 如果你使用 CLI v2（例如 `npx supabase@2.122.0`），v2 的 `db push` 預設就推到已 link 的專案，**不要**加 `--remote`。
- `config.toml` 的 `[auth]` 等設定只影響本機 stack；雲端專案的 Auth 設定請照第 3 節在 Dashboard 調整。

---

## 2. 確認 RLS 與權限都正確

在 SQL Editor 貼上 [`verify.sql`](verify.sql) 整份執行。它只讀系統目錄，不會改動任何東西，也不會讀使用者資料。

**預期：每一列 `pass = true`。** 失敗會排在最上面，`detail` 欄會說是哪個物件。

涵蓋：PostgreSQL 版本、6 張表與兩個 migration 是否都套用、每張表的 RLS 與 4 條只限本人的 policy、`anon` 與 `PUBLIC` 沒有任何權限、`authenticated` 只有增刪改查、沒有 `SECURITY DEFINER`、函式都固定 `search_path`、只有 3 個 RPC 可由登入使用者執行、沒有能繞過 RLS 的 view、複合外鍵、排序規則、trigger。`tests/db/verify.test.ts` 逐項拿掉保護，確認對應的檢查真的會失敗。已在全新的 Supabase 專案（PostgreSQL 17.11）上實際執行，18 列全部通過。

其他檢查方式：

- Dashboard 的 **Security Advisor**，或 `npx supabase@3.0.0 db advisors --remote --type security`：不應出現 RLS 相關的錯誤。
- 用 publishable key 以「未登入」身分呼叫 REST API，應該拿到錯誤而不是資料：

  ```bash
  curl "https://<project-ref>.supabase.co/rest/v1/projects?select=id" \
    -H "apikey: <你的 publishable key>"
  # 預期：錯誤碼 42501，訊息為 permission denied for table projects
  ```

---

## 3. 建議的 Auth 設定（Dashboard → Authentication）

1. **登入方式**：只用 Email + 密碼。Sign In / Providers → **Email** 保持啟用。
2. **建立你自己的帳號**（擇一）：
   - 建議：Users → **Add user → Create new user**，輸入 email 與密碼，勾選 _Auto Confirm User_（選項名稱以實際畫面為準）。這樣不需要收確認信。
   - 或在 App 的登入頁註冊。注意：雲端專案預設開啟 **Confirm email**，而內建寄信服務**只寄給專案團隊成員的信箱、每小時 2 封**；若你的 email 不是團隊成員，會收不到確認信。
3. **建好帳號後關閉註冊**：Sign In / Providers → 關閉 **Allow new users to sign up**。既有帳號仍可登入，其他人無法再註冊。
   - 不要關閉整個 Email provider（那會讓你自己也無法登入）。用 CLI 管理設定時對應的是 `[auth] enable_signup = false`，不是 `[auth.email]` 底下的設定。
4. **URL Configuration**：
   - **Site URL**：改成部署後的網址，例如 `https://cairn.<account>.workers.dev` 或你的自訂網域（預設值 `http://localhost:3000` 一定要改）。
   - **Redirect URLs**：加入正式網址本身（只有網域，結尾不要加 `/login` 之類的路徑，也不要加 `/`：App 送出的就是這個值，不在清單內時信裡的連結會退回 Site URL），以及本機開發用的 `http://localhost:5173`。
5. **密碼**：建議至少 8 碼。
6. **金鑰**：前端只放 Project URL 與 **publishable key**（`sb_publishable_…`；舊版 anon key 也可）到 `.env.local`。**secret key／service_role key 絕對不能放進前端或 Git**——它會繞過 RLS。
7. 「忘記密碼」信件同樣受內建寄信限制。需要寄到其他信箱時，要自行設定 custom SMTP（需另外申請寄信服務，可能產生費用，請自行評估）。

Free 方案提醒：沒有自動備份；連續約 7 天沒有活動，專案會被暫停（可在 Dashboard 恢復）。請定期使用 App 的 Settings → Data 匯出 JSON 備份。細節見 `docs/platform-notes.md` A1–A3。

---

## 4. Schema 速覽

| 表                  | 重點                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`          | `unique (id, user_id)` 供子表的複合外鍵使用；名稱 1–200 字、不可空白；`due_date >= start_date`                                        |
| `phases`            | `(project_id, user_id) → projects` cascade                                                                                            |
| `tasks`             | 只允許一層子任務；`(phase_id, project_id) → phases` **on delete set null (phase_id)**；`(parent_task_id, project_id) → tasks` cascade |
| `milestones`        | 同上的 project／phase 外鍵；`date` 必填                                                                                               |
| `task_dependencies` | 只支援 `FS`；同一專案；不可自我依賴、重複、循環、父子之間依賴                                                                         |
| `user_preferences`  | 每位使用者一列（`user_id` 為主鍵），可用 upsert 寫入                                                                                  |

所有表都有 `user_id`（預設 `auth.uid()`），RLS policy 一律是 `to authenticated` + `((select auth.uid()) = user_id)`。複合外鍵讓「把資料掛到別人的專案／phase／任務底下」在資料庫層就不可能發生（外鍵檢查本身不受 RLS 限制，所以這層很重要）。另外，外鍵的連鎖動作（`ON DELETE CASCADE`／`SET NULL`）是以**表的擁有者**身分執行，它觸發的 trigger 看得到所有使用者的列、不受 RLS 限制；能把連鎖動作限制在同一位使用者的專案內的，只有複合外鍵與不可修改的 `id`／`user_id`／`project_id`，之後的 migration 千萬不要放寬它們。`sort_order` 欄位使用 `COLLATE "C"`，排序與前端的字元碼比較一致。

**Trigger**（本機模式的 `LocalRepository` 應遵守相同規則）：

- `updated_at` 每次更新自動設定；`created_at`、`id`、`user_id`、`project_id` 不可修改（V1 不支援跨專案移動）。
- `tasks.completed_at`：狀態變成 `done` 時設定、離開 `done` 時清空（匯入時可保留原本的完成時間）。
- 階層：父任務必須是頂層任務、同一專案；有子任務的任務不能變成子任務；與父任務之間有依賴時不能成為其子任務。
- 子任務的 `phase_id` 永遠跟隨父任務；父任務換 phase（包含 phase 被刪除）時，子任務一起變更。新增子任務或把任務移到某個父任務底下時，會先對父任務那一列加 `FOR SHARE` 鎖：同時進行的「父任務換 phase」必須等這筆寫入完成（反之亦然），子任務才不會留在舊的 phase。
- 依賴：以遞迴 CTE 拒絕循環；依賴與階層的變更會取得同一個「每專案」advisory lock，避免同時寫入時繞過檢查（階層變更一律先鎖父任務那一列、再取 advisory lock，順序固定以避免死結）。
- 極少數情況下，兩個裝置在同一瞬間對相同的列做互相衝突的修改（例如同時把 A 移到 B 底下、把 B 移到 A 底下），PostgreSQL 會偵測到死結並讓其中一筆失敗（`40P01`）；App 顯示錯誤並可重試，資料不會不一致。

**RPC**（全部是 `security invoker`、`set search_path = ''`，只有 `authenticated` 能執行，整個呼叫要嘛全部成功、要嘛完全不生效）：

```ts
// 多筆任務日期一次寫入（Gantt 拖曳、自動排程）。回傳更新後的 tasks 列。
await supabase.rpc('apply_task_schedule', {
  p_changes: [{ id: taskId, start_date: '2026-11-02', due_date: null }],
})

// 刪除任務。p_keep_subtasks = true 時，p_promoted 必須剛好列出目前所有子任務。
await supabase.rpc('delete_task', {
  p_task_id: taskId,
  p_keep_subtasks: true,
  p_promoted: [{ id: subtaskId, sort_order: 'a0V' }],
})

// 匯入已重新編號的備份（snake_case 列、不含 user_id）。回傳各類筆數。
await supabase.rpc('import_workspace', {
  p_data: { projects: [], phases: [], tasks: [], milestones: [], dependencies: [] },
})
```

`import_workspace` 一律以呼叫者為擁有者（忽略資料中的 `user_id`），先寫父任務再寫子任務，而且資料必須「自成一體」：只能參照同一份匯入資料裡的列，因此不會把資料掛到既有的專案上。每一列都必須有 `id`（缺少時整份匯入以 `22023` 拒絕），「自成一體」的檢查才不會因為 SQL 的 NULL 比較而失效。

**錯誤碼**（訊息是英文、可直接顯示在 UI）：

| SQLSTATE         | 意義                       | 訊息範例                                                                                                                                                                          |
| ---------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `23514`          | 違反規則                   | `Subtasks can only be one level deep`、`This dependency would create a cycle`、`Due date cannot be before start date`、CHECK 約束（訊息含約束名稱，例如 `tasks_due_after_start`） |
| `23503`          | 參照的列不存在或不屬於你   | `Parent task not found`、`Predecessor task not found`、`Import data references rows that are not part of the import`                                                              |
| `23505`          | 重複                       | `This dependency already exists`                                                                                                                                                  |
| `22023`          | RPC 參數格式錯誤           | `Schedule changes must be a JSON array`、`Every imported row needs an id`、`The subtasks to keep do not match the task's current subtasks. Refresh and try again.`                |
| `22007`／`22008` | 日期格式錯誤／不存在的日期 | `Dates must use the YYYY-MM-DD format`                                                                                                                                            |
| `P0002`          | RPC 的目標不存在或不屬於你 | `Task not found`、`Some tasks could not be found. Refresh and try again.`                                                                                                         |
| `42501`          | 權限                       | `Rows cannot be moved to another account`、RLS 擋下的寫入、未登入呼叫                                                                                                             |

新增 migration 時：`npx supabase@3.0.0 migration new <名稱>`，並照同樣的模式寫：啟用 RLS、`to authenticated` 的 policy、明確的 `revoke … from public, anon` 與 `grant … to authenticated`、函式加 `set search_path = ''`。不要在 migration 裡建立 role 或修改 `auth` schema。

---

## 5. 測試（`tests/db`）

```bash
npm run test:db
```

使用 PGlite 0.5.14（WASM 版 PostgreSQL 18.6，在記憶體中執行，不需要 Docker 或網路）。測試環境的準備方式（`tests/db/harness.ts`）：

- 建立 `anon`、`authenticated`（NOLOGIN）、`service_role`（BYPASSRLS），以及 `auth` schema、`auth.users`、與 Supabase 相同寫法的 `auth.uid()`（讀取 `request.jwt.claims` 的 `sub`）。
- 模擬「預設把新表與函式開放給 anon／authenticated」的較寬鬆設定（本機 CLI stack 的預設行為）。這樣如果 migration 忘了 `REVOKE`，測試就會失敗。
- migration 由一個**非 superuser** 的擁有者角色執行，模擬雲端的 `postgres` 角色不是 superuser 的情況。
- 每次以使用者身分執行時，都在一個 transaction 內 `set local role authenticated` 並設定 `request.jwt.claims`，與 PostgREST 處理每個請求的方式相同。另有一個健全性測試：如果 RLS 沒有真正生效，它就會失敗。
- `prepare()` 用 `PREPARE TRANSACTION` 讓一個請求停在「已執行、尚未 commit」的狀態（其他請求看不到它的資料，它持有的鎖也不會釋放），藉此重現兩個請求交錯的情況。PGlite 無法讓鎖等待逾時，所以另一個請求只能用 `NOWAIT`／`pg_try_*` 試探鎖，不能真的去等。

| 檔案                   | 涵蓋內容                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `harness.test.ts`      | migration 可套用；角色、`auth.uid()`、RLS 確實生效；預設權限的模擬；`prepare()` 的行為                                                                                                                                                                                                                                         |
| `schema.test.ts`       | 欄位契約（名稱、型別、可否為 null）、`COLLATE "C"`、所有複合鍵與外鍵定義、每個外鍵與 `user_id` 都有索引、RLS 與 policy、表與函式的權限、`search_path`、避免使用 PG16+ 語法；`public` 裡任何表／view／欄位／sequence 都不能開放給 anon 或 PUBLIC、每張表都要啟用 RLS、view 必須是 `security_invoker`                            |
| `rls.test.ts`          | 每張表的擁有者 CRUD；另一位使用者在每張表、每種指令（含 upsert）都無法讀取／新增／修改／刪除你的資料，也不能改 `user_id`；所有外鍵路徑都無法參照別人的 project／phase／task，且錯誤訊息與「不存在」完全相同（不會洩漏別人的資料是否存在）；別人的連鎖刪除與 trigger 不會動到你的資料；anon 無法存取任何表與 RPC；不能 TRUNCATE |
| `constraints.test.ts`  | 預設值；列舉值與 `src/domain/types.ts` 的常數一致；名稱／標題長度（以字元計，含中文）；描述長度；日期先後與範圍；其他 CHECK                                                                                                                                                                                                    |
| `triggers.test.ts`     | `updated_at`／`created_at`；`completed_at`；階層規則（含單一 statement 的批次寫入）；子任務 phase 雙向同步（含刪除 phase 時資料列處理順序的邊界情況，以及新增子任務與父任務換 phase 同時發生的情況）；不可修改的欄位；advisory lock                                                                                            |
| `dependencies.test.ts` | 自我、重複、2 點與 3 點及長循環、跨專案、父子依賴、更新依賴時的重新檢查、advisory lock（含尚未 commit 的寫入會一直持有它）                                                                                                                                                                                                     |
| `cascades.test.ts`     | 刪除專案、phase（任務與里程碑改為未分組）、任務（子任務與依賴）、帳號                                                                                                                                                                                                                                                          |
| `rpc.test.ts`          | `apply_task_schedule` 的原子性（一筆錯或含別人的任務就完全不變）與參數驗證；`delete_task` 兩種模式（不能順便提升別人的任務）；`import_workspace` 的筆數、擁有者、任何一筆無效就完全不寫入、不能掛到別人或既有的資料上、缺少 `id` 的列、重用別人的 `id` 也無法覆寫或接管                                                        |
| `preferences.test.ts`  | 偏好設定 upsert（只有本人可以）                                                                                                                                                                                                                                                                                                |

**PGlite 無法模擬、因此沒有測到的部分**：

- **沒有 PostgREST 這一層**：HTTP 狀態碼與錯誤格式、`max_rows = 1000` 的截斷、`apikey`／JWT 驗證都不在測試範圍內。
- **只有單一連線**：兩個 transaction 無法真的同時執行、互相等待。`prepare()` 可以重現「一個請求尚未 commit、另一個請求進來」的交錯，並確認鎖確實被持有；但「等待之後」的行為（例如等到鎖之後看到對方 commit 的資料）是依 PostgreSQL 在 READ COMMITTED（PostgREST 預設）下的行為推論，死結偵測也沒有實測。
- **版本差異**：PGlite 是 PG 18.6，雲端是 PG 17（或 15）。測試會檢查 migration 沒有用到 PG16 以後才有的常見語法，但真正的相容性要等第一次 `db push` 才能確認。
- **雲端的角色與權限**：以非 superuser 的 `migrator` 角色近似雲端的 `postgres`；雲端實際的預設權限、Auth 服務（註冊、確認信、session）與資料庫預設 collation 都沒有模擬。
