# Gantt 元件評估與實作建議

> 狀態：建議（Phase 4 實作依循）｜日期：2026-11-02
> 對應：PRD §2 P0、§4.7、§4.8、§5.3、§6、§11；`docs/architecture.md` §1／§5；`docs/decisions.md` D5–D10
> 資料時間點：npm registry、GitHub API、官方網站都在 2026-11-02 取得；週下載數為 2026-10-23～10-29。
> 證據標示：**【實測】**＝實際安裝並在瀏覽器執行；**【原始碼】**＝讀過 `.d.ts`／dist 程式碼；**【官方】**＝官方網站或套件 README；**【未驗證】**＝只有間接資訊。

---

## 0. 結論（TL;DR）

1. **建議自建「聚焦型」Gantt**：DOM bars、SVG 依賴線圖層、單一捲動容器搭配 sticky 表頭與左欄、`@tanstack/react-virtual` 做列虛擬化，拖曳用自寫的 Pointer Events。直接建立在既有的 `src/domain/dates.ts`、`scheduling.ts` 之上。不整合完整的 Gantt 套件。這與 `docs/architecture.md` §1 已寫下的「custom pointer events (Gantt)」一致。
2. **理由**：限定授權為 MIT／Apache／BSD 且不依賴付費功能時，**沒有任何套件原生涵蓋 PRD §4.7**。最佳候選 SVAR React Gantt（MIT）的通用機制很成熟，包括拖曳、縮放、依賴線與虛擬化。但 PRD 明確要求的五項功能，在 MIT 版都屬於 PRO，而且 MIT build 的程式碼會強制關閉。這點已由**【原始碼】**確認，其中 markers、unscheduledTasks、schedule 三項另經**【實測】**：
   - Today 指示
   - 衝突標示
   - Auto 排程
   - 只有截止日時的 marker
   - 未排程清單

   要補上這五項，需要 10 個以上的 intercept、DOM 或 CSS 介入點，其中幾個依賴未公開的內部狀態。另一方面，排程、驗證、衝突計算本來就必須自己寫，而且 domain 層已經完成大半。整合套件真正省下的只有渲染與互動層，而這一層正好與 Linear 風格的設計系統、我們的資料模型衝突最大。這些資料模型包括獨立的 Phase 與 Milestone、一層子任務、只有截止日的任務、未排程任務。

3. **代價**：自建前期粗估多 **1–2 人日**的互動工程（不確定性較高，見 §6.3），包括拖曳、改長度、拖曳建立依賴、auto-scroll、多層表頭；互動品質與測試也要自己負責。這偏離了 PRD「優先整合套件」的預設，理由與退場條件見 §6。
4. **Plan B**：`@svar-ui/react-gantt@2.8.2`（MIT，鎖定版本）搭配 §8 的缺口補足表。**Plan C**：`dhtmlx-gantt@10`，Community 版自 10.0.0（2026-06）起改為 MIT。
5. **持續觀察**：Bryntum Gantt Community。它自 8.0.0-beta.1（2026-10-23 首發）起提供 MIT tier，並內含排程引擎；但目前仍是 beta，JS 為 538 KB gz。
6. **新增依賴**：只有 `@tanstack/react-virtual@3.14.x`（MIT，peer 支援 React 19，min+gz 10.2 KB）。

---

## 1. 評估基準（PRD §4.7 拆解）

| ID  | 需求                                                                       | 出處與備註                         |
| --- | -------------------------------------------------------------------------- | ---------------------------------- |
| R1  | React 19 相容                                                              | 專案使用 React 19.3                |
| R2  | Day／Week／Month 刻度、Today 定位與指示                                    | §4.7、§4.8                         |
| R3  | 左側 sticky 任務樹：可選 Phase、一層子任務、可展開與收合，父層顯示彙總範圍 | §4.7、§5.1、D7                     |
| R4  | 拖曳中段平移、拖曳兩端改長度、以日曆日對齊                                 | §4.7                               |
| R5  | 里程碑為菱形單日節點，且是**獨立實體**（`milestones` 表）                  | §4.7、D6                           |
| R6  | 可見的 FS 依賴線，可在 bar 之間拖曳建立，也可刪除                          | §4.7                               |
| R7  | 使用我們自己的驗證：不重複、不循環、同專案、不得父子互依                   | §4.7、D10、`validateNewDependency` |
| R8  | 依賴衝突要清楚標示                                                         | §4.7                               |
| R9  | Manual 模式只提示；Auto 模式先預覽舊→新日期，確認後一次原子寫入            | §4.7、D10、`apply_task_schedule`   |
| R10 | Date-only 語意（`YYYY-MM-DD`、包含式、不受時區影響）                       | §5.3、D9                           |
| R11 | 只有截止日的任務以 marker 顯示                                             | §4.7                               |
| R12 | 兩個日期都沒有的任務列在左側「未排程」                                     | §4.7                               |
| R13 | 主題可客製成自有的 Linear 風格深淺模式，與 List／Board 一致                | §7                                 |
| R14 | 約 1,000 列時效能可接受                                                    | 本次評估假設                       |
| R15 | 授權為 MIT／Apache／BSD，不使用 GPL 或純商業授權，不依賴付費功能           | §0 第 7 點、§6                     |

---

## 2. 方法

- **Metadata**：用 `npm view <pkg> --json` 取得 version、license、peerDependencies、time；週下載數取自 `api.npmjs.org/downloads`；GitHub 數據取自 `api.github.com/repos`，包括 stars、`pushed_at`、`open_issues_count`（此數字**含 PR**）、archived。
- **安裝檢查**：在 repo 外的 scratch 目錄，以 `npm install --ignore-scripts` 為每個候選各自安裝，再 grep `.d.ts` 與 dist 程式碼，確認事件、選項，以及 PRO 功能的開關方式。
- **Bundle**：用 esbuild 0.25.10（`--bundle --minify --format=esm`，`react`／`react-dom` 設為 external），只匯入主要元件，再以 `gzip -9` 壓縮。結果是「匯入主元件」的近似值，不代表 tree-shaking 的最佳情況。CSS 另外列出。
- **瀏覽器實測（只測 SVAR）**：以 esbuild 打包 SVAR 與 React 19.3.1，再用 Playwright（Chromium）載入，讀取 DOM、`api.getState()` 與拖曳結果。DHTMLX、Bryntum、VTable 沒有實測，只做到原始碼或官方資料層級。
- **相容性 dry-run**：在 React 19.3.1 與 TypeScript 7.0.2 環境下，以 `npm install --dry-run` 檢查 peer 衝突。

---

## 3. 候選總覽

