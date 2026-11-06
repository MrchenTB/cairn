# Cairn 甘特圖優化｜第二輪開發報告

> 日期：2026-11-06 ｜ 分支：`ux/iteration-2` ｜ 基準：`post-ux-iteration-1`（第一輪提交）
> 還原點（Git tag）：`pre-ux-iteration-1`（第一輪前）→ `post-ux-iteration-1` → `post-iter2-part-ab` → `post-iter2-part-cd`
> 截圖：[`docs/gantt-iteration-2-assets/`](gantt-iteration-2-assets/)

## 1. 已實作功能

### A. 週末背景識別

- Day / Week 刻度的週六、週日是**一條貫穿所有列的連續色帶**，從時間軸頂部延伸到內容底部，不被階段列切割。做法是階段列右側維持透明（第一輪已做），所以色帶是單一圖層，而不是每列各畫一塊。
- 維持第一輪的清爽：沒有每日格線，只有每週一條髮絲線與月份線。Month 刻度不畫色帶。
- 新增語意 token `--gantt-weekend`（淺色 `rgba(36,38,49,.055)`、深色 `rgba(0,0,0,.16)`，深色比工作日略深）。Day 表頭的週末格沿用同一個 token。
- 長條外的標籤（有不透明底，避免線穿字）會在自己底下重畫同一段週末色帶，所以落在週末上不會變成一塊淺色矩形。
- 色帶是 `z-0` 的背景，`pointer-events: none`，在長條、文字、依賴線與互動元件之下；Timeline 共用同一個函式，已同步。

### B. 階段顏色系統

- 色盤：專案色票去掉紅色，共 8 色（gray、blue、violet、pink、orange、yellow、green、teal）。不提供 HEX 輸入。
- 規則：階段可自選顏色；任務與子任務繼承所在階段；未設定（`null`）、無階段、刪除階段後，一律回到專案色。
- 長條：To Do 淺填 + 色邊框、In Progress 較深填色 + 左側粗邊、Done 淡填 + 淡邊框 + 原本的完成圖示。填色全部是對背景的**不透明混色**（`color-mix`），不是元素 opacity，所以今日線與依賴線不會穿過文字。衝突（紅框、⚠）與逾期（紅色端點）維持原樣並優先於階段色。里程碑菱形維持深色。
- 設定入口：Gantt 與 List 的階段標題旁色點 → 色盤（8 色 + Use project color + 目前選取）；List 階段 `⋯` 選單新增 Color…；New phase 對話框可選色（非必填）。
- 跨頁面：Gantt（色點、彙總線、長條）、List（階段名前色點）、Board（卡片上的階段晶片加色點、階段篩選選項加色點）。**Timeline 維持專案色**，不使用階段色。
- 其他：色盤打開後 Esc 一次就關閉（色票的 Tooltip 只在滑鼠 hover 時出現，不再搶走第一個 Esc）。

### C. 拖曳 Undo

- 移動、縮放、在未排程列畫出日期、鍵盤微調完成後，顯示一則 Toast：`Moved · Nov 15 – Nov 16 · 2 days`（或 Resized / Scheduled），附任務名稱與 **Undo**。
- Undo 還原**完整的開始日與截止日**；從未排程畫出日期的任務，Undo 會回到 Unscheduled。
- Auto 模式下確認的連動順延，與觸發它的任務是**同一筆記錄**，一次 Undo 原子還原。
- 連續操作不會刷屏：Toast 固定同一個 id，下一次操作取代上一則。**同一個任務的連續操作（8 秒內）會合併**，Undo 回到第一次操作之前，Toast 顯示的就是目前結果；換成別的任務則重新開始，Undo 只會碰 Toast 上寫的那個任務。
- 防呆：如果該任務之後又被改過（例如在 Modal 改了日期），Undo 不會覆蓋，只會告知「Can’t undo」。
- 儲存失敗沿用現有機制（回復長條、Retry Toast），不會出現 Undo。Esc 取消拖曳不寫入、不出 Toast。

### D. 已完成任務與排程衝突

最小且合理的區分（決策 D24）：

| 情況                                      | 處理                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| successor 未完成（含 predecessor 已完成） | **一般衝突**，行為不變：紅框、衝突數、可被 Resolve all                                                                             |
| successor 已完成                          | **歷史不一致**：不算衝突，不標紅、不計數、不被移動；在該任務與其 predecessor 的 Modal 以低調文字「Completed out of order」保留資訊 |

