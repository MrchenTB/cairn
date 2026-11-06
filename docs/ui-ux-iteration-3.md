# Cairn UI/UX 第三輪精修｜開發報告

> 日期：2026-11-06 ｜ 分支：`ux/iteration-3`（由 `ux/iteration-2` 建立）｜ 還原點 tag：`pre-ux-iteration-3`
> 截圖：[`docs/ui-ux-iteration-3-assets/`](ui-ux-iteration-3-assets/)（成對的 `*-before.png`／`*-after.png`）
> **所有修改都沒有 commit**，留在工作區等你驗收。

**執行方式**：Gantt 格線與跨頁一致性由我（主對話）實作；Overview、List＋Board 各交給一個 implementer 並行處理（檔案範圍不重疊）。三個部分我都自己重跑過測試並檢視畫面，不是只採信 agent 的回報。

## 1. 修改摘要

| Part                 | 內容                                                                                | 結果                       |
| -------------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| **A** Gantt 日期格線 | Day／Week 增加低對比日期線，週起始線略深；週末色帶與階段列維持連續                  | 完成                       |
| **B** Overview       | 統計卡可點且目的地數字相符、空狀態精簡、專案列資訊層級、Next 6 weeks tooltip 與導航 | 完成，一項設計取捨待你確認 |
| **C** Project List   | Start／Due 欄名與固定欄寬、`No phase` 排最後、群組計數說明、行內新增階段焦點        | 完成，一項視覺問題未解決   |
| **D** Project Board  | 日期完整 tooltip、篩選空狀態文案；欄位佈局與卡片檢查後不需大改                      | 完成                       |
| **E** 跨頁一致性     | 計數口徑盤點與說明、日期 tooltip 統一規則                                           | 完成（範圍見 §2.5）        |

## 2. 各頁面的主要改善

### 2.1 Part A：Gantt 日期格線

| 刻度  | 之前           | 之後                                                                                                       |
| ----- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| Day   | 只有每週一條線 | 每日 1px 線（`--gantt-day-line`，淺色 3.5%／深色 3% 不透明度）＋較深的週起始線（`--gantt-grid`，6%／4.5%） |
| Week  | 只有每週一條線 | 每週起始線＋更淡的每日線（日期線強度為 Day 的 75%，因 55% 時肉眼看不到）                                   |
| Month | 月份線         | 不變（不畫每日線）                                                                                         |

做法與取捨：

- **單一 tile，不疊層。** 一週的週起始線與六條日期線畫在同一個漸層 tile 裡（`scale.ts` 的 `LINES_GRADIENT`），不是「每日一層＋每週一層」。這樣兩種線在週起始處不會疊加變深，週線強度維持原本的 token。
- **週末色帶不變。** 色帶仍是連續的單一圖層，日期線畫在它上方，沒有恢復棋盤感；階段列右側維持透明，格線不被階段列切斷。
- **外部標籤底也重畫日期線。** 長條外的標籤有不透明底（避免線穿字），第二輪已讓它重畫週末色帶；現在同樣重畫日期線（新增 `--wk-lines`、`--wk-lx`），標籤後面不會出現線的缺口。
- **沒有增加 DOM 節點。** 只改 CSS gradient，不影響長列表效能。
- **對齊驗證。** 量測 Day 刻度時，週一標頭格的左緣與格線 tile 相位完全一致（239px＝239px）。
- **Timeline 共用同一個函式，所以同步得到日期線。** 這是預期行為，已檢視畫面確認沒有異常。

截圖（`gantt-*`）：Day／Week／Month × 淺色／深色的 before 與 after；Day 捲到空白區（`*-scrolled-*`）；1024／768（`*-1024-after`、`*-768-after`）；`timeline-week-light-*`。

### 2.2 Part B：Overview