| 套件                              | 授權                         | 最新版（發佈日）                                                | 週下載  | GitHub（★／最後 push／open issue+PR）                                           | React 19                                                                           | JS min+gz（CSS gz）                  |
| --------------------------------- | ---------------------------- | --------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------ |
| `@svar-ui/react-gantt`            | MIT（另有 PRO 商業版）       | 2.8.2（2026-10-27）                                             | 132,272 | svar-widgets/react-gantt：215★／2026-10-27／15（核心 svar-widgets/gantt：261★） | ✅ peer `>=18`，**【實測】**19.3.1                                                 | 88.5 KB（all.css 22.2 KB）           |
| `dhtmlx-gantt`（Community）       | MIT（10.0.0 起，之前為 GPL） | 10.0.3（2026-09-03）                                            | 55,796  | DHTMLX/gantt：1,868★／2026-09-03／6                                             | 框架無關，需自寫 wrapper（官方 React wrapper 屬 PRO）                              | 174.6 KB（51.1 KB）                  |
| `@bryntum/gantt-community`        | MIT（Community tier）        | 8.0.0-beta.1（2026-10-23 首發）                                 | 279     | 未查                                                                            | wrapper 未宣告 peer，未實測                                                        | 538.0 KB（54.0 KB）                  |
| `frappe-gantt`                    | MIT                          | 1.2.2（2026-02-25）                                             | 363,905 | frappe/gantt：6,157★／2026-06-18／81                                            | vanilla JS，無 React 依賴                                                          | 13.0 KB（1.8 KB）                    |
| `gantt-task-react`                | MIT                          | 0.3.9（2022-07-10）                                             | 67,222  | MaTeMaTuK/gantt-task-react：1,097★／**已封存**／157                             | ❌ peer `react ^18`，**【實測】**ERESOLVE                                          | 11.1 KB                              |
| `@wamra/gantt-task-react`（fork） | MIT                          | 0.6.17（2024-11-30）                                            | 2,666   | wamra/gantt-task-react：51★／2024-11-30／2                                      | peer `>=18`，但需要 `@mui/material ^6`                                             | 46.7 KB（不含 MUI）                  |
| `gantt-task-react-v`（fork）      | MIT                          | 1.8.1（2026-04-10）                                             | 254     | aguilanbon/gantt-task-react-v：3★／2026-04-16                                   | peer 16.8–19                                                                       | —                                    |
| `@visactor/vtable-gantt`          | MIT                          | 1.26.8（2026-09-11）                                            | 2,666   | VisActor/VTable：3,681★／2026-11-02／509                                        | 沒有 Gantt 的 React wrapper，需命令式使用                                          | 568.0 KB                             |
| `react-calendar-timeline`         | MIT                          | 0.30.0-beta.19（2026-07-24）；最後穩定版為 0.28.0（2022-05-30） | 199,187 | namespace-ee：2,162★／2026-07-24／14                                            | beta 版 peer 支援 18／19                                                           | 55.0 KB（含 interactjs、dayjs）      |
| `vis-timeline`                    | Apache-2.0 或 MIT            | 8.5.6（2026-10-26）                                             | 338,239 | visjs/vis-timeline：2,577★／2026-11-01／302                                     | 命令式                                                                             | 158.9 KB（standalone，含 moment）    |
| `react-modern-gantt`              | MIT                          | 0.9.0（2026-05-31）                                             | 2,123   | 46★／2026-06-07／2                                                              | peer 支援 17–19；但 peer `typescript` 只接受 4／5／6，與 TS 7 **【實測】**ERESOLVE | 264.1 KB（含 jspdf、html2canvas）    |
| `svelte-gantt`                    | MIT（依 GitHub）             | 4.5.0（2025-02-10）                                             | 2,801   | ANovokmet：623★／2025-05-03／39                                                 | Svelte 4 元件                                                                      | —                                    |
| `@daypilot/daypilot-lite-react`   | Apache-2.0                   | 6.2.0（2026-10-22）                                             | 16,373  | —                                                                               | peer `>=18`                                                                        | —（Lite 只有 Scheduler，沒有 Gantt） |

---

## 4. 需求覆蓋矩陣

圖例：✅ 原生支援；🟡 可以做到，但需要 adapter、workaround 或大量覆寫；❌ 不支援，或大部分要自己寫；🔒 屬於付費版（PRO／Business／Enterprise）。

| 需求                           | SVAR MIT                                         | DHTMLX Community                                     | frappe-gantt                         | gantt-task-react（＋fork）    | VTable Gantt                        | Timeline 類（rct／vis） | **自建**                            |
| ------------------------------ | ------------------------------------------------ | ---------------------------------------------------- | ------------------------------------ | ----------------------------- | ----------------------------------- | ----------------------- | ----------------------------------- |
| R1 React 19                    | ✅【實測】                                       | 🟡 需自寫 wrapper                                    | 🟡 需自寫 wrapper                    | ❌（原版）／🟡（fork 需 MUI） | 🟡 命令式                           | ✅ rct beta／🟡 vis     | ✅                                  |
| R2 Day／Week／Month            | ✅                                               | ✅                                                   | ✅                                   | ✅                            | ✅                                  | 🟡 需自訂 header        | ✅                                  |
| R2 Today 指示                  | 🔒 vertical markers → 🟡                         | 🔒 markers → 🟡 overlay                              | ✅                                   | ✅                            | ✅ markLine                         | ✅                      | ✅                                  |
| R3 左側樹、Phase、一層子任務   | ✅ 樹，🟡 需映射                                 | ✅ 樹，🟡 需映射                                     | ❌ 沒有 grid                         | 🟡 只有 project 群組          | ✅ ListTable tree                   | 🟡 只有 groups          | ✅                                  |
| R4 拖曳、改長度、日對齊        | ✅【實測】（起拖門檻 20 px）                     | ✅                                                   | ✅                                   | ✅                            | ✅                                  | ✅                      | ✅（自寫）                          |
| R5 里程碑菱形（獨立實體）      | ✅ type，🟡 需映射                               | ✅ type，🟡 需映射                                   | ❌                                   | ✅                            | ✅                                  | 🟡 自繪                 | ✅                                  |
| R6 FS 線：顯示、拖曳建立、刪除 | ✅（也能建 SS／FF／SF，要擋）                    | ✅                                                   | 🟡 只能顯示                          | 🟡 只能顯示／✅ fork          | ✅                                  | ❌                      | ✅（自寫）                          |
| R7 自訂驗證掛鉤                | ✅ `intercept('add-link')`【實測】               | ✅ `onBeforeLinkAdd`（`isCircularLink` 屬 PRO）      | —                                    | —／🟡                         | 🟡 建立後才有事件【未驗證能否阻擋】 | —                       | ✅ 直接呼叫 `validateNewDependency` |
| R8 衝突標示                    | 🔒 → 🟡 以 data-id 套 CSS                        | ✅ `task_class`／`link_class`                        | 🟡 `custom_class`                    | ❌／🟡                        | 🟡 `barStyle` 函式                  | 🟡                      | ✅                                  |
| R9 Manual／Auto 預覽與確認     | 🔒 → 自寫                                        | 🔒 → 自寫                                            | ❌（`move_dependencies` 會直接推移） | ❌                            | ❌                                  | ❌                      | ✅（`computeAutoSchedule` 已存在）  |
| R10 Date-only                  | 🟡 Date 物件，end 為 exclusive【實測】           | 🟡 Date 物件，end 為 exclusive                       | 🟡 本地 Date，end 加 24h             | 🟡 Date                       | 🟡 字串或 Date                      | 🟡 timestamp 或 moment  | ✅ 全程使用 epoch day               |
| R11 只有截止日的 marker        | 🔒 deadlines → 🟡 自訂 type                      | 🟡 `addTaskLayer`                                    | ❌                                   | ❌                            | 🟡 customLayout                     | 🟡 point item           | ✅                                  |
| R12 未排程清單                 | 🔒（MIT 強制關閉）→ 🟡 放在樹外                  | 🔒 → 🟡 放在樹外                                     | ❌                                   | ❌                            | ❌                                  | ❌                      | ✅ 同一棵樹內的群組                 |
| R13 Linear 風格主題            | 🟡 71 個 `--wx-gantt-*` 變數＋Willow／WillowDark | 🟡 180 個 `--dhx-gantt-*` 變數＋dark theme，DOM 較舊 | ✅ CSS 變數                          | 🟡 以 props 設定顏色          | 🟡 canvas，樣式為 JS 物件           | 🟡 CSS                  | ✅ 直接使用 tokens                  |
| R14 約 1,000 列                | ✅【實測】1,004 筆時 DOM 只有 18 個 bar          | ✅ smart rendering                                   | ❌ 整張 SVG                          | ❌／🟡                        | ✅ canvas                           | 🟡                      | ✅ 虛擬化（需 benchmark）           |
| R15 授權與付費依賴             | ✅ MIT（不得使用 PRO props）                     | ✅ MIT（10.0 起）                                    | ✅                                   | ✅（但已封存）                | ✅                                  | ✅                      | ✅                                  |
| Bundle（JS＋CSS，gz）          | 88.5＋22.2 KB                                    | 174.6＋51.1 KB                                       | 13.0＋1.8 KB                         | 11.1 KB／46.7 KB＋MUI         | 568 KB                              | 55 KB／159 KB           | 估計 25–40 KB＋10.2 KB（TanStack）  |