- Auto 排程與 Resolve all **永不移動 Done 任務**；使用者自己明確編輯的任務不受影響。
- Done 任務的後繼以它**實際的日期**判斷，因此不會把後面的任務推到不合理的位置。
- 預覽對話框新增「Completed — kept as they are」區塊，清楚列出被略過的任務。沒有預覽的情況（只有 Done 任務會被牽動）會顯示一則「N completed task was not moved」的提示。

## 2. 主要修改檔案

| 範圍       | 檔案                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 週末色帶   | `src/features/gantt/model/scale.ts`、`components/TimeAxis.tsx`、`components/bars.tsx`（標籤底）、`styles/tokens.css`、`GanttChart.tsx` / `TimelineChart.tsx`（`--wk-*` 變數）                                                                                                                           |
| 資料模型   | `src/domain/types.ts`（`PHASE_COLORS`、`Phase.color`）、`domain/validation.ts`、`data/mappers.ts`、`data/localRepository.ts`、`data/store.ts`、`data/supabaseRepository.ts`                                                                                                                             |
| Migration  | `supabase/migrations/20261106000000_phase_color.sql`（**新增，未套用**）                                                                                                                                                                                                                                |
| 階段色 UI  | `components/task/PhaseColorPicker.tsx`（新）、`task/labels.ts`、`features/gantt/components/GanttRow.tsx`、`GanttChart.tsx`、`features/list/ListGroup.tsx`、`ListView.tsx`、`features/board/BoardCard.tsx`、`PhaseFilter.tsx`、`features/projects/PhaseDialog.tsx`、`styles/tokens.css`（`.gantt-tint`） |
| Undo       | `features/gantt/dateUndo.ts`（新）、`planner.ts`、`components/GanttChart.tsx`、`lib/notify.ts`                                                                                                                                                                                                          |
| 已完成任務 | `src/domain/scheduling.ts`、`features/gantt/planner.ts`、`RescheduleDialog.tsx`、`features/task-modal/ConflictBanner.tsx`、`EditTaskForm.tsx`                                                                                                                                                           |
| 共用       | `components/ui/tooltip.tsx`（新增 `passive`、`hoverOnly` 選項）                                                                                                                                                                                                                                         |
| 文件       | `docs/decisions.md`（D24、D25）                                                                                                                                                                                                                                                                         |

## 3. 測試結果

| 項目                                                 | 結果                                                                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck（`tsc -b`）                                | 通過                                                                                                                                                        |
| Lint（`oxlint`）                                     | 無警告                                                                                                                                                      |
| Prettier                                             | 全部符合                                                                                                                                                    |
| 單元／DOM／DB（`vitest run`，1641 個）               | 1638 通過、3 失敗；失敗的是 `SettingsPage.test.tsx` 時區欄位測試的 5 秒逾時，**在第二輪之前的基準版本同樣失敗**，單獨執行則通過（機器負載造成，與本輪無關） |
| DB／Repository（PGlite，含 Supabase 模擬層，304 個） | 全部通過，含新 migration                                                                                                                                    |
| Playwright E2E（487 個，全套一次）                   | 485 通過、2 失敗，兩者已處理（見下）                                                                                                                        |

E2E 兩個失敗：

1. `gantt.spec.ts` 拖曳測試原本斷言「成功移動不出現 Toast」。這正是本輪要改的行為，已更新為「恰好一則 `Moved · …` Toast」。
2. `acceptance-journey.spec.ts`（長流程）全套並行時曾有一次拖曳少移一天；單獨重跑 4 次全部通過。當時我同時在跑截圖腳本，判斷是負載造成的偶發，**沒有找到可重現的原因**，若你驗收時遇到請告訴我。

本輪新增測試：`scale.test.ts`、`scheduling.done.test.ts`（含屬性測試）、`dateUndo.test.ts`、`planner.test.ts`（記錄／Undo／已完成）、`mappers`／`localRepository`／`backup`／`store` 的階段色與舊資料測試、DB 約束與匯入測試、UI 測試；E2E 新增 `gantt-phase-color.spec.ts`（9）、`gantt-undo.spec.ts`（9）、`gantt-done-schedule.spec.ts`（5）。

瀏覽器實測：Day／Week／Month、淺／深色、有階段與無階段、不同階段色、拖曳／縮放／依賴線、週末色帶在水平捲動時與表頭對齊、320 筆任務（只渲染 <80 列、色帶高度涵蓋全部列、連續捲動沒有超過 250ms 的卡頓）。

## 4. 視覺前後比較

「Before」＝第一輪完成後的畫面。