| 項目                       | 結果                                                                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1 統計卡**              | 四張卡整張可點、可 Tab 聚焦與按 Enter、有 hover／focus 回饋；數值 0 時數字轉為次要色（Overdue 大於 0 仍為紅色）。目的地：Active projects → `/projects?status=active`；Open tasks → `/my-tasks/all`；Overdue → `/my-tasks/overdue`；**Due soon → `/my-tasks/all?due=soon`** |
| **B2 Upcoming Tasks**      | 保留 Overdue／Today／Next 7 days 定義。空狀態縮成單行（約 52px，原約 100px），提供「View all N open tasks」；全部已完成時改為「View completed tasks」。與 Milestones 的空狀態用同一個元件                                                                                  |
| **B3 Active projects**     | 每列：色點與名稱｜進度｜**N open**｜日期。自己設定的截止日顯示 `Due Dec 15`；沒設截止日但有任務或里程碑日期時，顯示 `Nov 3 – Dec 8 · from tasks`（最淡色，tooltip 說明是推算而非設定）；完全沒有日期就留白。**移除了所有「—」佔位符**；沒有任務的專案不再顯示假的 0%       |
| **B4 Upcoming Milestones** | 檢查後既有互動已完整（整列可點、進入該專案甘特圖、最多 8 筆並顯示「Showing 8 of N」）。只統一了專案欄寬與空狀態元件                                                                                                                                                        |
| **B5 Next 6 weeks**        | 專案長條與里程碑菱形改為連結：hover 長條顯示專案名與日期範圍（推算的加 `· from tasks`），hover 菱形顯示名稱與完整日期，點擊進入該專案甘特圖。不新增編輯或拖曳                                                                                                              |

**Due soon 的設計取捨**：Overview 的 Due soon 定義是「今天＋未來 7 天」，沒有任何現有分頁剛好對應（My Tasks 的 Today 1＋Upcoming 8＝9）。我們用 URL 篩選 `?due=soon` 實作：My Tasks 的 All 分頁只保留 Today 與 Upcoming 兩個區段，頁首下方有「Due soon · N tasks due today or in the next 7 days」與「Clear filter」，並隱藏此時無意義的「Show completed」。跨頁測試（`metricDestinations.test.tsx`）逐張卡片點擊並驗證目的地顯示的數量等於卡片數字。另外兩個方案（把卡片改成「Due today」，或新增第五個分頁）會牽動 `domain/buckets` 或 router，沒有做。

### 2.3 Part C：Project List

| 項目            | 結果                                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1 日期欄**   | 新增低調的 sticky 欄標題 **Start／Due**（`aria-hidden`）；欄寬集中在 `listColumns.ts`（priority 24px、start 80px、due 96px、menu 24px），任務列、里程碑列與欄標題共用，長任務名稱只縮短自己的欄；**每一列都有 Start 欄位**，沒有開始日的任務 hover／focus 時浮現「Start date」可直接設定；被截斷的任務名稱 hover 可看全文 |
| **C2 No phase** | 專案有正式階段時，`No phase` 排在**最後**（修改在共用的 `buildProjectOutline`，所以 Gantt 與 Timeline 的順序一起改變）；沒有階段時仍是扁平清單。**里程碑被隱藏的疑慮實測後不成立**（只有里程碑時 `No phase` 本來就會顯示），沒有改動，只補了測試                                                                          |
| **C2 計數**     | 見 §2.5 的口徑對照表。List 階段標題的數字加 tooltip，例如「3 tasks, 2 subtasks, 1 milestone」                                                                                                                                                                                                                             |
| **C3 操作細節** | Hover、行內日期修改、Priority 入口、拖曳排序、Add task、鍵盤 focus 檢查後都不需要改。唯一的修正：空專案的「Add a phase first」原本開對話框，送出後焦點掉到 `body`；現在開啟 List 內的行內 Add phase 列，輸入框取得焦點，Enter 後焦點留在輸入框（專案選單的對話框維持不變）                                                |

### 2.4 Part D：Project Board