Bryntum Community（beta）未列入矩陣，因為大部分項目都沒有實測，見 §5.3。

---

## 5. 個別評估

### 5.1 SVAR React Gantt（`@svar-ui/react-gantt` 2.8.2，MIT）— 最佳 Plan B

**背景**

- 開發商為 XB Software，與 DHTMLX 同一家公司。舊套件 `wx-react-gantt`（1.x）採 GPLv3；npm 上的 `@svar-ui/react-gantt` 最早版本是 2.3.1（2025-10-22），之後約每月發版，到 2.8.2 共 17 版。
- 依賴 `date-fns@3.6.0` 與十幾個 `@svar-ui/*` 子套件。
- PRO 授權從 US$749 起（Developer 方案：1 位開發者、1 個專案）【官方】。

**MIT 與 PRO 的分界【官方 pricing 表】**

- MIT 版包含：summary tasks 與 milestones、依賴的顯示與編輯、子任務階層、拖曳與改長度、縮放、淺色與深色主題、以 CSS 變數設定樣式、大資料量效能、用來攔截操作的 API。
- **只有 PRO 才有**：unscheduled tasks、auto-scheduling、critical path、constraints、deadlines、工作日曆、**vertical markers**、undo／redo、PDF／PNG／Excel 匯出、baselines、split tasks。

**【原始碼】PRO 功能在 MIT build 中是硬性關閉**

- `DataStore.init()` 會強制設定 `unscheduledTasks=false`、`markers=[]`、`undo=false`、`schedule={}`、`criticalPath=null`、`baselines=false`、`deadlines=false` 等值。
- `getLinkValidator()` 直接回傳 `() => null`，也就是 MIT 版沒有任何連線驗證。
- `.d.ts` 仍然列出這些 PRO props，所以在型別上看起來可以用，但在 MIT 版完全不會生效。

**【實測】結果**（Playwright＋React 19.3.1，1,004 筆任務、200 條依賴）

- 渲染沒有錯誤，也沒有 console warning。
- DOM 只有 18 個 `.wx-bar`、20 個 grid row，**有虛擬化**。
- 傳入 `markers`、`unscheduledTasks`、`undo`、`schedule.auto`、`criticalPath` 後，state 全部被重設為停用，畫面上沒有 `.wx-marker`。
- **end 是 exclusive**：`start=11/02`、`end=11/05` 得到 `duration=3`，寬度 108 px（36 px/day）。我們的包含式 `due=11/05` 必須轉成 `end=11/06`。
- Day 刻度（36 px/day）下拖曳 76 px，結果為 +2 天，日期對齊正確。
- Week 刻度（`lengthUnit:'day'`，16 px/day）：19 px 不會移動，38 px 為 +2 天，86 px 為 +5 天。
- Month 刻度（5 px/day）：12 px 不會移動，27 px 為 +5 天。
- 上述「不會移動」的原因是**起拖門檻寫死 20 px**【原始碼：`Math.abs(dx) < 20`】。超過門檻後才以四捨五入換算天數，所以 Week 刻度（16 px/day）要拖 1 天，滑鼠位移必須剛好落在 20–24 px 之間；Month 刻度（5 px/day）單次拖曳最少移動 4 天。
- `api.intercept('add-link')` 可以擋下 `s2s`、放行 `e2s`，連線數從 200 變成 201。
- 拖曳子任務時，summary 父列也會觸發 `update-task`（衍生事件），adapter 必須過濾掉。

**其他細節【原始碼】**

- 連線類型由起點與終點連到 bar 的哪一端決定，可能是 `e2s`、`s2s`、`e2e`、`s2e`。內建只會擋自連，以及「同 source、同 target、同 type」的重複連線。
- 內建快捷鍵：Backspace 與 Ctrl+D 會刪除任務，Ctrl+C／X／V 會複製或剪貼任務，Ctrl+Z／Y 是 undo（在 MIT 版沒有作用）。這些都必須 intercept，改走我們自己的確認流程。
- 內部 class 帶雜湊（例如 `wx-GKbcLEGA`），只能覆寫穩定的 class 與 CSS 變數。
- bar 有 `data-id`，連線群組有 `data-link-id`，可以用來注入衝突樣式。
- 自訂 `taskTypes` 會產生 `wx-task` 加上自訂 class。
- 打包小瑕疵：`exports.require` 指向不存在的 `dist/index.cjs.js`。ESM 與 Vite 不受影響。

**結論**：React 原生元件、輕量、互動成熟，是 Plan B 的首選。但 R2 的 Today 指示、R8、R9、R11、R12 都要靠 workaround，R13 需要大量覆寫，詳見 §8。

### 5.2 DHTMLX Gantt Community（`dhtmlx-gantt` 10.0.3，MIT）— Plan C

**授權**

- 套件內的 `whatsnew.md` 記載 10.0.0（2026-06-11）的免費版：_"now distributed under the MIT license (replacing the former GPL distribution)"_。

**Community 與 PRO 的分界【官方：npm README 的對照表】**

- Community 包含：
  - grid、樹、inline 編輯
  - 可縮放的單層或雙層刻度
  - summary 與 milestone
  - 四種連線類型與 lag，可拖曳建立連線
  - 拖曳與改長度
  - smart rendering、keyboard nav、templates、skins
  - 匯出（走線上服務）
- PRO 才有：
  - auto-scheduling、critical path、resource、baselines 與 deadlines、constraints
  - undo／redo
  - **timeline markers 與 today line**
  - **unscheduled tasks**
  - 工作日曆、grouping、多選

**擴充掛鉤比 SVAR 豐富【原始碼】**

- bundle 內有 `onBeforeLinkAdd`、`isLinkAllowed`、`templates.task_class`、`link_class`、`timeline_cell_class`、`addTaskLayer`、`getGanttInstance`、`round_dnd_dates`。
- 沒有 `isCircularLink`，循環檢查要自己做。
- 匯出會呼叫 `export.dhtmlx.com` 線上服務，資料會送到第三方，不建議使用。

**缺點**

- 官方 `ReactGantt` wrapper 屬 PRO，所以 Community 版必須在 `useEffect` 裡命令式操作全域 `gantt`，或使用 `Gantt.getGanttInstance()`。
- JS 加 CSS 約 226 KB gz。
- 主題是 `data-gantt-theme`（含 dark）加上 180 個 CSS 變數，但 DOM 結構較舊。
- 日期同樣是 Date 物件，`end_date` 為 exclusive。

**結論**：擴充掛鉤對 R8 與 R11 較友善，但命令式 API、體積與視覺客製成本較高，列為 Plan C。

### 5.3 Bryntum Gantt Community（`@bryntum/gantt-community` 8.0.0-beta.1，MIT）— 觀察

- 這是新消息：Bryntum 8.0 把產品分成 Community（MIT）、Business、Enterprise 三個 tier【官方 README】。
- Community 包含：Dependencies、TaskDrag、TaskResize、TaskDragCreate、CellEdit、TaskMenu、TaskTooltip。
- 完整 TaskEditor、Labels、Indicators、TaskNonWorkingTime 屬於 Business；Baselines、CriticalPaths、Summary、PdfExport 屬於 Enterprise。
- 套件依賴 `@bryntum/engine-community`，也就是排程引擎。Community tier 的自動傳播能否配合我們「預覽 → 確認」的流程，**【未驗證】**。
- 7.x 公開的 `@bryntum/gantt` 只是 placeholder，React wrapper 與 trial 都是商業授權。
- **不建議 V1 採用**：目前仍是 beta（latest 指向 beta，首發才約 10 天），JS 538 KB gz、CSS 54 KB gz，主題系統也是 Bryntum 自有。可在 8.0 GA 後重新評估，見 §6.5。