| 項目                       | Before                         | After                                                                                            |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| Day 淺色                   | `before-day-light-phases.png`  | `weekend-day-light-phases.png`、`phasecolor-day-light-phases.png`                                |
| Week 淺色                  | `before-week-light-phases.png` | `weekend-week-light-phases.png`、`phasecolor-week-light-phases.png`                              |
| Week 深色                  | `before-week-dark-phases.png`  | `weekend-week-dark-phases.png`、`phasecolor-week-dark-phases.png`                                |
| Month                      | `before-month-*-phases.png`    | `weekend-month-*-phases.png`（無週末色帶）                                                       |
| 無階段專案                 | —                              | `*-nophase.png`                                                                                  |
| 色盤、List、Board          | —                              | `ui-picker-gantt-*.png`、`ui-list-*.png`、`ui-board-*.png`                                       |
| Undo、排程預覽、Modal 提示 | —                              | `undo-toast.png`、`undo-restored.png`、`resolve-with-completed.png`、`modal-historical-note.png` |

## 5. 資料相容性結果

- **舊本機資料**：缺少 `color` 的階段會被讀成 `null`（沿用專案色），整份工作區**不會**被判為無法讀取、也不會被移到備份鍵。審查報告提到的風險確實存在——測試過程中還抓到一個真實的 bug：本機儲存有「已驗證過的快速讀取路徑」，會略過正規化，舊資料第二次讀取時 `color` 會是 `undefined`，已修正並有測試。
- **未知顏色**（例如未來色盤擴充、被手動改過的資料）：一律讀成 `null`，不會丟掉資料。
- **舊備份 JSON**：沒有 `color` 的備份可正常匯入（單元測試、DB 匯入測試、瀏覽器經由 Settings 匯入各驗證一次）；帶有紅色或未知顏色的備份不會被整份拒絕，該階段回到專案色。
- **新備份**：匯出→匯入保留階段色（瀏覽器實測 teal → teal）。CSV 只匯出任務與階段名稱，沒有顏色欄位，未變更。
- **沒有清除或重設任何 localStorage**；所有瀏覽器測試都在獨立的測試環境進行。
- **雲端寫入的向下相容**：只有階段「有顏色」時才送出 `color` 欄位。所以在 migration 套用前，新增、改名、排序階段都照常運作。

## 6. 尚未處理的問題與取捨

- **預設專案色為 gray 時，長條會是灰色**：這是「未設階段色就用專案色」的直接結果（它和 Done 的淡灰長條相似，靠圖示與填色深淺區分）。若覺得不理想，可考慮讓專案色為 gray 時退回主題強調色，需要你決定。
- **Timeline** 的展開任務列仍使用主題強調色，不是專案色；依你的指示未改動。
- **歷史不一致**目前只在 Task Modal 保留資訊，甘特圖上沒有專屬標示，也沒有「接受」操作；列為後續建議。
- **里程碑拖曳**沒有 Undo（需求只提到任務）；對話框裡的「Resolve all」套用也沒有 Undo Toast（預覽本身已是明確確認）。Auto 模式下拖曳任務、確認預覽後的結果則有 Undo。
- **Unscheduled 列的提示文字**改為文字光暈而非實色底（它是 sticky，無法對齊週末色帶）。
- 第一輪留下的：StartMarker 的文字沒有遮罩、月線旁的雙線。
- **環境**：Playwright 的瀏覽器快取（`~/Library/Caches/ms-playwright`）在這次工作階段中不存在（應該是之前清理磁碟時被刪），我重新下載了 Chromium（約 100 MB）。

## 7. 是否需要額外的雲端 migration 操作

**需要，但不急。** 我沒有對任何 Supabase 專案執行任何東西。

- 檔案：`supabase/migrations/20261106000000_phase_color.sql`（增量，初始 migration 沒有改動）。內容：`phases.color text`（可為 null）＋檢查約束（只允許 8 種顏色，不含紅色）＋以 `create or replace` 更新 `import_workspace`，讓備份匯入帶上階段色。
- 套用時機與方式由你決定，例如 `supabase db push`。
- **套用之前**：App 完全可用，但在雲端模式「選擇階段顏色」會失敗（資料庫沒有欄位）；本機模式不受影響。建議套用後再把這版部署給雲端使用者。
- 套用之後既有階段的顏色都是 `null`，畫面不變。
- 沒有部署 Cloudflare。

## 8. 驗收建議

1. 先在本機模式看 Day / Week 的週末色帶（淺、深色），以及上下左右捲動時是否對得上表頭。
2. 設定階段色、重新整理、再選 Use project color。
3. 拖曳、縮放、畫出日期後試 Undo；連續拖同一個任務幾次再按一次 Undo。
4. 把一個有依賴的任務標為完成，再拖前面的任務，確認完成的任務不會被搬動。