| 項目            | 結果                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D1 欄位佈局** | 檢查後不需要改：三欄固定、每欄最小 280px，窄視窗水平捲動，拖曳排序與跨欄移動正常                                                                                                                                                                                                                                                           |
| **D2 卡片**     | **日期 hover 現在真的顯示完整日期**（`Due Friday, November 13, 2026`，逾期加 `Overdue · `）。原本的 `title` 其實從來沒有作用：卡片內容層是 `pointer-events-none`，hover 不到日期。現在日期有自己的點擊熱區，並把 pointerdown 與 click 轉交給拖曳與開啟任務，實測從日期上起拖仍可跨欄、點日期仍可開啟任務。白色卡片、階段晶片、逾期呈現不變 |
| **D3 階段篩選** | 篩選結果與欄位數字一致，切換篩選只改 URL、不寫入任務。空狀態改為「No tasks in Design」，按鈕由「Show all phases」改為「Clear filter」；`No phase` 篩選為空時維持「Every task in this project has a phase.」（agent 一度改成「No tasks without a phase」，雙重否定且讓既有 E2E 失敗，我已還原）                                             |

### 2.5 Part E：跨頁面一致性

**E1 計數口徑**：先盤點各數字的語意，**不強迫統一**，只讓使用者看得懂。沒有發現明確的計數錯誤。

| 位置                                               | 數字意義                                 | 含子任務                     | 含里程碑 | 說明方式                                                                                                       |
| -------------------------------------------------- | ---------------------------------------- | ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| List 階段標題（Discovery 3）                       | 該群組的頂層任務數                       | 否                           | 否       | tooltip「3 tasks, 2 subtasks, 1 milestone」                                                                    |
| Gantt 階段標題（Discovery 5）                      | 有日期的任務（含子任務）                 | 是                           | 否       | **新增 tooltip**「5 tasks with dates, subtasks included」；Unscheduled 為「…without dates, subtasks included」 |
| Board 欄位標題（To Do 7）                          | 該狀態的頂層任務數；階段篩選時只算篩選後 | 否（子任務在父卡片顯示 1/2） | 否       | tooltip「Top-level tasks; subtasks show on their parent's card」                                               |
| 專案標頭進度（20%）                                | 完成的葉任務 ÷ 全部葉任務                | 是（父任務不算）             | 否       | 既有 aria-valuetext                                                                                            |
| Projects 頁「open / total」、Overview 的「N open」 | 未完成任務數                             | 是                           | 否       | 既有 tooltip「subtasks included」                                                                              |

**E2 日期顯示規則**：**行內用短格式（Today／Tomorrow／Yesterday／Nov 13），hover 一律用完整長格式（Friday, November 13, 2026）**。盤點時發現不一致，已處理：

- `DueLabel`（My Tasks、Search、Gantt 左欄、子任務、Board 共用）的 tooltip 原本是 `Due Nov 13, 2026`，Board 又另外用長格式；現在全部統一為長格式，並移除 agent 加的 `titleFormat` 選項。
- Gantt 里程碑 tooltip 由 medium 改為 long，與 Overview 里程碑一致。
- List 與 Task Modal 的日期按鈕原本只有給螢幕閱讀器的 `aria-label`，視覺使用者看不到「Today」是哪一天；現在補上 `title`。
- 逾期、今日、完成後中性的語意，各頁都走同一個 `dueBucket`，一致。

**E3 元件互動一致性**：本輪新增或修改的元件（統計卡、List 欄標題與 Start 欄位、Board 日期、Next 6 weeks 連結、空狀態）都沿用既有 token 與共用元件，並檢查了 hover／focus。**這不是一次全站互動狀態稽核**，沒有逐頁驗證 Disabled、Loading。

**E4 階段配色**：沒有修改色彩資料模型或繼承邏輯。從截圖確認 Gantt（色點、彙總線、長條）、List（階段名前色點）、Board（晶片色點）的顏色一致，深淺色皆可讀；衝突與逾期仍優先於階段色。

## 3. 修改的檔案

**程式（26 個修改、3 個新增）**