### 5.4 frappe-gantt 1.2.2（MIT）

- 優點：輕量（13 KB gz）、以 CSS 變數設定主題、內建 Day／Week／Month 與 Today 按鈕。
- 缺點【原始碼】：
  - 沒有左側 grid 或樹。
  - 沒有 milestone 型別。
  - 依賴只能透過 `dependencies` 字串顯示，**不能拖曳建立或刪除**。
  - 預設 `move_dependencies: true`，會在沒有預覽的情況下直接推移後續任務。
  - 整張圖是一個 SVG，沒有虛擬化。
  - 只有日期的 `end` 會以本地時間加 24 小時處理；在有 DST 的時區，切換日會產生一小時偏差，進而影響日期換算。
- 事件只有 `click`、`date_change`、`progress_change`、`view_change` 等。
- **不採用**：R3、R5、R6、R12、R14 都不符合。

### 5.5 gantt-task-react 與 fork

- **原版**：repo 已封存，最後發版在 2022 年，peer `react ^18`。在 React 19.3.1 下 **【實測】** 出現 ERESOLVE。不能拖曳建立依賴，也沒有虛擬化。
- **`@wamra/gantt-task-react`**：功能最多，包括 `onRelationChange`、holiday、`roundDate`、critical path helper、optimized list。但已經 23 個月沒有發版，peer 綁定 `@mui/material ^6`，和我們的 Radix／Tailwind 技術棧衝突。
- **`gantt-task-react-v` 與其他 fork**（例如 `@rsagiev/gantt-task-react-19`、`gantt-task-react-powern`）：都是單人維護、star 個位數。
- **不採用**。

### 5.6 Timeline 類：react-calendar-timeline、vis-timeline、DayPilot Lite

- 這類套件是「資源與時間軸排程器」，不是 Gantt。`.d.ts` **【原始碼】**中沒有 dependency 或 milestone 的概念。它們有 `dragSnap`、`itemRenderer`、`TodayMarker`；vis-timeline 則有 `snap`、`nestedGroups`、`currentTime`。
- 依賴線、驗證、衝突、未排程都要自己疊上去，等於自建大半，卻還受制於套件內部。
- react-calendar-timeline 的最後穩定版停在 2022 年，之後一直是 beta。vis-timeline 依賴 moment。DayPilot Lite 只有 Scheduler，Gantt 屬於 Pro。
- **不採用**。

### 5.7 VisActor VTable Gantt 1.26.8（MIT）

- 功能面完整【原始碼】：
  - `dependency.linkCreatable`、`linkDeletable`
  - `taskBar.moveable`、`resizable`
  - `markLine`（today）
  - 刻度單位支援 day、week、month、quarter、year
  - `taskListTable` 樹
  - 事件 `CREATE_DEPENDENCY_LINK`、`CHANGE_DATE_RANGE`
- 開發活躍：VTable 3.7k★，2026 年發了 19 版。
- **不採用**：
  - 以 **canvas** 繪製，主題只能用 JS 樣式物件設定，無法沿用 CSS tokens，hover、focus 與可及性都弱。
  - `@visactor/react-vtable` 沒有 Gantt 元件，只能命令式使用。
  - JS 568 KB gz。

### 5.8 react-modern-gantt 0.9.0（MIT）

- 只有一層群組。依賴線只能顯示（`dependencyLinks`），不能建立，也沒有 milestone 型別。
- peer `typescript` 只接受 4／5／6，與專案的 TS 7 **【實測】**ERESOLVE。
- 因為打包了 jspdf 與 html2canvas，體積達 264 KB gz。
- **不採用**。

### 5.9 2025–2026 年的新套件