| 範圍                      | 檔案                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gantt 格線                | `features/gantt/model/scale.ts`、`components/bars.tsx`、`components/GanttChart.tsx`、`features/timeline/TimelineChart.tsx`、`styles/tokens.css`（新增 `--gantt-day-line`，其餘 token 未動） |
| Gantt 計數／日期          | `features/gantt/components/GanttRow.tsx`                                                                                                                                                    |
| 共用元件                  | `components/task/DueLabel.tsx`、`components/task/DateField.tsx`                                                                                                                             |
| 共用大綱順序              | `domain/hierarchy.ts`                                                                                                                                                                       |
| Overview                  | `features/overview/` 下 `ActiveProjects`、`MetricStrip`、`MiniTimeline`、`OverviewPage`、`OverviewSection`、`UpcomingMilestones`、`UpcomingTasks`、`overviewModel`                          |
| My Tasks（Due soon 篩選） | `features/my-tasks/MyTasksPage.tsx`、`myTasksModel.ts`                                                                                                                                      |
| List                      | `features/list/` 下 `ListView`、`ListGroup`、`TaskRow`、`MilestoneRow`；**新增** `ListColumnHeader.tsx`、`listColumns.ts`                                                                   |
| Board                     | `features/board/` 下 `BoardView`、`BoardCard`、`BoardColumn`                                                                                                                                |

**測試（20 個修改、1 個新增）**：`scale.test.ts`、`rows.test.ts`、`GanttView.test.tsx`、`DueLabel.test.tsx`、`DateField.test.tsx`、`hierarchy.test.ts`、`ListView.test.tsx`、`BoardView.test.tsx`、`OverviewPage.test.tsx`、`overviewModel.test.ts`、`MyTasksPage.test.tsx`、`myTasksModel.test.ts`、`backup.test.ts`、`timeline/model/rows.test.ts`、`TaskModalHost.edit.test.tsx`；E2E：`gantt.spec.ts`、`projects-list.spec.ts`、`board.spec.ts`、`overview-mytasks.spec.ts`、`acceptance-resilience.spec.ts`；**新增** `overview/metricDestinations.test.tsx`。

測試修改的原因有兩類：一是 `No phase` 改排最後（Gantt、Timeline、CSV 匯出、依賴選擇器的順序斷言）；二是文案與新行為（空狀態、tooltip、欄標題）。

## 4. 實際測試結果

| 項目                                                         | 結果                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc -b`                                                     | 通過                                                                                                                                                                                                                             |
| `oxlint`                                                     | 無警告                                                                                                                                                                                                                           |
| Prettier（所有修改與新增的檔案）                             | 通過                                                                                                                                                                                                                             |
| `vitest run` 全套（1671 個）                                 | 1668 通過、**3 失敗**。失敗的是 `SettingsPage.test.tsx` 的時區欄位測試 5 秒逾時，**與本輪無關**：我在乾淨的 `pre-ux-iteration-3` 基準版本跑全套，出現完全相同的 3 個失敗；單獨跑該檔則 30 個全過（也是第二輪報告記錄的既有問題） |
| Playwright E2E 全套（490 個）                                | 489 通過、1 失敗。失敗的是 `design.spec.ts`「空篩選的 Board 不會把欄位往下推」，原因是 Board agent 改了 `No phase` 篩選的空狀態文案；還原該句後，重跑 `design.spec` 與 `board.spec` 共 31 個全過。**還原後沒有再重跑一次全套**   |
| 瀏覽器實測（Playwright，獨立連接埠與 Profile，只用合成資料） | Gantt：Day／Week／Month × 淺深色、捲動到空白區、1024／768；Overview：0／1／多個專案、無近期任務、只有里程碑、11 個專案；List：有／無階段、里程碑只在 No phase、長任務名稱、768；Board：篩選、跨欄拖曳                            |

另外，Overview agent 回報它第一次跑 E2E 時有一個 Overview 測試失敗，但它沒有確認原因；該測試在全套裡是通過的，我沒有查出那次失敗的根因。

## 5. 前後對照截圖

位於 `docs/ui-ux-iteration-3-assets/`，共 72 個檔案、約 14 MB。

| 範圍       | 檔名前綴                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gantt 格線 | `gantt-{day,week,month}-{light,dark}-{before,after}`、`gantt-day-{light,dark}-scrolled-*`、`gantt-{day,week}-light-{1024,768}-after`、`timeline-week-light-{before,after}` |
| Overview   | `overview-{empty,one,multi,nodue,milestones,large}-*`，另有 `-1024`、`-768`、`-dark` 變體                                                                                  |
| List       | `list-{rich,rich-dark,rich-768,msonly,flat,empty,nphase}-*`                                                                                                                |
| Board      | `board-{rich,rich-dark,rich-768,rich-filter,msonly-filter,empty}-*`                                                                                                        |

## 6. 未解決問題與取捨

1. **List 在大螢幕上任務名稱與日期距離仍遠。** 欄標題、固定欄寬與 hover 底色有改善，但沒有限制列寬，因為限制會讓 List 與專案標頭對不齊。是否要加列寬上限（例如 `max-w-[68rem]`）請你決定。
2. **空的日期欄仍只在 hover／focus 時浮現**，沒有常駐。欄標題加上 hover 浮現我判斷已足夠可發現，若你想要常駐提示可以再調。
3. **Due soon 卡片的目的地設計**（見 §2.2）需要你確認方向。
4. **768px 以下的整體版面問題維持不變**（審查報告 G-12）：側邊欄不自動收合，Gantt 工具列的 Week／Month 被擠出視窗，List 標題只剩約 250px。不在本輪範圍。
5. **Board 窄視窗時第三欄被截斷**，只能靠水平捲動發現，沒有捲動提示。
6. **Next 6 weeks 的 tooltip 以長條中心為準**，不是游標位置；很寬的長條時 tooltip 離游標較遠，可能蓋住上一列。同一專案同一天的多個里程碑菱形仍會重疊，只靠合併後的 tooltip 補救。
7. **里程碑點擊只會進入專案甘特圖**，不會捲動到該里程碑。
8. **`docs/decisions.md` 沒有更新。** 「`No phase` 排最後」與「hover 一律用完整日期」是會影響後續開發的決定，建議你驗收後補一筆。
9. **截圖約 14 MB**，如果不想把它們放進 repo，可以只保留需要的幾組。

## 7. 新發現的 UX 風險

| 風險                                          | 說明                                                                                                                                                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`No phase` 排序是全站連動**                 | 改在共用的 `buildProjectOutline`，所以 Gantt、Timeline 展開列、CSV 匯出、Task Modal 的依賴選擇器的分組順序都跟著變（階段在前，No phase 在後）。已更新所有測試，但既有使用者會看到順序改變；Gantt 的 Unscheduled 群組內也是 No phase 任務排最後 |
| **Week 刻度的日期線非常淡**                   | 約 2.6% 不透明度，在低對比或亮度較高的螢幕上可能看不見。這是刻意的（要避免棋盤感），但如果覺得太淡，調整 `--gantt-day-line` 即可                                                                                                               |
| **Timeline 也有日期線**                       | 與 Gantt 共用同一個函式，是預期行為，但如果你只想改 Gantt，需要把日期線加成選項                                                                                                                                                                |
| **DateField 現在有原生 `title`**              | List 與 Modal 的每個日期按鈕 hover 約一秒會出現瀏覽器原生 tooltip。與 `aria-label` 內容相同，不影響輔助科技，但外觀與其他自訂 tooltip 不同                                                                                                     |
| **Board 日期成為可點擊熱區**                  | 為了讓 tooltip 生效，日期上有獨立的事件轉發；雖然實測拖曳與開啟任務都正常，熱區很小，是新增的互動細節                                                                                                                                          |
| **My Tasks 的 `?due=soon` 只在 All 分頁生效** | 在其他分頁加這個參數不會有作用（不會出錯）；篩選中會隱藏「Show completed」                                                                                                                                                                     |
| **`DueLabel` 是共用元件**                     | 本輪改了它的 tooltip 格式，影響所有使用它的頁面（My Tasks、Search、Gantt 左欄、子任務、Board）。測試已更新，但如果有人用 `title` 文字做自己的斷言，要同步                                                                                      |

## 8. 其他

- **沒有**修改 Supabase schema、核心排程演算法、資料模型，沒有清除 localStorage、沒有部署。
- 建立了分支 `ux/iteration-3` 與還原點 tag `pre-ux-iteration-3`（只在本機）。
- 暫時用的 Playwright 設定檔、開發伺服器、測試 Profile 都已清除。5173、5174 的行程不是我啟動的，沒有動。

完成後我停在這裡，等你驗收，不會自動進入下一階段。