| 套件                                                                                                    | 授權       | 首發 → 最新                     | 週下載 | ★                       | 觀察                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------- | ------ | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@pyraxi/gantt`                                                                                         | MIT        | 2026-06 → 1.7.6（2026-10-19）   | 75     | 0                       | **建在 SVAR MIT 之上，加上自有 CPM engine**，佐證「SVAR MIT 本身沒有排程」                                   |
| `@jaeungkim/gantt-chart`                                                                                | MIT        | 2025-03 → 1.7.0（2026-10-27）   | 690    | 20                      | 單人維護                                                                                                     |
| `@bimetal/gantt-react-components`                                                                       | Apache-2.0 | 2026-07 → 0.42.0（2026-10-30）  | 221    | —                       | 0.x，單人維護，npm 沒有 repo 欄位                                                                            |
| `gantt-lib`                                                                                             | MIT        | 2026-02 → 0.146.0（2026-10-05） | 220    | 3                       | 8 個月發了 196 版，單人維護                                                                                  |
| `mantine-gantt`                                                                                         | MIT        | 2026-02 → 0.7.0（2026-10-21）   | 4,895  | 4                       | 綁定 Mantine 9                                                                                               |
| `@umriss-ui/schedule`                                                                                   | MIT        | 2026-09 → 0.53.0（2026-11-01）  | 1,928  | —                       | 綁定 `@umriss-ui/core`                                                                                       |
| `@art-tools/react-gantt`、`@haro/react-gantt`、`@sokkay/react-gantt`、`freegantt`、`@xpyjs/gantt-react` | MIT        | 2025–2026                       | 5–268  | 0–351                   | 都是 0.x 或單人維護                                                                                          |
| Kibo UI Gantt（shadcn registry，`shadcnblocks/kibo`）                                                   | MIT        | repo 最後 push 2026-05-04       | —      | 3,978（整個 kibo repo） | 複製式元件，約 1,470 行。只有 daily／monthly／quarterly，**沒有依賴線、milestone、虛擬化**。只適合當視覺參考 |

**結論**：新套件都沒有足夠的維護者或使用量，不適合當作最重要功能的基礎。

### 5.10 因授權不符而排除

- **GPL、AGPL 或非商用授權**：`wx-react-gantt`（SVAR 舊版，GPLv3）、`@fluidence/react-gantt`（GPL-3.0）、`ganttcraft`（AGPL-3.0）、`react-gantt-lite`（PolyForm-Noncommercial）。
- **非開源或附加條件**：`@libxai/board`（BUSL-1.1）、`gantt-schedule-timeline-calendar`（NEURONET 專有 Free／Trial 授權，限制修改與散布）、`@polycyphers/gantt`（UNLICENSED）。
- **商業授權**：SVAR PRO、DHTMLX PRO（含官方 React wrapper）、Bryntum Business／Enterprise 與 7.x、Syncfusion、Kendo React Gantt、DevExtreme Gantt（`devexpress-gantt` README 寫明需要商業授權）、Highcharts Gantt、amCharts 5、jQWidgets。

---

## 6. 決策：自建聚焦型 Gantt

### 6.1 為什麼不整合

1. **PRO 牆正好落在 PRD 的必要功能上。** Today 指示、衝突標示、Auto 排程、截止日 marker、未排程清單，在 SVAR 與 DHTMLX 的免費版都被鎖住。SVAR MIT 甚至在 `init()` 裡把相關設定硬性清空。補足方式只能依靠 DOM data-attribute、內部 `_scales`／`_start` 狀態，或另外疊一層 overlay；每次升級都可能失效，而廠商也沒有動機讓這些介入點保持穩定。
2. **最難的「引擎」本來就要自己寫，而且已經寫了。** `src/domain/scheduling.ts` 已經實作 `taskSpan`、`findConflicts`、`validateNewDependency`、`wouldCreateCycle`、`computeAutoSchedule`、`rollupRange`，並採用包含式、epoch-day 運算與部分日期的上下界語意。換句話說，套件能提供的價值只剩渲染與互動。
3. **資料模型不合。** 套件只有單一任務樹，而我們有四種實體：Phase、Task、Subtask、Milestone，另外還有只有截止日、只有開始日、未排程三種日期狀態。用套件就得處理 ID 前綴、衍生 summary 事件、`indent`／`move`／`paste` 快捷鍵造成的第二層巢狀，以及里程碑不得連線（D6）等限制，全部都要 intercept。
4. **設計系統不合。** PRD 要求 Linear 風格，而且 List、Board、Gantt 必須一致。套件左側 grid 是它自己的表格元件，不是我們的 List row；要把 Willow 主題改到「看不出是第三方元件」，需要覆寫大量雜湊 class 與 70 到 180 個變數。
5. **兩份狀態。** 套件內部有自己的 store，我們的 zustand store 又有樂觀更新與 inverse patch 回滾（D5），兩邊要雙向同步，失敗回滾的路徑也會變複雜。
6. **互動細節不可控。** SVAR 的 20 px 起拖門檻寫死在程式碼裡：Week 刻度拖 1 天只有 20–24 px 的空間，Month 刻度單次最少移動 4 天。
7. **可以重用到 Cross-project Timeline（§4.8）。** 同一套渲染與座標模組可以直接畫「專案彙總列 → 展開任務」。

### 6.2 自建的代價與風險

- 要自己負責拖曳、改長度、建立依賴、auto-scroll、線段路由、多層表頭與鍵盤可及性的品質，邊界情況全部由我們測試。
- 不會「順便」得到套件的附加功能，例如 inline grid 編輯、匯出、完整鍵盤導覽。不過 PRD 也沒有要求這些。
- 偏離 PRD「優先整合」的預設。緩解方式：
  - 範圍嚴格限定為日粒度、只有 FS、一層子任務、約 1,000 列、桌機優先。
  - 排程引擎（domain）與 UI 分離，必要時可以換成 Plan B。
  - 設定退場條件（§6.4）。

### 6.3 成本粗估

僅供相對比較；domain 排程邏輯兩案共用，不計入。

| 工作項目                                                    | 自建（人日）    | SVAR Plan B（人日）                         |
| ----------------------------------------------------------- | --------------- | ------------------------------------------- |
| Auto 預覽 Dialog、`apply_task_schedule`、樂觀更新與回滾接線 | 1–1.5           | 1–1.5                                       |
| 版面、虛擬化、刻度與表頭                                    | 1.5–2           | 0.5（設定）                                 |
| bar、marker、milestone、rollup、未排程群組                  | 1–1.5           | 1.5–2（自訂 type、樹外清單、today overlay） |
| 拖曳、改長度、auto-scroll                                   | 1.5–2.5         | 0.5–1（adapter、雙向同步與 intercept）      |
| 建立與刪除依賴、線段路由                                    | 1.5–2.5         | 0.5（另加「只允許 FS」）                    |
| 深淺主題與 List 一致                                        | 0.5             | 1.5–2.5（覆寫）                             |
| 中和內建 hotkey、editor、menu；版本升級稽核                 | 0               | 0.5–1                                       |
| 測試（unit＋E2E）                                           | 1.5–2           | 1.5                                         |
| **合計**                                                    | **約 8.5–12.5** | **約 7.5–10.5**                             |

前期自建約多 1–2 人日，而且互動層的不確定性較高，所以設了 §6.4 的退場條件。換來的是規格完全吻合、沒有 PRO 陷阱、單一狀態來源、與設計系統一致，以及後續功能擴充（例如把未排程任務拖到時間軸上）的成本較低。

### 6.4 退場條件（切換到 Plan B）

Phase 4 第一個切片先做「互動 spike」，上限 2 人日。條件是在本機模式下，用 1,000 筆任務與 500 條依賴的 seed 資料，同時達成以下四點：

- (a) 在 Chrome 與 Safari 拖曳、改長度、建立依賴時，Performance 面板沒有超過 50 ms 的 long task，體感約 60 fps。
- (b) 重新整理後日期正確。
- (c) Playwright 的拖曳與建立依賴測試連續跑 10 次都穩定通過。
- (d) 深淺模式都正確。

如果未達標，而且剩餘工作估計超過原計畫的 1.5 倍，就改用 §8 的 Plan B。只更換 `features/gantt` 的 UI 層，domain 與 store 不動。

### 6.5 重新評估的觸發條件

- SVAR 把 markers、unscheduled、deadlines 移到 MIT 版。
- Bryntum 8.0 Community 正式 GA，而且 React 19 wrapper 與體積可以接受。
- 產品需求擴大到工作日曆、資源管理或 MS Project 匯出等商業級排程功能。到時需要重新檢討授權與預算。

---

## 7. 建議架構（自建）

### 7.1 模組配置

依 `docs/architecture.md` 的目錄所有權：

```
src/domain/                 （已存在）dates.ts、scheduling.ts、hierarchy.ts、graph.ts
src/features/gantt/
  model/scale.ts            SCALES 設定、header tier 產生器（純函式＋unit test）
  model/geometry.ts         dayToX / xToDay / barRect / pointX / linkPath（純函式＋unit test）
  model/rows.ts             outline → GanttRow[]（phase / task / subtask / milestone / unscheduled-group）
  model/dragReducer.ts      拖曳狀態機（純函式＋unit test）
  GanttView.tsx             toolbar（Day/Week/Month、Today、Manual/Auto、衝突 chip）+ scroller
  GanttScroller.tsx         單一捲動容器、sticky header / 左欄、虛擬化
  TimeHeader.tsx  GridBackground.tsx  TodayLine.tsx
  RowLeftCell.tsx           名稱、狀態 icon、展開箭頭、縮排（沿用 components/task 原件）
  bars/ TaskBar.tsx  DueMarker.tsx  StartMarker.tsx  MilestoneDiamond.tsx  RollupBar.tsx
  LinkLayer.tsx             SVG 依賴線（含選取／刪除）
  DragLayer.tsx             ghost bar、日期 tooltip、建立中的連線
  RescheduleDialog.tsx      Auto 預覽（舊→新、Δ 天、確認／取消）
  interaction/ useGanttPointer.ts  useAutoScroll.ts  useGanttKeyboard.ts
src/features/timeline/      重用 model/* 與 GanttScroller（rows 改為「專案彙總 → 任務」）
```

### 7.2 資料流

```
workspace store (zustand) ──selectors(memo)──► rows / spans / conflicts(findConflicts) ─► render
        ▲                                                                                  │
        │ optimistic patches + RPC (apply_task_schedule)          pointer / keyboard / modal
        │                                                                                  ▼
  store.applySchedule([change, ...shifts]) ◄─ RescheduleDialog ◄─ planner: Manual → [change]
                                                                  Auto  → computeAutoSchedule()
```

- 「改日期」只有一個 command。Gantt 拖曳、Task Modal、List inline 改日期都走同一條 planner 路徑，所以 Manual／Auto 規則在每個視圖都一致。模式讀取 `project.scheduleMode`（DB 欄位 `schedule_mode`）。
- 拖曳期間的暫態狀態放在 Gantt 的 local store 或 ref，**不寫入 workspace store**。只有 `DragLayer` 與相關連線會隨 pointermove 重新渲染。

### 7.3 座標系與日期

- 所有幾何計算都用整數 epoch day（`toEpochDay` / `fromEpochDay`），**不使用 `Date` 物件**，所以沒有時區或 DST 偏移（D9）。
- `originDay` 等於 `min(專案開始, 最早任務日期, 今天)` 減去留白；`endDay` 同理取最大值再加留白。
- 公式（`ppd` 為 px-per-day）：
  - `x(day) = (day - originDay) * ppd`
  - range bar：`left = x(start)`，`width = (end - start + 1) * ppd`（包含式），視覺上最小寬 6 px
  - 點狀元素（里程碑、截止日 marker）：中心 `x(date) + ppd / 2`
  - pointer 轉日期：`originDay + Math.floor(contentX / ppd)`
  - 拖曳位移：`Math.round(dxContent / ppd)`，其中 `dxContent = (clientX - startClientX) + (scrollLeft - startScrollLeft)`
- Today 由 `useToday()`（`todayInTimeZone(preferences.timezone)`）提供；快捷鍵 `T` 捲動到今天。

### 7.4 刻度：px-per-day 與表頭

UI 文字依 architecture §3 使用英文。週起始日依 `preferences.weekStartsOn`，透過 `startOfWeek()` 計算。

| Scale | px/day | 單位寬            | 上層 tier                | 下層 tier                | 背景                                     | 預設前後留白 | 拖曳最小單位                       |
| ----- | ------ | ----------------- | ------------------------ | ------------------------ | ---------------------------------------- | ------------ | ---------------------------------- |
| Day   | 36     | 1 天 = 36 px      | 月 `Nov 2026`            | 日 `2` 加星期縮寫 `M`    | 每日細線、週界較深、週末底色、今日欄淡色 | 14 天        | 1 天                               |
| Week  | 16     | 1 週 = 112 px     | 月 `Nov 2026`            | 週 `Nov 2–8`（或 `W45`） | 週界線、月界較深、週末淡底色             | 6 週         | 1 天                               |
| Month | 5      | 1 月 ≈ 140–155 px | 年 `2026`（可選季 `Q4`） | 月 `Nov`                 | 月界線、季／年界較深、不畫週末           | 3 個月       | 1 天（精細調整建議用鍵盤或 Modal） |

- 表頭儲存格由 `model/scale.ts` 依可視範圍（前後各多一個 viewport）產生：`{ key, x, width, label }[]`。只渲染可見的部分。
- 每日線與週末底色用 CSS `repeating-linear-gradient`，以 `background-position-x` 對齊 `originDay` 的星期，不需要每天一個 DOM 節點。月界不規則，在可視範圍內各用一條 1 px 的絕對定位線。
- 切換刻度時保持中心日期不變：先記錄 `centerDay`，換 `ppd` 後再設定 `scrollLeft = x(centerDay) - viewportWidth / 2`。刻度偏好由 `viewPrefs.ts` 依專案保存。

### 7.5 版面：單一捲動容器＋sticky，不做 JS scroll sync

```
┌ scroller: overflow:auto（同時負責 X/Y）─────────────────────────────────────┐
│ ┌ corner: sticky top+left ┐┌ time header: sticky top（2 tiers）─────────────┐ │
│ └─────────────────────────┘└────────────────────────────────────────────────┘ │
│ ┌ body: height = rows × 32px；width = LEFT_W + timelineWidth ───────────────┐ │
│ │ virtual row (absolute, translateY)                                       │ │
│ │  ├ left cell: position:sticky; left:0; 不透明背景；捲動時右側陰影        │ │
│ │  └ lane: bar / marker / diamond / rollup + 連接點                        │ │
│ │ LinkLayer <svg>（absolute，內容座標）  TodayLine  DragLayer               │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **為什麼用單一容器**：左樹與時間軸共用同一個垂直捲動，不需要用 `onScroll` 同步兩個容器，避免 trackpad 慣性捲動時的抖動與錯位。sticky 表頭與左欄全部交給瀏覽器處理。
- **列虛擬化**：`useVirtualizer({ count: rows.length, getScrollElement, estimateSize: () => 32, overscan: 10 })`，使用固定列高 32 px（bar 高 20 px）。用 `rangeExtractor` 強制保留「正在拖曳的列」，避免 auto-scroll 時被卸載。
- **水平方向**：每列只有一個 bar，所以 bar 不需要水平虛擬化；表頭與月界線只渲染可視範圍。
- **範圍延伸與 scroll anchoring**：拖曳或捲動接近 `originDay` 時，向左延伸 N 天，並在同一個 `useLayoutEffect` 中執行 `scrollLeft += N * ppd`，避免畫面跳動。接近 `endDay` 時直接延伸即可。

### 7.6 渲染層與列類型

**Z 軸由下到上**：lane 背景、週末與今日、**依賴線 SVG**、bars、markers、連接點與把手、拖曳 ghost 與建立中的連線、sticky 左欄、sticky 表頭、corner。

| 列或 span                     | 呈現                                                                                                                                                   | 互動                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `taskSpan().kind === 'range'` | `TaskBar`：圓角條。狀態用形狀與 icon 區分（To Do 中性、In Progress 左側 accent 條、Done 加勾號並降低不透明度），不只靠顏色。寬度夠時標籤在內，否則在右 | 拖曳中段、兩端改長度、連接點拖曳建立依賴、點擊開啟 Task Modal |
| `'due_only'`                  | `DueMarker`：截止日上的細刻線加小旗，標籤 `Due Nov 5`，形狀與里程碑菱形明顯不同                                                                        | 拖曳移動截止日，不能改長度（P1 可加「設定開始日」把手）       |
| `'start_only'`                | `StartMarker`：開始日刻線，右側漸淡表示沒有結束日                                                                                                      | 拖曳移動開始日                                                |
| `'unscheduled'`               | 放在左樹底部的「Unscheduled (n)」群組，沒有 bar。有子任務帶日期的父任務不算未排程                                                                      | P1：從左欄拖到時間軸即可排程，`start = due = 放下的那一天`    |
| Phase 列                      | `RollupBar`：細條加兩端括號，範圍為 `rollupRange(phase 內任務, 里程碑)`，唯讀                                                                          | V1 不可拖。P1 可做「整組平移」並沿用預覽 Dialog               |
| 父任務                        | 有自己的日期就顯示 `TaskBar`；收合時下方多一條子任務 rollup 細線                                                                                       | 與一般任務相同；子任務不會跟著移動（V1）                      |
| 里程碑列                      | `MilestoneDiamond`：12 px 旋轉方塊，以日期為中心。依 `hierarchy.ts` 放在所屬群組內並按日期排序                                                         | 拖曳改日期；不能建立依賴（D6）                                |

### 7.7 依賴線（SVG）

**路由（FS）**

- 起點 `(xEnd(P) + 2, yMid(P))`，終點 `(xStart(S) - 2, yMid(S))`，間距 `g = 8px`。
- 有足夠空間（`tx - sx ≥ 2g`）時：`M sx,sy H sx+g V ty H tx`，終點加箭頭。
- 回折或衝突時：`M sx,sy H sx+g V sy±rowH/2 H tx-g V ty H tx`。

**剔除**

- 只畫兩端都在目前展開列中，而且 bounding box 與可視範圍（含 margin）相交的線。座標完全由「列索引 × 列高」計算，**不讀 DOM**，所以端點列即使被虛擬化卸載也不影響。
- 端點被收合時隱藏該線。是否要在列上顯示「n 條隱藏連線」，見 §9。

**互動與樣式**

- 每條線另有一條透明 10 px 的 `stroke` 作為點擊區。
- 點擊選取後線條改為 accent 色，並在中點顯示「×」；Delete 或 Backspace 也可以刪除。刪除後顯示「Dependency removed · Undo」toast，不必跳確認框。
- 衝突的線改為 danger 色加虛線，successor 加紅框與警示 icon（不只靠顏色）。衝突來源為 `findConflicts()` 的 `dependencyId` 與 `successorId`。

### 7.8 Pointer 拖曳模型

```
idle ─pointerdown(data-handle)─► pending{mode, pointerId, startX, startScroll, original}
pending ─move > 3px─► dragging            （scroller.setPointerCapture(pointerId)）
pending ─pointerup─► click（開啟 Task Modal 或選取）
dragging ─pointermove(rAF 節流)─► delta = round(dxContent / ppd) → clamp → 更新 ghost
dragging ─pointerup─► commit(command) ─► planner（§7.10）
dragging ─Esc / pointercancel / lostpointercapture─► 還原 → idle
```

- **mode** 依 `data-handle` 決定：`move`、`resize-start`、`resize-end`、`link-out`、`link-in`、`point-move`（里程碑、截止日 marker、開始日 marker）。
- **事件代理**：handler 綁在 body，用 `data-task-id`、`data-handle` 辨識目標。pointer capture 綁在穩定存在的 scroller 上，**不綁在 bar 上**，因為 bar 可能在虛擬化時被卸載。
- **Clamp 規則**：`resize-start` 的新開始日不能晚於截止日；`resize-end` 的新截止日不能早於開始日，最短 1 天；平移沒有限制。日期合法性由 domain `validation.ts` 把關。
- **Auto-scroll**：pointer 距離 scroller 邊緣 40 px 以內時，用 rAF 迴圈捲動，速度與距離成正比，最高約 20 px/frame。`dxContent` 公式已經包含 scroll 位移。
- **回饋**：拖曳時顯示 ghost bar、原位置淡框，以及 tooltip（例如 `Nov 4 → Nov 7 · 4d`）。連到被拖任務的線即時重新路由。
- **Auto 模式的導引**：有前置任務時，畫出 `requiredStart` 導引線，提示「最早可開始日」。是否在拖曳中直接 clamp，見 §9。
- **為什麼不用 dnd-kit**：dnd-kit 適合 List 與 Board 的排序，但時間軸上的連續拖曳、改長度、日對齊與自訂 auto-scroll，用原生 Pointer Events 更直接，也更容易控制效能。這與 architecture §1 的決定一致。

### 7.9 建立與刪除依賴

- hover bar 時，兩端出現連接點，各為 8 px 圓點，位於 bar 外側 4 px。
- 從**結束點**拖到另一個 bar，建立 `P(來源) → S(目標)`。從**開始點**拖出時方向相反：來源為 successor，目標為 predecessor。
- 拖曳期間，DragLayer 畫出跟隨 pointer 的暫時線。目標用 `document.elementFromPoint` 往上找最近的 `[data-task-id]`；pointer capture 不影響 `elementFromPoint`。
- 經過任何目標時，即時呼叫 `validateNewDependency(tasks, deps, pred, succ)`：合法的目標以 accent 高亮，不合法的以 danger 高亮並在 tooltip 顯示 domain 回傳的 `message`（例如 cycle、duplicate、hierarchy）。里程碑與未排程列不是有效目標。
- 放開後，合法就呼叫 `store.addDependency`（樂觀更新）。如果新連線在 Auto 模式下立刻造成衝突，就把它當成一次 change，走 `computeAutoSchedule` 預覽。
- 資料庫端還有 unique、composite FK，以及「拒絕循環與父子依賴」的 trigger（architecture §4.2）做最後防線。

### 7.10 Manual／Auto 流程與原子寫入

**Manual（預設）**

- commit 只寫入使用者這一次的變更，接著重新計算 `findConflicts`。
- 有新衝突時顯示 toast「Creates 2 dependency conflicts · Review」。
- toolbar 的衝突 chip 會列出所有衝突，點擊可捲動到該任務。chip 上也提供「Fix with Auto…」，對選定的衝突執行預覽。

**Auto**

- 呼叫 `shifts = computeAutoSchedule(tasks, deps, [change])`。它只往後推移後續任務、保留工期，不會移動使用者剛編輯的任務（D10）。
- `shifts.length === 0` 時直接套用。
- 否則開啟 `RescheduleDialog`：
  - 表格欄位：Task、Start 舊→新、Due 舊→新、`+Δd`。
  - 摘要說明：連續日曆日、保留工期、只往後推。
  - 按鈕：Cancel，或「Apply N changes」。
  - 取消時 ghost 回到原位，不寫入任何資料。

**寫入**

- `store.applySchedule([change, ...shifts])` 先做樂觀更新並保留 inverse patches（D5）。
- 接著呼叫 RPC `apply_task_schedule(p_changes)`，全部成功或全部失敗。本機模式由 LocalRepository 以相同語意模擬。
- 失敗時以 inverse patches 回滾，顯示含 Retry 的 toast，不會虛報成功（PRD §5.4、§9.2）。
- 若預覽期間有其他寫入或 refresh 改變了資料，送出前重新計算一次。結果不同時更新 Dialog 內容，不直接套用。

### 7.11 主題 tokens

在 `src/styles/tokens.css` 增加 Gantt 專用的語意 token，並在 `:root` 與 `.dark` 各自定義：

```
--gantt-row-h: 32px;          --gantt-bar-h: 20px;
--gantt-grid-line;            --gantt-grid-line-strong;     --gantt-weekend-bg;
--gantt-today;  (→ accent)    --gantt-today-bg;
--gantt-bar-todo;  --gantt-bar-progress;  --gantt-bar-done;  --gantt-bar-fg;
--gantt-rollup;    --gantt-milestone;     --gantt-due-marker;
--gantt-link;      --gantt-link-selected (→ accent)  --gantt-link-conflict (→ danger);
```

- 元件一律使用語意 utility，不寫死 hex。
- 動畫只用在 hover 與選取，約 120–160 ms；拖曳中不加 transition。遵守 `prefers-reduced-motion`。

### 7.12 效能預算與驗證

- 測試資料：1,000 筆任務與 1,000 條依賴，透過本機模式 seed。
- 目標：
  - 捲動時每次 React commit 少於 8 ms。
  - 拖曳時沒有超過 50 ms 的 long task。
  - 初次渲染的 scripting 少於 100 ms。
  - DOM 中的列數不超過「可視列數＋2 × overscan」。
- 作法：
  - Row 元件 `memo`，以 `id` 加 `updatedAt` 比對。
  - selector 依 project 做 memo。
  - `findConflicts` 只在 tasks 或 deps 變動時重算。
  - 連線剔除以列索引區間加上可視 X 範圍判斷。

### 7.13 可及性與鍵盤

- bar 是可聚焦的 button，`aria-label` 例如「Design review, Nov 2 – Nov 5, 4 days, conflict」。
- 鍵盤操作：
  - `←` / `→`：平移 ±1 天。這也彌補了 Month 刻度下難以精細拖曳的問題。
  - `Shift+←` / `Shift+→`：調整截止日。
  - `Alt+←` / `Alt+→`：調整開始日。
  - Enter：開啟 Task Modal。
  - 選取連線後按 Delete：刪除依賴。
- 變更透過 `aria-live="polite"` 播報。所有狀態都有 icon 或文字，不只靠顏色（architecture §3）。

### 7.14 測試計畫

- **unit（`features/gantt/model`）**：
  - `geometry`：跨月、跨年、閏年 2028-02-29、包含式寬度、snap 四捨五入。
  - `scale`：Day／Week／Month 的 tier 分界、`weekStartsOn` 為 0 與 1。
  - `dragReducer`：clamp、Esc 還原、auto-scroll 位移。
  - `rows`：Phase、一層子任務、里程碑排序、Unscheduled 群組。
- **dom（jsdom）**：四種 span 各自渲染正確，衝突樣式與 aria-label 正確。
- **E2E（Playwright，本機模式）**：
  - 拖曳 +3 天後重新整理，日期仍保留。
  - 改長度。
  - 拖曳建立 A→B；嘗試建立 B→A 時出現 cycle 訊息。
  - Manual 模式延後 A，看到衝突標示。
  - Auto 模式延後 A：預覽 → 取消，資料不變；預覽 → 確認，所有任務一次更新。
  - 用 `window.__cairnTest.failNextWrites(1)` 模擬失敗，確認回滾並出現 Retry。
  - 切換刻度時中心日期不變。
  - 1,000 列時 DOM 列數符合虛擬化預期。
- domain 測試（`scheduling.test.ts`）由 domain 擁有者維護，Gantt 只做整合驗證。

### 7.15 與 Cross-project Timeline 共用（§4.8）

- `model/scale.ts`、`geometry.ts`、`GanttScroller`、`TimeHeader`、`LinkLayer` 都設計成不綁定特定列模型。
- Timeline 的列模型改為「專案列（`rollupRange` 彙總條加上專案里程碑菱形）→ 展開後顯示任務」，預設全部收合。
- V1 的 Timeline 可以先唯讀；之後若要編輯，沿用同一套 command 與 planner。

---

## 8. Plan B：改用 SVAR React Gantt 時的缺口補足表

如果觸發 §6.4，就鎖定 `@svar-ui/react-gantt@2.8.2`，並依下表補足。

| PRD 需求                     | SVAR MIT 現況                                                | 補足方式                                                                                                                                                                                         | 風險                                                    |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Today 指示                   | vertical markers 屬 PRO，MIT 版強制清空【實測】              | 用 `highlightTime(date, unit)` 回傳今日欄的 class（官方表列為 MIT 功能）。Week／Month 另外疊一條 overlay 線，位置需由 `api.getState()` 的內部 `_scales` 或 DOM 量測算出                          | 依賴未公開狀態，升級時容易壞                            |
| 衝突標示                     | 違規標示屬 PRO                                               | 依 `findConflicts` 動態產生 `<style>`，對 `.wx-bar[data-id="t:…"]` 與 `[data-link-id="…"] .wx-line-draw` 套樣式                                                                                  | 依賴 DOM 屬性                                           |
| Auto 預覽與確認              | auto-scheduling 屬 PRO                                       | intercept `update-task`（非 `inProgress` 的那一次）並回傳 false，改走 `computeAutoSchedule` 與 `RescheduleDialog`；確認後先寫 store 與 RPC，再對每個任務執行 `api.exec('update-task')`           | 兩份狀態要同步                                          |
| 只有截止日的 marker          | deadlines 屬 PRO                                             | 在 `taskTypes` 註冊自訂 type `due`，bar 會帶 `wx-task due` class，再用 CSS 畫成 marker；intercept 寬度變更                                                                                       | 屬 hack                                                 |
| 未排程清單                   | unscheduled 屬 PRO，MIT 強制為 false【實測】                 | 在 Gantt 外另列「Unscheduled」清單                                                                                                                                                               | 與左樹分離，UX 打折                                     |
| 只允許 FS                    | UI 可以建立 `e2s`、`s2s`、`e2e`、`s2e`                       | intercept `add-link`：只放行 `e2s`，並通過 `validateNewDependency`【實測可擋】                                                                                                                   | —                                                       |
| Phase、Milestone、一層子任務 | 只有單一任務樹                                               | ID 加前綴 `p:`、`t:`、`m:`；Phase 對應 summary，Milestone 對應 milestone；intercept `add-task`、`move-task`、`indent-task`、`copy-task`、`paste-task`；過濾 summary 的衍生 `update-task`【實測】 | 介入點多                                                |
| 刪除與編輯                   | 內建 Backspace／Ctrl+D 刪除、Ctrl+C／V 複製貼上、內建 Editor | intercept `delete-task` 與 `show-editor`，改走 `confirm()` 與 Task Modal（`?task=`）                                                                                                             | 每次升級都要重新稽核                                    |
| Date-only                    | Date 物件，end 為 exclusive【實測】                          | `start = toLocalDate(start)`，`end = toLocalDate(addDays(due, 1))`；寫回時用 `fromLocalDate`，due 為 end 減 1 天                                                                                 | DST 時區要測                                            |
| 主題                         | Willow／WillowDark 加 CSS 變數                               | 把 tokens 對應到 `--wx-*`，只覆寫穩定 class（`wx-bar`、`wx-task`、`wx-line`）                                                                                                                    | 內部 class 帶雜湊                                       |
| 拖曳精度                     | 起拖門檻寫死 20 px【實測】                                   | 接受這個限制，以鍵盤或 Modal 微調                                                                                                                                                                | Week 刻度拖 1 天只有 20–24 px 空間；Month 刻度最少 4 天 |
| 版本                         | —                                                            | 鎖定確切版本；升級前跑完整 E2E                                                                                                                                                                   | —                                                       |

---

## 9. 未決事項

給 `decisions.md` 與 Phase 4 實作者：

1. **Auto 模式拖曳時是否直接 clamp 在 `requiredStart`**：建議先只畫導引線，放開後再由預覽處理，避免「拖不動」的困惑。
2. **Phase 整組平移**：V1 唯讀；P1 可以沿用 `RescheduleDialog` 顯示所有子任務的位移。
3. **父任務有自己的日期時**：子任務不會跟著自動移動（V1）。子任務超出父任務範圍時，是否需要另一種「範圍警示」，有待決定。
4. **收合時的隱藏連線**：直接隱藏，或在父列顯示計數 badge。
5. **週起始日預設值**：`week_starts_on` 預設為 0 或 1，由設定頁決定，Gantt 只負責讀取。
6. **非常長的專案**：Month 刻度下 10 年約 18,000 px，在瀏覽器上限內；Day 刻度則限制最大範圍，或提示改用 Week 或 Month。

---

## 10. 參考來源

- SVAR React Gantt：<https://svar.dev/react/gantt/>、<https://svar.dev/react/gantt/pricing/>、<https://github.com/svar-widgets/react-gantt>、npm `@svar-ui/react-gantt@2.8.2`（`license.txt`、`types/`、`dist/`）。
- DHTMLX Gantt：<https://dhtmlx.com/docs/products/dhtmlxGantt/>、<https://github.com/DHTMLX/gantt>、npm `dhtmlx-gantt@10.0.3` 的 README（Community vs PRO）與 `whatsnew.md`。
- Bryntum：npm `@bryntum/gantt-community@8.0.0-beta.1` README（Tiers、Features per tier），<https://bryntum.com/products/gantt/>。
- frappe-gantt：<https://github.com/frappe/gantt>（`src/defaults.js`、`src/index.js`）。
- gantt-task-react：<https://github.com/MaTeMaTuK/gantt-task-react>、<https://github.com/wamra/gantt-task-react>。
- react-calendar-timeline：<https://github.com/namespace-ee/react-calendar-timeline>；vis-timeline：<https://github.com/visjs/vis-timeline>。
- VTable Gantt：<https://github.com/VisActor/VTable>（`packages/vtable-gantt`）。
- react-modern-gantt：<https://github.com/MikaStiebitz/React-Modern-Gantt>。
- Kibo UI Gantt：<https://github.com/shadcnblocks/kibo>（`packages/gantt/index.tsx`）。
- GSTC 授權：<https://unpkg.com/gantt-schedule-timeline-calendar@3.43.16/LICENSE>；DevExtreme Gantt：npm `devexpress-gantt` README（License 段落）。
- TanStack Virtual：<https://tanstack.com/virtual>（npm `@tanstack/react-virtual@3.14.25`）。
- 依賴推移語意參考（Asana 提供多種 shifting 選項，命名曾經更動）：<https://forum.asana.com/t/introducing-a-new-option-to-shift-dependent-tasks-in-your-timeline/215172>。官方說明頁 <https://help.asana.com/s/article/auto-shifting-dates-for-dependent-tasks> 需要 JavaScript 渲染，本次無法讀取內容，因此沒有引用其中的定義。
