# Cairn 設計研究與 Design System

> 檔案：`docs/design-research.md` ・ 版本 1.0 ・ 2026-11-02
> 範圍：Linear 2026 介面研究、Asana Timeline／Gantt 互動研究，以及由此推導出的 **Cairn 原創** design tokens 與元件指引。
> 用途：Phase 1（UI Shell、主題、tokens）與之後所有 UI 工作的依據。tokens 實作於 `src/styles/tokens.css`（`:root` = light、`.dark` = dark），再經 `@theme inline` 對接 Tailwind（見 `docs/architecture.md` §8）。
> 文件語言：說明為繁體中文；**App 的 UI 文案為英文**（依 `docs/architecture.md` §3），所以元件範例中的介面字串用英文。

---

## 0. 摘要

- **Linear 2026-03 refresh 的核心**是讓導覽退到背景、讓內容凸顯。具體做法：分隔線減少且變柔和、側邊欄調暗、icon 縮小並重繪、預設色盤改為較暖且低飽和的灰，header、tab 與 view controls 的位置在各頁一致。
- **Cairn 的骨架**分四層：App 底層（側邊欄所在）＋圓角內嵌主面板（inset panel）＋ Location bar（麵包屑與全域動作）＋ View bar（`List / Board / Gantt` tabs 與該視圖的控制項）。
- **色彩**以 PRD 起始色為基礎，維持 OKLCH hue≈277–286、chroma ≤ 0.015 的「帶一點藍紫的中性灰」，搭配柔和藍紫 accent。修正了 PRD 起始色的兩個對比問題：暗色 accent 上放白字只有 **2.79:1**；亮色 accent 在白底上只有 **4.01:1**。調整後所有文字 token 在實際使用的背景上都 ≥ 4.5:1，狀態 glyph 與 Gantt 線條都 ≥ 3:1。
- **字體**：`Inter Variable` 負責拉丁字，中文 fallback 依序為 `PingFang TC`、`Noto Sans TC`、`Microsoft JhengHei`。字重只用 **400／500／600**：實測發現 Linear 的 510 會讓中文落到 Semibold 級的字面（§4.5）。中文不套用負字距。
- **Gantt**：列高 32px、長條 20px、雙層時間表頭。依賴線無衝突時為灰色實線，衝突時改為紅色虛線並加上 ⚠。今日線使用 accent，週末以淡色遮罩標示。沒有日期的任務不推測工期。

---

## 1. 研究來源

所有來源的存取日期皆為 **2026-11-02**。瀏覽器觀察使用 Playwright 的 Chromium 156（macOS），視窗 1440×900。

| ID | 來源（URL） | 取得方式 | 貢獻 |
|---|---|---|---|
| S1 | Linear Now — *A calmer interface for a product in motion*（2026-03-12，Charlie Aufmann & Maxime Heckel）<br>https://linear.app/now/behind-the-latest-design-refresh | WebFetch，另以 Playwright 檢視文章內 5 張官方圖片 | 兩條設計原則；側邊欄調暗、tab bar、icon、邊框與暖灰色盤的變更；內部 color tool。圖片包含：header 分層藍圖、側邊欄前後對照（含標註）、tab bar 對照、邊框對照、Theme Editor 截圖（含 LCH 數值） |
| S2 | Linear Changelog — UI refresh（2026-03-12）<br>https://linear.app/changelog/2026-03-12-ui-refresh | WebFetch＋Playwright（hero 圖） | 官方變更摘要；hero 圖展示新 icon 與按鈕樣式；修正「收合側邊欄 hover 時無法展開」的 bug |
| S3 | Linear Now — *How we redesigned the Linear UI (part II)*（2024-03-28）<br>https://linear.app/now/how-we-redesigned-the-linear-ui | WebFetch | 主題生成改用 LCH；主題只需 base、accent、contrast 三個變數；標題用 Inter Display、其餘用 Inter |
| S4 | Linear Now — *A design reset (part I)*（2024-03-27）<br>https://linear.app/now/a-design-reset | WebFetch | 改版的背景脈絡（沒有具體規格） |
| S5 | Linear Brand Guidelines<br>https://linear.app/brand | Playwright（頁面需要 JS 才能渲染） | 品牌色 Mercury White `#F4F5F8`、Nordic Gray `#222326`；主品牌色是低飽和藍，多用於背景；素材受智財保護。**品牌色≠App UI 色盤，Cairn 不使用任何品牌素材** |
| S6 | Linear 首頁<br>https://linear.app/ | Playwright：截圖、`getComputedStyle`、讀取所有 `:root`／`[data-theme]` CSS custom properties | 首頁用 HTML 繪製的 App 示意（側邊欄、issue 視圖、看板、roadmap）的實測數值；行銷站的 token（字型、字級、字重、圓角、速度、focus ring、陰影、z-index、明暗色票） |
| S7 | Linear Docs：[Timeline](https://linear.app/docs/timeline)、[Project dependencies](https://linear.app/docs/project-dependencies)、[Project milestones](https://linear.app/docs/project-milestones)、[Display options](https://linear.app/docs/display-options)、[Filters](https://linear.app/docs/filters)、[Account preferences](https://linear.app/docs/account-preferences)、[Issues](https://linear.app/docs/creating-issues) | WebFetch；Playwright 擷取 Timeline 與建立 issue Modal 的截圖 | Timeline、依賴與里程碑的規則；Display 與 Filter 的行為；Modal 版面與草稿行為 |
| S8 | Asana Help Center：[Gantt view](https://help.asana.com/s/article/gantt-view)、[Timeline](https://help.asana.com/s/article/timeline)、[Managing tasks and dependencies with timeline](https://help.asana.com/s/article/managing-tasks-and-dependencies-with-timeline)、[Different types of tasks](https://help.asana.com/s/article/different-types-of-tasks) | Playwright（Salesforce 頁面需要 JS；WebFetch 只抓得到導覽列） | Gantt 與 Timeline 互動、依賴的建立方式與衝突提示、三種日期位移模式、未排程任務、里程碑 |
| S9 | Asana Inside Asana（`.md` 版）：[Draw dependencies between tasks](https://asana.com/inside-asana/asana-timeline-draw-dependencies-between-tasks.md)、[Milestones](https://asana.com/inside-asana/new-milestones-visualize-project-progress.md) | WebFetch | 依賴 connector 的操作；里程碑的定義（頁面未標示發布日期） |
| S10 | Tailwind CSS — [Dark mode](https://tailwindcss.com/docs/dark-mode) | WebFetch | v4 用 class 切換 dark 的寫法：`@custom-variant dark (&:where(.dark, .dark *));` |
| S11 | Fontsource：[`@fontsource-variable/inter`](https://cdn.jsdelivr.net/npm/@fontsource-variable/inter/index.css)（npm 5.3.0）、`@fontsource-variable/noto-sans-tc`（5.3.1）；專案內已安裝的 `lucide-react` 1.66.0、`cmdk` 1.1.1、`sonner` 2.0.8、`tailwindcss` 4.3.3 | `npm view`、jsDelivr、唯讀檢查 `node_modules` | 字型 family 名稱為 `'Inter Variable'`（weight 100–900、`font-display: swap`）；icon 名稱是否存在；sonner 的 CSS 變數 |
| S12 | 本機驗證 | Playwright 以 canvas 量測 CJK 字重的墨量；自寫 WCAG 2.x 相對亮度計算 | §4.2 的對比數字、§4.5 的字重結論 |

### 1.1 需要登入或無法觀察的部分（未捏造）

- **Linear App 本體需要登入，沒有直接觀察。** 文中「App 內」的觀察都來自三種公開來源：S1／S2 的官方圖片、S6 首頁的 HTML 示意、S7 的文件截圖。S7 截圖的拍攝時間不明，可能早於 2026-03 refresh。
- **Linear 的淺色主題未能觀察。** 首頁、changelog、docs 都固定為 `data-theme="dark"`；用 `prefers-color-scheme: light` 模擬後仍然是深色。只讀得到行銷站 CSS 裡的 `[data-theme="light"]` token（造訪的頁面都沒有套用），無法驗證 App 內淺色主題的實際配色。
- Linear 的 Command menu（⌘K）外觀、設定頁（`linear.app/settings/...`）、清單列的實際高度：都需要登入，只有文件的文字描述。
- **Asana App 需要登入。** Help 文章內的圖片與 GIF 位於 Salesforce 元件內，沒有擷取到，只採用文字內容。`help.asana.com/s/article/milestones` 回傳 404，改用 *Different types of tasks*。
- 依 PRD 規定，本文不複製 Linear 的原始碼、Logo、圖示或插畫。§2 列出的 Linear 數值只作研究比較，Cairn 的 token 是另外推導的。

---

## 2. 可驗證的觀察

標記說明：**【觀察】**＝直接看到或量到；**【推論】**＝由觀察推導；`[S#]`＝來源。

### 2.1 官方陳述的 2026 原則與變更 [S1][S2]

- 【觀察】目標是保持高資訊密度，但不讓人覺得壓迫，體驗要熟悉且流暢。
- 【觀察】原則一（意譯）：還沒贏得的注意力就不要去爭。與當下任務直接相關的元素保持顯著，導覽與定位用的元素退到後面。
- 【觀察】原則二：*"Structure should be felt not seen."* 分隔線曾經無緣無故地越加越多，這次 refresh 把它們柔化，讓結構存在但不雜亂。
- 【觀察】具體變更：
  - 側邊欄調暗了幾級。
  - 桌面版 tab bar 更緊湊、不再橫跨全寬、加了圓角，icon 與文字縮小，部分 tab 只顯示 icon。
  - icon 在部分視圖減少並縮小，移除彩色 team icon 背景，全部重繪。
  - 分隔線變少、邊緣圓角化、對比變柔和。
  - 預設明暗主題由偏冷的藍灰改為較暖、較低飽和的灰；官方也提到過暖會顯得混濁。
  - header 上的動作（分享、複製連結、開 PR）位置統一；headers、navigation、view controls 在 projects、issues、reviews、documents 之間一致。
- 【觀察】改版以 feature flag 漸進上線。內部 color tool 可調整每個 token 的 hue、chroma、lightness，結果以 JSON 匯出到 Figma。

### 2.2 資訊階層與 App Shell

- 【觀察】[S1 藍圖] header 系統分四層：01 App（視窗）→ 02 Location bar（右側放 icon 動作）→ 03 View bar（視圖層級的動作，如複製連結、複製 ID、split button）→ 04 Content（圓角內嵌面板）。
- 【觀察】[S6 實測] 首頁 App 示意的外框與面板：

  | 部位 | 實測值 |
  |---|---|
  | 視窗框 | radius 12px、padding 8px、底色 `rgb(16,17,18)`、1px `rgba(255,255,255,.08)` 邊 |
  | 側邊欄 | 直接放在視窗框底色上，沒有自己的面板 |
  | 主內容面板 | radius 8px、1px `rgba(255,255,255,.05)` 邊、背景只疊 1% 白、外圈 `0 0 0 2px rgba(0,0,0,.2)` |

- 【觀察】[S6] Location bar：
  - 高 44px、padding 8px 12px，底部 1px `rgba(255,255,255,.05)`。
  - 麵包屑 12px／510／`#d0d6e0`；「1 / 84」計數 12px／`#62666d`。
  - 右側為 28×28 的圓形 icon button。
- 【觀察】[S6] issue 視圖的文字層級：

  | 元素 | 字級／字重 | 其他 |
  |---|---|---|
  | issue 標題 | 20px／590 | line-height 1.33、letter-spacing −0.24px |
  | 區塊標題 | 16px／590 | |
  | 屬性標籤 | 12px | `#8a8f98` |
  | 屬性值 | 12px | `#d0d6e0`，列高 24px |
  | 活動紀錄 | 12px | `#62666d` |

- 【推論】層級靠「亮度、字重、字級」三者分工，幾乎不用線條。

### 2.3 側邊欄 vs 主內容

- 【觀察】[S1 圖註] 側邊欄前後對照標註三點：icon 更小更精緻、非作用中項目的文字變淡、垂直留白增加。作用中的項目（Inbox）保持亮字並加上淡底 pill。
- 【觀察】[S6] 側邊欄實測：

  | 部位 | 實測值 |
  |---|---|
  | nav item | 高 28px、間距 2px（節距 30px）、radius 8px、padding 0 7px、13px／510、`#d0d6e0` |
  | 選取項 | 底色 `rgba(255,255,255,.04)` |
  | 分組標題（Workspace／Favorites） | 高 24px、12px／510、`#62666d`，附展開箭頭 |
  | 寬度 | 總寬 232px（含 padding），項目寬 208px |
  | icon | 13–16px |

  另外，示意中 nav 群組與屬性欄的 `opacity` 是 0.8。
- 【推論】[S2] changelog 修正了「收合側邊欄 hover 時有時無法展開」，可見 Linear 的收合狀態支援 hover 時暫時展開。Cairn 依 PRD 採「icon＋Tooltip」，不做 hover 展開，以免誤觸。

### 2.4 Header、Tabs、篩選與 Display

- 【觀察】[S1 tab bar 對照] 新版 tab 是圓角 pill，釘選的 tab 只剩 icon；作用中的 tab 以較亮的底與亮字表示。
- 【觀察】[S1 邊框對照]
  - Filter、Display、統計、面板切換改成圓形的純 icon 按鈕。
  - 分段控制（Labels／Priority／Projects／Teams）由「框內分段＋分隔線」改為獨立的 pill，作用中的是實心 pill。
  - 舊版的多條水平分隔線，新版全部移除。
- 【觀察】[S7] Display options：
  - 位於視圖右上；`Shift+V` 開啟；`Cmd/Ctrl+B` 切換 list／board。
  - Display 決定「怎麼看」（layout、grouping、ordering、顯示哪些欄位），Filter 決定「看哪些」。
  - 調整預設只影響自己的視圖。
- 【觀察】[S7] Filter：
  - `F` 開啟，可疊加多個條件。
  - 點條件中的運算子可以切換（is → is not）。
  - 進階篩選支援 AND／OR 群組，篩選狀態會寫入 URL。

### 2.5 列表與看板密度

- 【觀察】[S6 看板示意]
  - 欄：寬 300px、欄距 12px。欄標頭依序為狀態 icon、名稱、數量（12px、`#8a8f98`）、「+」與「…」。
  - 卡片：高 96px，分三行（ID、標題、chips）；radius 9px；padding 8/10/12/12；1px `rgba(255,255,255,.08)` 邊；底色 `#0f1011` 疊 2% 白。
  - 卡片文字：ID 10px／`#62666d`，標題 12px／510／`#d0d6e0`。
  - label chip：高 24px、全圓角、1px 8% 白邊、12px／510／`#8a8f98`，前面有 6px 彩點。
- 【未觀察】公開頁面沒有 issue list（清單列）示意，所以 Linear 清單列的高度無法驗證。Cairn 的 36px 是自行決定的（§4）。

### 2.6 邊框與分隔

- 【觀察】[S1][S6] 邊框用白色透明度表達，分三級：
  - 5%：主面板的邊、header 底線。
  - 8%：卡片、chip、視窗框。
  - 12%：timeline 長條。

  行銷站另外定義了 `--border-hairline: .5px`。
- 【推論】分隔優先用留白與表面亮度差；線條只留給功能性的分界，例如 sticky 表頭、可拖曳的分隔線。

### 2.7 圖示

- 【觀察】[S2 hero][S1] 線性 icon、圓角線端，視覺線寬約 1.5px。icon button 為圓形或 pill，split button 中間有細分隔。
- 【觀察】[S1][S2] Linear 的狀態 icon 屬於「圓形系」，例如進行中是部分填滿的圓；優先度則是直立遞增的長條。Cairn 必須使用不同的原創 glyph（§5.12）。

### 2.8 深淺色層次與色彩系統

- 【觀察】[S3]
  - 主題生成由 HSL 改為 LCH，每個主題的變數由 98 個降為 3 個：base、accent、contrast。
  - elevation（背景、面板、對話框、modal）由 LCH 計算，明暗模式共用同一套生成方式。
  - 計算時刻意限制藍色 chrome 的量，以取得中性感。
- 【觀察】[S1 Theme Editor 截圖] 內部工具中顯示的數值：
  - Base `LCH(4.66% 1.41 265.73)`、Accent `LCH(47.918% 59.303 288.421)`、Contrast 27。
  - 衍生層：Elevated L+3／C+1、Menu L+5／C+1。
  - 背景 token：`bgBase` `#0e1012`、`bgBaseHover`（L+1.5）`#141517`、`bgSub`（L−2、C−2）`#060708`。
- 【推論】Linear 的層次是在 base 上做 lightness 的小位移：hover 約 +1.5、elevated 約 +3、menu 約 +5、下沉層約 −2（LCH 單位）。Cairn 採用同一方法論，但用自己的數值，並改在 OKLCH 中推導。
- 【觀察】[S6 CSS] 行銷站的色票（研究參考，Cairn 不沿用）：

  | 主題 | 背景 | 文字 | 其他 |
  |---|---|---|---|
  | dark | `#08090a`／`#0f1011`／`#141516`／`#191a1b` | `#f7f8f8`／`#d0d6e0`／`#8a8f98`／`#62666d` | 邊框 `#23252a`／`#34343a`／`#3e3e44`；accent `#7170ff`（hover `#828fff`） |
  | light | `#fff`／`#f9f8f9`／`#f4f2f4`／`#eeedef` | `#282a30`／`#3c4149`／`#6f6e77`／`#86848d` | |

- 【觀察，自算】行銷站最弱的文字色未達 4.5:1：`#62666d` 在 `#08090a` 上是 **3.45:1**，`#86848d` 在白底上是 **3.68:1**。因此 Cairn 規定 tertiary 文字在每個實際使用的背景上都必須 ≥ 4.5:1。

### 2.9 互動狀態

- 【觀察】[S6 CSS] 速度 token：`--speed-highlightFadeIn: 0s`、`--speed-highlightFadeOut: .15s`、`--speed-quickTransition: .1s`、`--speed-regularTransition: .25s`。也就是 hover 底色立刻出現、150ms 淡出。
- 【觀察】[S6 CSS] focus ring 為 2px solid、offset 2px；dark 用 indigo `#5e6ad2`，light 用 `rgba(0,0,0,.4)`。文字選取色用 `color-mix(in lch, …)` 從品牌色推導。
- 【觀察】[S6] pill 按鈕：底色 `rgba(255,255,255,.02)`、inset 1px `rgba(255,255,255,.05)`，文字與 icon `#8a8f98`。
- 【觀察】[S6 CSS] 其他 token：
  - 捲軸 6px，拖曳時 10px。
  - 字重 400／510／590／680。
  - z-index 由低到高：popover 600 < command menu 650 < dialog 700 < toasts 800 < tooltip 1100 < context menu 1200。

### 2.10 Modal

- 【觀察】[S7 截圖，拍攝時間不明] 建立 issue 的 Modal，由上到下：
  - 麵包屑 chips（team › template）；右上為 Save as draft、展開、關閉。
  - 大字的標題輸入，接著是描述。
  - 一列屬性 chips：狀態、優先度、負責人、專案…
  - 以淡分隔線隔出的 footer：左側附件；右側 Create more 切換與 accent 實心主按鈕。
- 【觀察】[S7] 按 Esc 或關閉鈕會詢問是否存成草稿；直接離開頁面則把草稿暫存在本機。
- 【推論】Modal 的資訊順序是：位置（屬於哪裡）→ 標題 → 描述 → 屬性 → 動作。

### 2.11 Command menu／搜尋

- 【觀察】[S7] `Cmd/Ctrl+K` 開啟 command menu，可輸入動作名稱執行；先選取 issue 再按 ⌘K，動作會作用在選取項上；右鍵開啟情境選單。外觀需要登入，未觀察。

### 2.12 動態

- 【觀察】[S6 CSS] 行銷站提供標準 easing 曲線（quad 到 expo）與 §2.9 的速度 token。Linear 沒有公開 App 內的動畫規格。Cairn 採 PRD 的 120–200ms。

### 2.13 Timeline、依賴、里程碑（Linear）

- 【觀察】[S7 Timeline 截圖][S6 roadmap 示意] Timeline 的視覺：
  - **表頭**分兩層：上層月份（12px、大寫、tertiary），下層是每週起始日的數字。
  - **今日**用 accent pill 標示（例如「JUN 18」），並有一條細直線貫穿；月份邊界是虛線格線。
  - **長條**：24px 高、radius 4px、1px `rgba(255,255,255,.12)` 邊、5% 白底加內陰影。
  - **里程碑**是長條內的菱形，名稱以 10px 標在下方：已完成是實心 accent，目前焦點是黃色，未來的是空心。
  - **超過目標日期**的部分以紅色漸層延伸。
  - 專案名稱與狀態 icon 放在長條上方，每列約 76px 以上。這是專案層級的 roadmap，不是密集的任務 Gantt。
- 【觀察】[S7] Timeline 只顯示 projects（issue 不會出現在 timeline）；縮放有 week／month／quarter／year；可以疊加 team cycle。
- 【觀察】[S7] 專案依賴：
  - hover 長條末端會出現圓點，拖到另一個專案即建立。只支援 end → start。
  - 藍線表示沒有違反，紅線表示違反；點擊線可以跳轉或移除。
  - 拖曳專案會連帶推移依賴鏈上 backlog／planned 的專案；按住 `Cmd/Ctrl` 保持鏈不動，按住 `Shift` 則不分狀態一起移動。
- 【觀察】[S7] 里程碑是菱形 icon，形狀隨完成度變化；下一個未完成的里程碑以黃色標示為焦點；可以在 timeline 上右鍵日期新增，也可以拖曳改期。

### 2.14 Asana（Gantt／Timeline）

- 【觀察】[S8] **Gantt view**：
  - 左側清單與 List 視圖的分段相同；可篩選全部、已完成、未完成。
  - 縮放有 Days／Weeks／Months／Quarters／Half-years／Years。
  - 長條顏色可以對應自訂欄位；Compact mode 會壓縮左側清單。
  - Baseline 以斜線底紋長條表示原計畫，實心長條表示現況；每個專案只有一個 baseline。
- 【觀察】[S8] **Gantt 依賴**：hover 任務長條會出現 handle，拖到另一個任務即建立，之後可以從下拉選單選類型；也可以多選後用「Chain dependencies」批次串接。新任務預設自動排程：日期連續、工期 1 天。
- 【觀察】[S8] **Timeline**：
  - 沒有日期的任務放在時間軸右側的 *Unscheduled tasks* 區，可以收合；拖到時間軸上的日期就完成排程。
  - 在時間軸上點日期可以直接新增任務；`Cmd/Ctrl` 多選後可以整批拖移。
  - 子任務只顯示第一層，點左側箭頭展開。
- 【觀察】[S8] **依賴線與日期位移**：
  - 沒有衝突時是**灰線**；後續任務的開始早於前置任務完成時，顯示**紅色**依賴線。
  - 日期位移有三種模式：Maintain buffer（lag shifting，可選全部或只往下游）、Consume buffer（slack shifting，只在衝突時推移）、None（不處理）。
  - 可設定 work schedule，讓位移避開週末。
  - 位移只作用於「兩端都有 due date 且未完成」的任務。
- 【觀察】[S8][S9] 里程碑是一種任務型別（可以把任務標記為里程碑），以**菱形 icon** 顯示。

---

## 3. Cairn 設計原則

1. **內容優先，外框退場。** 側邊欄比主面板暗一階；非作用中的導覽用 `--fg-secondary`，icon 用 `--fg-tertiary`。只有「現在要處理的東西」（標題、日期衝突、主要動作）可以使用高對比或 accent。（對應 Linear 原則一）
2. **結構靠留白與表面，不靠線條。** 層次的優先順序是：間距 → 表面亮度差 → 1px 低對比邊框；最後一種只用在功能性分界。不在列與列之間畫分隔線。（對應 Linear 原則二）
3. **緊湊但可讀，並且照顧中文。** 介面基準字級 13px、列高 36px、數字用 tabular-nums。字重只用 400／500／600，中文內文不用負字距，任何文字都不小於 11px。
4. **顏色是訊號，不是裝飾。** 中性色佔畫面九成以上。accent 只代表「可互動、已選取、現在」；語意色只在需要注意時出現，而且永遠搭配形狀、圖示或文字，不單靠顏色。
5. **一份資料，到處一致。** List、Board、Gantt 共用同一份任務資料與同一套 glyph。每次寫入都有明確的「儲存中／已儲存／失敗」回饋，失敗就回滾畫面。
6. **直接操作，但安全可逆。** 長條、卡片、列都可以拖曳，但每個拖曳操作都要有非拖曳的替代方式（選單或日期欄位）。批次與自動排程一律「先預覽、確認後再原子寫入」；破壞性操作先說明影響範圍。
7. **快而安靜的動態。** 動畫 120–200ms，不彈跳、不旋轉；hover 底色立刻出現、120ms 淡出；`prefers-reduced-motion` 時關閉所有非必要動畫。
8. **兩個主題，一套系統。** 明暗主題共用元件、間距與圓角，只替換色彩 token，並在兩個主題中都驗證對比。

---

## 4. Design tokens

### 4.1 從 PRD 起始色到 Cairn tokens

| 角色 | PRD 起始 | Cairn token | 理由（OKLCH 為參考值） |
|---|---|---|---|
| Dark 主背景 | `#16171C` | `--bg-main` `#16171C`（保留） | `oklch(0.206 0.010 277)`；主文字在其上 14.79:1 |
| Dark 側邊欄／App 底 | — | `--bg-app`／`--bg-sidebar` `#111216` | 比主面板暗 ΔL≈0.023，滿足「側邊欄比主工作區低調」 |
| Dark 卡片／輸入框 | — | `--bg-surface` `#1E1F26` | 位於 main 與 elevated 之間（ΔL≈+0.035），比照 Linear 的小步階 |
| Dark surface | `#22232B` | `--bg-elevated` `#22232B`（保留） | 改用於 popover、menu、modal |
| Dark 文字 | `#E8E9F1` | `--fg-primary`（保留） | 在 main 上 14.79:1、在 elevated 上 12.92:1 |
| Dark accent | `#9093E8` | `--accent`（保留） | 白字只有 2.79:1，所以按鈕文字改用深色 `--accent-fg` `#121318`（6.65:1）；accent 色的文字與連結改用較亮的 `--accent-text` `#A2A5F2`（≥ 6.00:1） |
| Light 背景 | `#F8F8FA` | `--bg-muted` `#F8F8FA` | 用於看板欄、表頭、群組列；App 底與側邊欄改用稍深的 `#F2F2F5`，主面板 `#FFFFFF` |
| Light surface | `#FFFFFF` | `--bg-main`／`--bg-surface`／`--bg-elevated` | 淺色主題靠邊框與陰影分層 |
| Light 文字 | `#242631` | `--fg-primary`（保留） | 在白底上 15.04:1 |
| Light accent | `#7177CE` | `--accent` `#686AC3` | 原值在白底上只有 4.01:1；色相與彩度不變，L 由 0.604 降到 0.565，白字提升到 4.73:1 |

中性色全部落在 OKLCH hue 277–286、chroma ≤ 0.015，與 accent（hue 280–282）同色相，成為「帶一點藍紫的中性灰」。Cairn 刻意**不跟隨** Linear 2026 的暖灰路線，因為 PRD 指定以柔和藍紫為主調；不過借用了它「低飽和、層級只差一點點 lightness」的做法。

### 4.2 WCAG 對比驗證（自算）

計算方式與目標：

- 計算依 WCAG 2.x 相對亮度公式。半透明 token 先與指定背景合成成實色再計算。
- 目標：一般文字 ≥ 4.5:1（AA）；主要文字 ≥ 7:1（AAA）；圖形、glyph、線條與元件邊界 ≥ 3:1（SC 1.4.11）；disabled 豁免。

#### Light theme

| 文字 \ 背景 | sidebar／app<br>`#F2F2F5` | main<br>`#FFFFFF` | muted<br>`#F8F8FA` | surface<br>`#FFFFFF` | elevated<br>`#FFFFFF` | hover@main<br>`#F5F5F6` | hover@elevated<br>`#F5F5F6` | active@sidebar<br>`#E4E4E7` | selected@main<br>`#F0F0F9` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `--fg-primary` `#242631` | 13.46 | 15.04 | 14.18 | 15.04 | 15.04 | 13.80 | 13.80 | 11.85 | 13.27 |
| `--fg-secondary` `#50525E` | 6.94 | 7.75 | 7.31 | 7.75 | 7.75 | 7.11 | 7.11 | 6.11 | 6.84 |
| `--fg-tertiary` `#63646F` | 5.25 | 5.86 | 5.53 | 5.86 | 5.86 | 5.38 | 5.38 | 4.62 | 5.17 |
| `--fg-disabled` `#A6A7AE` | 2.15 | 2.40 | 2.26 | 2.40 | 2.40 | 2.20 | 2.20 | 1.89 | 2.12 |
| `--accent-text` `#6162BD` | 4.71 | 5.26 | 4.96 | 5.26 | 5.26 | 4.83 | 4.83 | 4.15 | 4.65 |

**前景放在實色上：**

| 組合 | 對比 |
|---|---:|
| `--accent-fg` on `--accent` | 4.73 |
| `--accent-fg` on `--accent-hover` | 5.49 |
| `--danger-fg` on `--danger` | 5.45 |
| focus ring `#686AC3` vs main／sidebar／elevated | 4.73／4.23／4.73 |

**非文字元素**（目標 ≥ 3:1；依序為 main／sidebar／elevated）：

| Token | main | sidebar | elevated |
|---|---:|---:|---:|
| `--status-todo`、`--priority-low`、`--border-contrast`、`--gantt-milestone-past`（同為 `#868793`） | 3.56 | 3.19 | 3.56 |
| `--status-in-progress` | 3.47 | 3.11 | 3.47 |
| `--status-done` | 3.73 | 3.34 | 3.73 |
| `--priority-medium` | 7.75 | 6.94 | 7.75 |
| `--priority-high` | 3.86 | 3.45 | 3.86 |
| `--priority-urgent`、`--gantt-conflict` | 5.45 | 4.88 | 5.45 |
| `--gantt-dependency` | 3.61 | 3.23 | 3.61 |
| `--gantt-today` | 4.73 | 4.23 | 4.73 |
| `--gantt-milestone` | 10.92 | 9.78 | 10.92 |

**語意文字**（main／自身 subtle 背景）：

| Token | main | subtle |
|---|---:|---:|
| `--danger` | 5.45 | 4.82 |
| `--warning` | 5.33 | 4.79 |
| `--success` | 5.30 | 4.74 |
| `--info` | 5.32 | 4.79 |

**Gantt：**

| 組合 | 對比 |
|---|---:|
| 長條文字 on 長條 | 12.61 |
| 長條文字 on in-progress 長條 | 11.04 |
| done 文字 on done 長條 | 5.24 |
| 長條邊框 vs 圖表背景（vs 週末遮罩） | 3.26（3.07） |
| 里程碑 vs 長條 | 9.16 |
| 衝突線 vs 長條 | 4.57 |
| 依賴線 vs 週末遮罩 | 3.40 |

長條相關 token 合成後的實色：bar `#EAEAF7`、in-progress `#DBDBF1`、done `#F2F2F3`、border `#8688CF`、weekend `#F8F8F8`。

#### Dark theme

| 文字 \ 背景 | sidebar／app<br>`#111216` | main<br>`#16171C` | muted<br>`#1A1B21` | surface<br>`#1E1F26` | elevated<br>`#22232B` | hover@main<br>`#202126` | hover@elevated<br>`#2C2D35` | active@sidebar<br>`#222326` | selected@main<br>`#2A2B3D` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `--fg-primary` `#E8E9F1` | 15.47 | 14.79 | 14.20 | 13.57 | 12.92 | 13.28 | 11.32 | 12.99 | 11.48 |
| `--fg-secondary` `#B8BAC4` | 9.68 | 9.25 | 8.88 | 8.49 | 8.08 | 8.31 | 7.08 | 8.13 | 7.18 |
| `--fg-tertiary` `#9697A2` | 6.46 | 6.17 | 5.93 | 5.66 | 5.39 | 5.54 | 4.72 | 5.42 | 4.79 |
| `--fg-disabled` `#5C5D66` | 2.86 | 2.74 | 2.63 | 2.51 | 2.39 | 2.46 | 2.09 | 2.40 | 2.13 |
| `--accent-text` `#A2A5F2` | 8.20 | 7.84 | 7.52 | 7.19 | 6.85 | 7.04 | 6.00 | 6.88 | 6.09 |

**前景放在實色上：**

| 組合 | 對比 |
|---|---:|
| `--accent-fg` on `--accent` | 6.65 |
| `--accent-fg` on `--accent-hover` | 7.68 |
| `--danger-fg` on `--danger` | 6.17 |
| focus ring `#A2A5F2` vs main／sidebar／elevated | 7.84／8.20／6.85 |

**非文字元素**（目標 ≥ 3:1；依序為 main／sidebar／elevated）：

| Token | main | sidebar | elevated |
|---|---:|---:|---:|
| `--status-todo`、`--priority-low`（同為 `#9697A2`） | 6.17 | 6.46 | 5.39 |
| `--status-in-progress` | 9.47 | 9.91 | 8.27 |
| `--status-done` | 8.43 | 8.81 | 7.36 |
| `--priority-medium` | 9.25 | 9.68 | 8.08 |
| `--priority-high` | 7.75 | 8.10 | 6.77 |
| `--priority-urgent`、`--gantt-conflict` | 5.95 | 6.23 | 5.20 |
| `--border-contrast`、`--gantt-milestone-past`（同為 `#6E6F7A`） | 3.59 | 3.76 | 3.14 |
| `--gantt-dependency` | 3.80 | 3.98 | 3.32 |
| `--gantt-today` | 7.84 | 8.20 | 6.85 |
| `--gantt-milestone` | 12.50 | 13.07 | 10.92 |

**語意文字**（main／自身 subtle 背景）：

| Token | main | subtle |
|---|---:|---:|
| `--danger` | 5.95 | 4.94 |
| `--warning` | 9.47 | 7.19 |
| `--success` | 8.43 | 6.54 |
| `--info` | 7.89 | 6.18 |

**Gantt：**

| 組合 | 對比 |
|---|---:|
| 長條文字 on 長條 | 10.31 |
| 長條文字 on in-progress 長條 | 8.11 |
| done 文字 on done 長條 | 5.14 |
| 長條邊框 vs 圖表背景（vs 週末遮罩） | 3.79（3.60） |
| 里程碑 vs 長條 | 8.71 |
| 衝突線 vs 長條 | 4.15 |
| 依賴線 vs 週末遮罩 | 3.61 |

長條相關 token 合成後的實色：bar `#313249`、in-progress `#3F4161`、done `#26272C`、border `#6B6EAB`、weekend `#1B1C21`。

#### 刻意的例外與使用限制

- `--fg-disabled` 只有 1.9–2.9:1：WCAG 對 disabled 元件豁免，但必須同時設定 `disabled`／`aria-disabled` 語意。
- Light `--accent-text` 在 `active@sidebar` 上只有 4.15:1：側邊欄作用中的項目一律用 `--fg-primary`，**不要**用 accent 色文字。
- `--border-subtle`、`--border-default`、`--border-strong` 都低於 3:1：它們是裝飾性分隔，刻意如此。
  - 需要辨識邊界的元件（checkbox、radio、關閉狀態的 switch）改用 `--border-contrast`（≥ 3:1）。
  - 文字輸入框閒置時的邊框 `--border-input` 約 1.6:1，靠可見 label 與 focus ring（≥ 3:1）辨識。若要嚴格符合 SC 1.4.11，把 input 邊框換成 `--border-contrast` 即可。
- 暗色 `--gantt-milestone-past` 在 elevated 上是 3.14:1，淺色在 sidebar 上是 3.19:1：Gantt 不會畫在這兩種背景上，兩者仍 ≥ 3:1。
- 這些數字都以 sRGB hex 計算。半透明 token 疊在其他層上時，實際值會有些微差異。

### 4.3 完整 CSS tokens（可直接貼到 `src/styles/tokens.css`）

```css
/* ==========================================================================
   Cairn design tokens — v1.0（2026-11-02）
   :root = Light（預設） · .dark = Dark（加在 <html> 上）
   對比驗證與決策理由：docs/design-research.md §4
   規則：元件內禁止寫 raw hex，一律使用 token。
   ========================================================================== */

:root {
  color-scheme: light;

  /* ---------- Typography ---------- */
  --font-family-sans: "Inter Variable", "Inter", "PingFang TC", "Noto Sans TC",
    "Microsoft JhengHei UI", "Microsoft JhengHei", system-ui, -apple-system,
    "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-family-mono: ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono",
    Menlo, Consolas, monospace;

  --font-size-micro: 11px;    /* Gantt 下層表頭、kbd、小計數 */
  --line-height-micro: 16px;
  --font-size-meta: 12px;     /* meta、chip、分組標題、Gantt 長條文字 */
  --line-height-meta: 16px;
  --font-size-ui: 13px;       /* 基準：列表、側邊欄、按鈕、輸入框 */
  --line-height-ui: 20px;
  --font-size-body: 14px;     /* 描述、Modal 欄位、空狀態說明 */
  --line-height-body: 22px;
  --font-size-heading: 16px;  /* Modal／區塊標題、搜尋輸入 */
  --line-height-heading: 24px;
  --font-size-title: 20px;    /* 頁面標題、Task Modal 任務名稱 */
  --line-height-title: 28px;
  --font-size-display: 24px;  /* Overview 標題、首次使用空狀態 */
  --line-height-display: 32px;

  --font-weight-regular: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;   /* 不使用 501–599：中文會落到 Semibold 字面（§4.5） */
  --letter-spacing-title: -0.01em; /* 只用於 20／24px 標題；其餘一律 0 */

  /* ---------- Spacing（4px grid＋2px 半階；與 Tailwind --spacing: 0.25rem 對齊） ---------- */
  --space-0: 0px;
  --space-0-5: 2px;
  --space-1: 4px;
  --space-1-5: 6px;
  --space-2: 8px;
  --space-2-5: 10px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;

  /* ---------- Radii（數值與 Tailwind v4 預設 rounded-sm/md/lg/xl 相同） ---------- */
  --radius-sm: 4px;      /* Gantt 長條、kbd、小標記 */
  --radius-md: 6px;      /* 按鈕、輸入框、選單項、側邊欄項、tab */
  --radius-lg: 8px;      /* 卡片、popover、menu、toast、看板欄 */
  --radius-xl: 12px;     /* 主面板、Modal、Command overlay */
  --radius-full: 9999px; /* pill chip、switch、進度條 */

  /* ---------- Layout & control heights ---------- */
  --sidebar-width: 240px;
  --sidebar-width-collapsed: 52px;
  --shell-gap: 8px;            /* 主面板與視窗邊緣的距離 */
  --topbar-height: 44px;       /* Location bar */
  --viewbar-height: 40px;      /* View tabs＋視圖控制 */
  --content-max-width: 1200px; /* Overview／Settings 等閱讀型頁面 */
  --h-sidebar-item: 28px;
  --h-row: 36px;               /* List、My Tasks、搜尋結果 */
  --h-row-group: 32px;         /* 階段群組列、選單項 */
  --h-btn-sm: 24px;
  --h-btn-md: 28px;
  --h-btn-lg: 32px;
  --h-input: 32px;
  --h-chip: 24px;
  --icon-sm: 14px;
  --icon-md: 16px;
  --icon-stroke: 1.75;         /* lucide strokeWidth（16px）；14px 時用 1.5 */

  /* ---------- Gantt geometry ---------- */
  --gantt-pane-width: 300px;        /* 左側 sticky 任務欄，可拖曳 220–480px */
  --gantt-header-tier-height: 24px; /* 兩層 → 表頭 48px */
  --gantt-row-height: 32px;
  --gantt-bar-height: 20px;
  --gantt-summary-height: 6px;      /* 階段／父任務彙總條 */
  --gantt-milestone-size: 12px;     /* 菱形外接寬 */
  --gantt-handle-width: 8px;        /* 兩端 resize 熱區 */
  --gantt-connector-size: 8px;      /* 依賴拖曳圓點 */
  --gantt-day-width-day: 32px;      /* Day zoom */
  --gantt-day-width-week: 14px;     /* Week zoom（98px／週） */
  --gantt-day-width-month: 4px;     /* Month zoom（約 120px／月） */

  /* ---------- Motion ---------- */
  --duration-instant: 0ms;   /* hover 底色進場 */
  --duration-fast: 120ms;    /* hover 退場、按壓、tooltip、選單關閉 */
  --duration-base: 160ms;    /* popover／menu 開啟、tab 指示、列表重排 */
  --duration-slow: 200ms;    /* Modal、側邊欄收合、toast */
  --ease-enter: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-exit: cubic-bezier(0.4, 0, 1, 1);
  --ease-move: cubic-bezier(0.65, 0, 0.35, 1);

  /* ---------- Z-index ---------- */
  --z-sticky: 10;
  --z-sidebar: 20;
  --z-dropdown: 50;
  --z-overlay: 60;
  --z-modal: 61;
  --z-command: 70;
  --z-toast: 80;
  --z-tooltip: 90;

  /* ======================= Color · Light ======================= */
  /* Backgrounds */
  --bg-app: #F2F2F5;
  --bg-sidebar: #F2F2F5;
  --bg-main: #FFFFFF;
  --bg-muted: #F8F8FA;          /* 看板欄、表頭、群組列 */
  --bg-surface: #FFFFFF;        /* 卡片、輸入框 */
  --bg-elevated: #FFFFFF;       /* popover、menu、modal、toast */
  --bg-hover: rgba(36, 38, 49, 0.045);
  --bg-active: rgba(36, 38, 49, 0.07);    /* 目前頁、作用中 tab、按下 */
  --bg-selected: rgba(104, 106, 195, 0.10);
  --bg-inverse: #242631;        /* tooltip */
  --bg-overlay: rgba(24, 25, 38, 0.28);

  /* Borders */
  --border-subtle: rgba(36, 38, 49, 0.07);
  --border-default: rgba(36, 38, 49, 0.11);
  --border-strong: rgba(36, 38, 49, 0.18);
  --border-input: rgba(36, 38, 49, 0.24);
  --border-contrast: #868793;   /* ≥ 3:1：checkbox、radio、switch 外框 */

  /* Text */
  --fg-primary: #242631;
  --fg-secondary: #50525E;
  --fg-tertiary: #63646F;
  --fg-disabled: #A6A7AE;
  --fg-inverse: #FFFFFF;

  /* Accent */
  --accent: #686AC3;
  --accent-hover: #5E5FBA;
  --accent-active: #5757B2;
  --accent-subtle: rgba(104, 106, 195, 0.10);
  --accent-subtle-hover: rgba(104, 106, 195, 0.16);
  --accent-fg: #FFFFFF;
  --accent-text: #6162BD;       /* accent 色的文字、連結、icon */

  /* Focus */
  --focus-ring: #686AC3;
  --focus-ring-width: 2px;
  --focus-ring-offset: 2px;

  /* Status */
  --status-todo: #868793;
  --status-in-progress: #BF7B00;
  --status-done: #2C965D;

  /* Priority（Low／Medium 刻意為中性色，形狀才是主要編碼） */
  --priority-none: #A6A7AE;
  --priority-low: #868793;
  --priority-medium: #50525E;
  --priority-high: #D06217;
  --priority-urgent: #C72E2B;

  /* Semantic */
  --danger: #C72E2B;
  --danger-hover: #BC2122;
  --danger-subtle: rgba(199, 46, 43, 0.08);
  --danger-fg: #FFFFFF;
  --warning: #9A5D00;
  --warning-subtle: rgba(154, 93, 0, 0.08);
  --success: #157B48;
  --success-subtle: rgba(21, 123, 72, 0.08);
  --info: #1C70AA;
  --info-subtle: rgba(28, 112, 170, 0.08);

  /* Gantt */
  --gantt-bg: var(--bg-main);
  --gantt-header-bg: var(--bg-main);
  --gantt-grid: rgba(36, 38, 49, 0.06);
  --gantt-grid-strong: rgba(36, 38, 49, 0.11);   /* 週／月邊界 */
  --gantt-weekend: rgba(36, 38, 49, 0.032);
  --gantt-row-hover: rgba(36, 38, 49, 0.03);
  --gantt-row-selected: rgba(104, 106, 195, 0.08);
  --gantt-bar-fill: rgba(104, 106, 195, 0.14);        /* To Do */
  --gantt-bar-fill-active: rgba(104, 106, 195, 0.24); /* In Progress */
  --gantt-bar-fill-done: rgba(36, 38, 49, 0.06);      /* Done */
  --gantt-bar-border: rgba(104, 106, 195, 0.80);
  --gantt-bar-border-done: #868793;
  --gantt-bar-text: #242631;
  --gantt-bar-text-done: #63646F;
  --gantt-summary: #63646F;
  --gantt-milestone: #3A3C49;
  --gantt-milestone-past: #868793;
  --gantt-due-marker: #50525E;
  --gantt-dependency: #858692;
  --gantt-dependency-active: #6162BD;
  --gantt-conflict: #C72E2B;
  --gantt-today: #686AC3;
  --gantt-today-label-bg: #686AC3;
  --gantt-today-label-fg: #FFFFFF;
  --gantt-drag-ghost: rgba(104, 106, 195, 0.10);
  --gantt-drag-ghost-border: rgba(104, 106, 195, 0.60);

  /* Shadows（邊框由元件自己加；陰影只負責浮起感） */
  --shadow-panel: 0 1px 2px rgba(23, 24, 40, 0.04), 0 0 1px rgba(23, 24, 40, 0.04);
  --shadow-popover: 0 8px 24px -6px rgba(23, 24, 40, 0.14), 0 2px 6px rgba(23, 24, 40, 0.06);
  --shadow-modal: 0 24px 64px -16px rgba(23, 24, 40, 0.24), 0 8px 20px -6px rgba(23, 24, 40, 0.10);
  --shadow-drag: 0 12px 28px -8px rgba(23, 24, 40, 0.22), 0 0 0 1px rgba(104, 106, 195, 0.35);

  /* Misc */
  --selection-bg: rgba(104, 106, 195, 0.22);
  --scrollbar-thumb: rgba(36, 38, 49, 0.18);
  --scrollbar-thumb-hover: rgba(36, 38, 49, 0.32);
}

/* ======================= Color · Dark ======================= */
.dark {
  color-scheme: dark;

  --bg-app: #111216;
  --bg-sidebar: #111216;
  --bg-main: #16171C;
  --bg-muted: #1A1B21;
  --bg-surface: #1E1F26;
  --bg-elevated: #22232B;
  --bg-hover: rgba(255, 255, 255, 0.045);
  --bg-active: rgba(255, 255, 255, 0.07);
  --bg-selected: rgba(144, 147, 232, 0.16);
  --bg-inverse: #E8E9F1;
  --bg-overlay: rgba(5, 6, 9, 0.62);

  --border-subtle: rgba(255, 255, 255, 0.06);
  --border-default: rgba(255, 255, 255, 0.09);
  --border-strong: rgba(255, 255, 255, 0.14);
  --border-input: rgba(255, 255, 255, 0.14);
  --border-contrast: #6E6F7A;

  --fg-primary: #E8E9F1;
  --fg-secondary: #B8BAC4;
  --fg-tertiary: #9697A2;
  --fg-disabled: #5C5D66;
  --fg-inverse: #16171C;

  --accent: #9093E8;
  --accent-hover: #9DA0EE;
  --accent-active: #8789DE;
  --accent-subtle: rgba(144, 147, 232, 0.16);
  --accent-subtle-hover: rgba(144, 147, 232, 0.24);
  --accent-fg: #121318;          /* 暗色 accent 上不可放白字（2.79:1） */
  --accent-text: #A2A5F2;

  --focus-ring: #A2A5F2;

  --status-todo: #9697A2;
  --status-in-progress: #E9B452;
  --status-done: #6AC48C;

  --priority-none: #5C5D66;
  --priority-low: #9697A2;
  --priority-medium: #B8BAC4;
  --priority-high: #F1944F;
  --priority-urgent: #F76560;

  --danger: #F76560;
  --danger-hover: #FD736D;
  --danger-subtle: rgba(247, 101, 96, 0.14);
  --danger-fg: #121318;
  --warning: #E9B452;
  --warning-subtle: rgba(233, 180, 82, 0.14);
  --success: #6AC48C;
  --success-subtle: rgba(106, 196, 140, 0.14);
  --info: #65B4E9;
  --info-subtle: rgba(101, 180, 233, 0.14);

  --gantt-bg: var(--bg-main);          /* 重新宣告，讓巢狀 .dark 範圍也正確 */
  --gantt-header-bg: var(--bg-main);
  --gantt-grid: rgba(255, 255, 255, 0.045);
  --gantt-grid-strong: rgba(255, 255, 255, 0.09);
  --gantt-weekend: rgba(255, 255, 255, 0.022);
  --gantt-row-hover: rgba(255, 255, 255, 0.03);
  --gantt-row-selected: rgba(144, 147, 232, 0.10);
  --gantt-bar-fill: rgba(144, 147, 232, 0.22);
  --gantt-bar-fill-active: rgba(144, 147, 232, 0.34);
  --gantt-bar-fill-done: rgba(255, 255, 255, 0.07);
  --gantt-bar-border: rgba(144, 147, 232, 0.70);
  --gantt-bar-border-done: #6E6F7A;
  --gantt-bar-text: #E8E9F1;
  --gantt-bar-text-done: #9697A2;
  --gantt-summary: #9697A2;
  --gantt-milestone: #D6D7E1;
  --gantt-milestone-past: #6E6F7A;
  --gantt-due-marker: #B8BAC4;
  --gantt-dependency: #71737F;
  --gantt-dependency-active: #A2A5F2;
  --gantt-conflict: #F76560;
  --gantt-today: #A2A5F2;
  --gantt-today-label-bg: #9093E8;
  --gantt-today-label-fg: #121318;
  --gantt-drag-ghost: rgba(144, 147, 232, 0.12);
  --gantt-drag-ghost-border: rgba(144, 147, 232, 0.60);

  --shadow-panel: 0 0 0 1px rgba(0, 0, 0, 0.30), 0 1px 3px rgba(0, 0, 0, 0.25);
  --shadow-popover: 0 8px 24px -4px rgba(0, 0, 0, 0.50), 0 2px 6px rgba(0, 0, 0, 0.30);
  --shadow-modal: 0 24px 64px -12px rgba(0, 0, 0, 0.65), 0 8px 20px -4px rgba(0, 0, 0, 0.35);
  --shadow-drag: 0 12px 28px -6px rgba(0, 0, 0, 0.60), 0 0 0 1px rgba(144, 147, 232, 0.40);

  --selection-bg: rgba(144, 147, 232, 0.32);
  --scrollbar-thumb: rgba(255, 255, 255, 0.12);
  --scrollbar-thumb-hover: rgba(255, 255, 255, 0.22);
}

/* ---------- Reduced motion ---------- */
@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-fast: 0ms;
    --duration-base: 0ms;
    --duration-slow: 0ms;
  }
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

/* ---------- Base（最小必要，其餘交給元件） ---------- */
html {
  font-family: var(--font-family-sans);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  scrollbar-color: var(--scrollbar-thumb) transparent;
}
body {
  margin: 0;
  background: var(--bg-app);
  color: var(--fg-primary);
  font-size: var(--font-size-ui);
  line-height: var(--line-height-ui);
  font-weight: var(--font-weight-regular);
}
::selection {
  background: var(--selection-bg);
}
:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
```

### 4.4 對接 Tailwind CSS v4

在 `src/index.css` 中加入以下內容，即可產生語意 utilities，例如 `bg-surface`、`text-fg-muted`、`border-subtle`、`text-ui`：

```css
@import 'tailwindcss';
@import './styles/tokens.css';

@custom-variant dark (&:where(.dark, .dark *));

@theme inline {
  /* surfaces → bg-* */
  --color-app: var(--bg-app);
  --color-sidebar: var(--bg-sidebar);
  --color-main: var(--bg-main);
  --color-muted: var(--bg-muted);
  --color-surface: var(--bg-surface);
  --color-elevated: var(--bg-elevated);
  --color-hover: var(--bg-hover);
  --color-active: var(--bg-active);
  --color-selected: var(--bg-selected);
  --color-overlay: var(--bg-overlay);
  --color-inverse: var(--bg-inverse);
  /* lines → border-* / divide-*（這 5 個名稱只用在線條上） */
  --color-subtle: var(--border-subtle);
  --color-default: var(--border-default);
  --color-strong: var(--border-strong);
  --color-input: var(--border-input);
  --color-contrast: var(--border-contrast);
  /* text → text-* */
  --color-fg: var(--fg-primary);
  --color-fg-secondary: var(--fg-secondary);
  --color-fg-muted: var(--fg-secondary); /* alias：architecture.md 的範例名稱 */
  --color-fg-tertiary: var(--fg-tertiary);
  --color-fg-disabled: var(--fg-disabled);
  --color-fg-inverse: var(--fg-inverse);
  /* accent & focus */
  --color-accent: var(--accent);
  --color-accent-hover: var(--accent-hover);
  --color-accent-active: var(--accent-active);
  --color-accent-subtle: var(--accent-subtle);
  --color-accent-subtle-hover: var(--accent-subtle-hover);
  --color-accent-fg: var(--accent-fg);
  --color-accent-text: var(--accent-text);
  --color-focus: var(--focus-ring);
  /* status / priority / semantic */
  --color-status-todo: var(--status-todo);
  --color-status-in-progress: var(--status-in-progress);
  --color-status-done: var(--status-done);
  --color-priority-none: var(--priority-none);
  --color-priority-low: var(--priority-low);
  --color-priority-medium: var(--priority-medium);
  --color-priority-high: var(--priority-high);
  --color-priority-urgent: var(--priority-urgent);
  --color-danger: var(--danger);
  --color-danger-hover: var(--danger-hover);
  --color-danger-subtle: var(--danger-subtle);
  --color-danger-fg: var(--danger-fg);
  --color-warning: var(--warning);
  --color-warning-subtle: var(--warning-subtle);
  --color-success: var(--success);
  --color-success-subtle: var(--success-subtle);
  --color-info: var(--info);
  --color-info-subtle: var(--info-subtle);
  /* typography → font-sans、text-ui … */
  --font-sans: var(--font-family-sans);
  --font-mono: var(--font-family-mono);
  --text-micro: var(--font-size-micro);
  --text-micro--line-height: var(--line-height-micro);
  --text-meta: var(--font-size-meta);
  --text-meta--line-height: var(--line-height-meta);
  --text-ui: var(--font-size-ui);
  --text-ui--line-height: var(--line-height-ui);
  --text-body: var(--font-size-body);
  --text-body--line-height: var(--line-height-body);
  --text-heading: var(--font-size-heading);
  --text-heading--line-height: var(--line-height-heading);
  --text-title: var(--font-size-title);
  --text-title--line-height: var(--line-height-title);
  --text-display: var(--font-size-display);
  --text-display--line-height: var(--line-height-display);
}
```

**已驗證：** 2026-11-02 用專案已安裝的 `@tailwindcss/node` 4.3.3 編譯本節與 §4.3 的 CSS（未寫入專案）。以下 utilities 都正確產生：`bg-surface`、`bg-muted`、`text-fg-muted`、`border-subtle`、`border-contrast`、`text-ui`（同時輸出 font-size 與 line-height）、`font-sans`、`rounded-lg`、`outline-focus`、`shadow-(--shadow-popover)`、`bg-(--gantt-bar-fill)`、`hover:bg-hover`、`dark:bg-main`（輸出為 `:where(.dark, .dark *)`）。另外，§4.3 的 token CSS 經 lightningcss 解析為 0 warning。

**使用說明：**

- 陰影與 Gantt token 用 v4 的變數簡寫，例如 `shadow-(--shadow-popover)`、`bg-(--gantt-bar-fill)`。
- 圓角直接用 `rounded-sm|md|lg|xl`，數值與 token 相同。
- 間距用 Tailwind 預設的 4px 階（例如 `p-2` = 8px）；`--space-*` 給非 Tailwind 的計算使用，例如 Gantt 座標。

**sonner（2.0.8）樣式：** 在 `[data-sonner-toaster]` 上把 `--normal-bg: var(--bg-elevated)`、`--normal-border: var(--border-default)`、`--normal-text: var(--fg-primary)` 指向 token。不要使用 `richColors`，它會整片填色；語意色只用在 icon 上。

**主題啟動：** 依 `docs/architecture.md`，由 `index.html` 的 inline script 在首次繪製前加上 `.dark`。當 `theme = system` 時要監聽 `matchMedia('(prefers-color-scheme: dark)')` 的變化，讀取 `localStorage` 的地方都要包 `try/catch`。`color-scheme` 已由 token 處理，原生捲軸與表單控制項會跟著主題切換。

### 4.5 字體與中文（CJK）

- **字型堆疊：** `"Inter Variable"` 放第一位，負責拉丁字與數字。依 S11 確認，`@fontsource-variable/inter` 5.3.0 的 family 名稱是 `'Inter Variable'`（weight 100–900、`font-display: swap`），在 `main.tsx` import 一次即可。中文交給系統字：Mac 用 `PingFang TC`，Windows 用 `Microsoft JhengHei UI`／`Microsoft JhengHei`。`Noto Sans TC` 只在使用者已安裝時才會用到；若想讓 Windows 的呈現一致，可選擇自帶 `@fontsource-variable/noto-sans-tc`（5.3.1，以 unicode-range 分片載入）。預設不自帶，因為檔案大。
- **只用 400／500／600 三個字重。** S12 實測（Chromium 156、macOS、`PingFang TC`、32px，以 400 的墨量為 1.00）：

  | 字重 | 400 | 450 | 500 | 501–599（含 510、590） | 600–700 |
  |---|---|---|---|---|---|
  | 相對墨量 | 1.00 | 1.00 | 1.22 | **1.33** | 1.35 |

  結論：501 到 599 之間的任何字重（Linear 用的 510、590）都會讓中文落到同一個較粗的字面，墨量比 500 多約 10%（+9.6%），只比 600 少約 1.3%。所以 Linear 的「medium 510」在中文上看起來幾乎就是粗體。方向與 CSS Fonts 的字重比對規則一致（要求大於 500 時，優先往較重的字面找）；至於 501–599 與 600 之間那點小差異的成因，沒有進一步驗證。
  - 400：內文、列表標題。
  - 500：側邊欄、按鈕、tab、欄位標籤、chip。
  - 600：頁面標題、Modal 標題、群組名稱、搜尋命中字。
- **字距：** 中文內文一律 `letter-spacing: 0`，因為負字距會擠壓方塊字。只有 20／24px 的標題可以用 `--letter-spacing-title`（−0.01em）。
- **最小字級 11px**，只用於 Gantt 下層表頭、kbd 與計數；中文句子至少 12px。
- **語系：** `<html lang>` 應設為 `zh-Hant`（目前 `index.html` 是 `en`，由負責該檔的工作調整），讓瀏覽器選用正確的繁中字形。注意 UI 文案是英文並不影響這個設定；若決定 `lang="en"`，就要在輸入框與內容區塊上加 `lang="zh-Hant"`。
- **數字：** 日期、計數、百分比、Gantt 表頭、時間欄一律用 `font-variant-numeric: tabular-nums`（Tailwind 的 `tabular-nums`），讓欄位對齊。
- **未驗證：** 本機沒有安裝 `Noto Sans TC` 與 `Microsoft JhengHei`（量到的字寬與不存在的字型相同），所以 Windows 上 13px 正黑體的清晰度尚未驗證。若在 Windows 上過小或過細，只要把 `--font-size-ui` 調成 14px 即可全域放大。

### 4.6 Token 使用對照

| 用途 | Token |
|---|---|
| 視窗底、側邊欄 | `--bg-app`／`--bg-sidebar` |
| 主內容面板 | `--bg-main`＋1px `--border-subtle`＋`--shadow-panel`＋`--radius-xl` |
| 看板欄底、表頭、群組列、kbd 底 | `--bg-muted` |
| 卡片、輸入框 | `--bg-surface`＋`--border-default`（輸入框用 `--border-input`） |
| Popover、menu、modal、command、toast | `--bg-elevated`＋`--border-default`＋對應陰影 |
| 滑鼠 hover | `--bg-hover`（以疊加方式，可放在任何層上） |
| 目前頁、作用中 tab、按下 | `--bg-active` |
| 清單或 Gantt 的選取、拖曳放置區 | `--bg-selected`，另加 2px accent 指示，不只靠顏色 |
| 標題與內文／次要文字與非作用中導覽／meta、日期、計數 | `--fg-primary`／`--fg-secondary`／`--fg-tertiary` |
| 主按鈕 | `--accent`（hover：`--accent-hover`、按下：`--accent-active`）＋`--accent-fg` |
| 連結、accent 色 icon | `--accent-text` |
| 進度條 | 軌道 `--bg-active`、填充 `--accent`、高 4px、`--radius-full` |
| 破壞性按鈕 | `--danger`＋`--danger-fg`；較輕的版本用 `--danger-subtle`＋`--danger` 文字 |
| Tooltip | `--bg-inverse`＋`--fg-inverse`、12px、`--radius-md` |

---

## 5. 元件指引

### 5.1 App shell 與側邊欄

**骨架**

- 兩欄：`[側邊欄 240px | 主面板]`。側邊欄直接放在 `--bg-app` 上。
- 主面板與視窗上、右、下緣各留 `--shell-gap`（8px），使用 `--radius-xl`、`--bg-main`、1px `--border-subtle`、`--shadow-panel`。主面板內部自行捲動，側邊欄固定不動。

**收合狀態**

- 寬 52px，只剩 icon 列：每個 icon 按鈕 36×28 置中。
- Tooltip 顯示在右側，延遲 300ms，內容為名稱＋快捷鍵。
- 寬度變化使用 `--duration-slow`、`--ease-move`；reduced-motion 時直接切換。
- 收合偏好存在本機快取，並同步到 `user_preferences.sidebar_collapsed`。快捷鍵為 `[`。

**內容（由上到下）**

1. Workspace 列：Cairn 標誌、名稱、收合按鈕。
2. 主導覽：Overview、My Tasks、Projects、Timeline。
3. 留白 16px，不畫分隔線。
4. 分組標題「Recent」：12px／500／`--fg-tertiary`，高 24px。
5. 最近專案，最多 5 個。
6. 彈性空白。
7. 底部：同步狀態、Settings。

**項目樣式**

| 部位 | 規格 |
|---|---|
| 項目 | 高 28px、`--radius-md`、padding 0 8px、icon 與文字間距 8px |
| icon | 16px；非作用中 `--fg-tertiary`，作用中 `--fg-primary` |
| 文字 | 13px／500；非作用中 `--fg-secondary`，作用中 `--fg-primary` |
| 作用中底色 | `--bg-active` |
| hover | `--bg-hover`，立刻出現、120ms 淡出 |
| 計數（例如逾期數） | 靠右、12px tabular、`--fg-tertiary`；逾期數可用 `--danger` 文字，不要用紅色實心徽章 |

**同步狀態**（呼應 `docs/decisions.md`）

- 一列 28px：6px 圓點加 12px 文字。狀態有 Synced（`--success` 點）、Saving…、Offline（`--warning`）、Couldn't save（`--danger` 點與文字）。
- 點擊開啟 popover，內含 Retry。

### 5.2 Top bar（Location bar）

- 位於主面板頂端：高 44px、padding 0 12px 0 16px，底部 1px `--border-subtle`（header 區唯一的線）。
- **左側麵包屑**，例如 `Projects / Research`：
  - 上層 13px `--fg-tertiary`，可點擊，hover 時變 `--fg-primary`。
  - 目前頁 13px／500 `--fg-primary`。
  - 分隔符 `/` 用 `--fg-disabled`。
- **右側**依序為：
  - Search 按鈕：ghost、28px，內含 icon、文字「Search」與 kbd `⌘K`。
  - Theme 選單：28px icon 按鈕，選項 Light／Dark／System。
  - 選用：較窄的同步圓點。
- 不放大型品牌區塊或彩色背景。

### 5.3 Page header 與 View tabs（View bar）

**專案標題區**（不 sticky，padding 20px 24px 12px）

- 左側：
  - 專案名稱 20px／600，可直接編輯。
  - 狀態 chip：24px pill、12px／500。Active 用 `--bg-active` 加 `--fg-secondary`；Completed 用 `--success-subtle` 加 `--success`；Archived 用 `--fg-tertiary`。
  - 精簡進度：64×4px 進度條加「65%」（12px tabular `--fg-secondary`）。沒有任務時顯示「No tasks」（`--fg-tertiary`），不畫進度條。
- 右側：`⋯` 選單，以及主按鈕「New task」（`--h-btn-md`、`--accent`）。

**View bar**（40px，sticky 在面板內，底色 `--bg-main`）

- **左側 tabs** `List / Board / Gantt`：
  - 每個 tab 高 28px、padding 0 10px、`--radius-md`；icon 14px 加 13px／500 文字。
  - 作用中：`--bg-active` 加 `--fg-primary`。非作用中：`--fg-secondary`，hover 時 `--bg-hover`。
  - 不用底線，用 pill；以 Radix Tabs 實作（方向鍵切換），快捷鍵 `1／2／3`。
- **右側放該視圖專屬的控制項**：
  - List：Group、Filter。
  - Board：Filter。
  - Gantt：`Day / Week / Month` 分段控制（同樣是 pill 樣式）、`Today`（快捷鍵 `T`）、`Dependencies: Manual / Auto`、`Unscheduled (n)`。
- 已套用的篩選以可移除的 chip（24px）顯示在 view bar 下方，並附「Clear」。
- 最後使用的視圖寫在 URL（`/projects/:id/list|board|gantt`）與本機偏好中。

### 5.4 Dense list rows（List、My Tasks）

**列的結構**

- 列高 36px，padding-inline 12px；子任務每層多縮 20px（V1 只有一層）。
- 欄位：`[拖曳把手 16][狀態 16][標題 1fr][階段 chip auto][優先度 16][日期 120px tabular][⋯ 24]`。拖曳把手與 `⋯` 只在 hover 或 focus 時顯示。

**欄位內容**

- 標題：13px／400 `--fg-primary`，單行省略。
  - 有子任務的列：左側加 16px 展開箭頭，標題後加「2/5」（12px `--fg-tertiary`）。
- 日期：12px tabular `--fg-tertiary`，格式如 `Nov 2 → Nov 8`。
  - 逾期：`--danger` 文字，並加 `Overdue` tooltip 或小 icon，不單靠顏色。
  - 今天到期：`--warning` 文字加「Today」。

**分隔與群組**

- 列之間不畫分隔線，靠 hover 底色區分；列為滿版、無圓角，讓各欄對齊。
- 階段群組列 32px，sticky 在 view bar 下方：
  - 底色 `--bg-muted`；內容為展開箭頭、名稱（12px／600 `--fg-secondary`）、數量（`--fg-tertiary`）。
  - hover 時出現「＋」，用來在該階段新增任務。

**互動狀態**

- 鍵盤或選取中的列：`--bg-selected` 加左側 2px accent 指示（`box-shadow: inset 2px 0 0 var(--accent)`）。

**拖曳排序**（dnd-kit）

- 被拖的列浮起：`--bg-elevated` 加 `--shadow-drag`。
- 放置位置以 2px `--accent` 細線表示。
- 放下後寫入 `sort_order`；寫入失敗就回滾並跳出 toast。
- 非拖曳替代：鍵盤感應器（dnd-kit KeyboardSensor），以及 `⋯` 選單內的「Move to top／bottom」。

**直接編輯**

- 點標題就地編輯：同字級、不改變版面，使用 `--border-input` 與 focus ring。
- 狀態、優先度、日期以 Radix Popover 或 DropdownMenu 編輯。選單項高 32px（`--h-row-group`）、`--radius-md`，內容為 icon、文字與右側快捷鍵提示。

### 5.5 Board cards

**欄**

- 固定三欄 To Do → In Progress → Done，每欄 `minmax(280px, 1fr)`，欄距 12px，外距 16px 24px。
- 欄容器：`--bg-muted`、`--radius-lg`、padding 8px。
- 欄標頭 36px：狀態 glyph、名稱（13px／600）、數量（12px `--fg-tertiary`），以及 24px 的「＋」按鈕。

**卡片**

| 部位 | 規格 |
|---|---|
| 外觀 | `--bg-surface`、1px `--border-default`、`--radius-lg`、padding 10px 12px、行距 6px |
| 標題 | 13px／500 `--fg-primary`，最多 2 行 |
| meta 列 | 優先度 glyph、到期日（12px tabular，逾期用 `--danger`）、子任務進度「2/5」、階段名稱（`--fg-tertiary`） |
| 不放 | 頭像（單人使用） |

**互動狀態**

- hover：邊框改為 `--border-strong`。
- focus：顯示 focus ring。
- 拖曳中：DragOverlay 加 `--shadow-drag` 與 `scale(1.02)`，**不旋轉**。
- 原位置：1px 虛線 `--accent`（50%）加 `--bg-selected`。
- 目標欄：底色疊 `--bg-hover`。

**資料規則**

- 同欄內排序絕不改狀態或日期；跨欄只改狀態（PRD §4.6）。
- 非拖曳替代：卡片上的狀態選單。

### 5.6 Gantt（最高優先）

**版面**

- 左側為 sticky 任務欄，寬 `--gantt-pane-width`（300px，可拖曳 220–480px），與時間軸之間以 1px `--border-default` 分隔（少數保留的功能性線條）。
- 左欄每列：`[展開箭頭 16][狀態 glyph 16][標題 1fr][日期 72px tabular，可選]`。
- 右側時間軸可水平捲動並虛擬化；表頭 48px，sticky 在上方。

**表頭兩層**（每層 `--gantt-header-tier-height` 24px）

| Zoom | 每日寬 | 上層（12px／500 `--fg-secondary`） | 下層（11px tabular `--fg-tertiary`） | 格線 | 週末遮罩 |
|---|---|---|---|---|---|
| Day | 32px | `Nov 2026` | `2` 與窄週名 `M` | 每日一條 `--gantt-grid` | 顯示 |
| Week | 14px | `Nov 2026` | 週起始日 `Nov 2` | 每週一條 `--gantt-grid-strong` | 顯示 |
| Month | 4px | `2026` | `Nov` | 每月一條 `--gantt-grid-strong` | 隱藏 |

週起始日依 `user_preferences.week_starts_on` 決定。

**列與長條**

- 列高 32px，長條 20px 置中，`--radius-sm`。
- 長條內容：狀態 glyph（12px）加標題（12px／500 `--gantt-bar-text`）。長條寬度不足「文字＋24px」時，標題改放在長條右側，使用 `--fg-secondary`。
- 依狀態上色：

  | 狀態 | 填色 | 邊框 | 其他 |
  |---|---|---|---|
  | To Do | `--gantt-bar-fill` | `--gantt-bar-border` | |
  | In Progress | `--gantt-bar-fill-active` | `--gantt-bar-border` | |
  | Done | `--gantt-bar-fill-done` | `--gantt-bar-border-done` | 文字 `--gantt-bar-text-done`，加勾選 glyph |

- 逾期（未完成且 due < 今天）：長條右端加 2px `--danger` 端蓋，左欄日期用 `--danger`。
- 選取：focus ring，外推 1px。

**拖曳**

- 拖曳長條中段平移日期，兩端各 8px 熱區（`ew-resize`）調整起訖；hover 時端點顯示 2×10px 的握把。
- 一律對齊到「日」。工期最少 1 天，end ≥ start。
- 拖曳中顯示 tooltip，例如 `Nov 3 → Nov 7 · 5 days`，原位置留下 `--gantt-drag-ghost` 虛線框。
- 放開後寫入雲端；失敗就回滾並跳出 toast。

**里程碑**

- 菱形，外接 12px（`--gantt-milestone-size`），中心對齊日期欄中心；名稱放在右側，12px `--fg-secondary`。
- 未來的里程碑：實心 `--gantt-milestone`。已過日期：空心 `--gantt-milestone-past`。最近一個未到期的里程碑外加 2px accent 環（借用 Linear「目前焦點」的概念，但改用 accent，不用黃色）。
- 左欄以菱形 icon 加名稱與日期列出。

**階段與父任務**

- 彙總條高 6px（`--gantt-summary`），兩端有向下 2px 的括號腳，範圍為子項的最早開始到最晚結束。V1 不可拖曳，以免連帶改動子任務。

**缺日期的任務**（PRD：不得推測工期）

- 只有 due：在 due 日畫 due marker（`--gantt-due-marker` 的旗形或倒三角），左側接 8px 淡出虛線，tooltip 顯示「No start date」。排程邏輯把這類任務的 due 同時當作開始與結束，所以依賴線要能連到 due marker 上。
- 兩個日期都沒有：左欄顯示 `Unscheduled` chip，時間軸該列空白，hover 時提示「Drag onto the timeline or set dates」。另在左欄底部提供可收合的 `Unscheduled (n)` 群組。
- 把任務拖到時間軸上，會設定為該日的 1 天區間。這是使用者明確的操作，不是系統推測。

**依賴**（V1 只有 Finish-to-Start）

- **建立**：hover 長條時，右端外側 6px 處出現 8px 圓點（`--gantt-connector-size`，1.5px `--accent-text` 外框、`--bg-main` 底）。拖曳時以虛線 accent 跟隨游標，可連的目標長條外框變為 2px accent。
- **不可連的目標**（自己、重複、跨專案、會形成循環）：顯示 `not-allowed` 游標與原因 tooltip，例如 `Would create a cycle`。
- **鍵盤替代**：Task Modal 的「Blocked by」與「Blocking」欄位（combobox）。
- **線條**：從前置任務右端中心出發，正交折線、4px 圓角、1.5px，終點有 6px 箭頭進入後續任務左端。

  | 狀態 | 樣式 |
  |---|---|
  | 正常 | `--gantt-dependency` 實線 |
  | hover 或選取 | `--gantt-dependency-active`、2px，點擊可刪除或跳轉 |
  | 衝突 | `--gantt-conflict`，虛線 `4 3`，繞成 S 形回到後續任務；後續長條左端加 2px `--danger` 與 ⚠ 標記，tooltip 例如 `Starts 3 days before "Write report" ends` |

**衝突處理**（PRD §4.7）

- **Manual**（預設）：Gantt 上方出現橫幅（`--warning-subtle` 底、13px），例如 `2 dependency conflicts`，附 `Review` 與 `Preview auto-schedule…` 兩個按鈕。只提示，不改任何日期。
- **Auto**：拖曳造成衝突時開啟預覽對話框：
  - 表格列出受影響任務的「原日期 → 新日期」。
  - 時間軸上以 `--gantt-drag-ghost` 虛線框顯示新位置（借用 Asana baseline 的雙層表現）。
  - 按鈕有三個：`Apply all`、`Only move this task`、`Cancel`（還原這次拖曳）。按下 `Apply all` 才原子寫入。

**今日與捲動**

- 今日線為 1.5px 的 `--gantt-today`，貫穿整個時間軸；表頭上有 pill（`--gantt-today-label-bg`／`-fg`、11px），例如 `Nov 2`。
- 開啟 Gantt 或按 `Today` 時，捲動讓今天位於可視寬度約 1/3 處。

**鍵盤與無障礙**

- 長條可 focus（`role="button"`），`aria-label` 例如 `Write report, Nov 2 to Nov 8, In progress`。
- `←/→` 移動 1 天，`Shift+←/→` 調整結束日，`Enter` 開啟 Task Modal。
- 每次變更以 `aria-live="polite"` 播報。

### 5.7 Cross-project Timeline

- 每個專案一列，高 36px，畫 8px 高的彙總條（`--gantt-summary`），範圍為最早開始到最晚結束；里程碑菱形畫在專案列上。
- 預設全部收合，展開後才 lazy 顯示任務，避免畫面爆炸。
- 其餘的表頭、今日線、週末遮罩、zoom 都與專案 Gantt 共用。
- 專案之間的重疊靠垂直對齊呈現，不另外著色。

### 5.8 Modal（Task Modal 與確認對話框）

**Task Modal**（Radix Dialog，中央 Modal，非抽屜）

- 尺寸與位置：寬 640px（最大 92vw）、最高 84vh。距頂 12vh，不垂直置中：內容高度變動時（例如新增子任務）Modal 不會跳動。
- 外觀：`--bg-elevated`、1px `--border-default`、`--radius-xl`、`--shadow-modal`；遮罩為 `--bg-overlay`，不使用 blur。
- 由上到下：
  1. Header 44px：麵包屑 chip，例如 `Research › Phase 1`，可點擊改所屬專案或階段；右側 `⋯`（Delete、Duplicate）與關閉鈕。
  2. 名稱：20px／600，無框輸入，placeholder `Task name`，自動 focus。必填，錯誤時在下方顯示 12px `--danger` 訊息，並設 `aria-invalid`。
  3. 描述：14px／22px，無框、自動長高，placeholder `Add description…`。
  4. 屬性 chips 一列：Status、Priority、Start date、Due date、Phase、Parent。每個 28px 高、`--radius-md`、1px `--border-default`；沒有值時以 `--fg-tertiary` 顯示欄位名。日期選擇器禁用不合法的日子（end < start），並以文字說明原因。
  5. 需要時才顯示的區塊：Subtasks（32px 迷你列）、Dependencies（Blocked by／Blocking）。區塊標題 12px／600 `--fg-tertiary`，區塊間距 16px。
  6. Footer 52px，上方 1px `--border-subtle`：
     - 左側為儲存狀態（12px）：`Saving…`、`Saved`、`Couldn't save · Retry`。
     - 右側為 `Cancel`（次要按鈕）與 `Save`（主按鈕，提示 `⌘↵`）；新增時主按鈕改為 `Create task`。
- **Esc**：沒有改動就直接關閉；有改動就跳確認 `Discard changes?`，選項為 `Discard` 或 `Keep editing`。Linear 是問要不要存草稿；Cairn 沒有草稿功能，所以改成問要不要捨棄。
- **焦點**：focus trap 由 Radix 處理；關閉後焦點回到觸發元素。
- **動畫**：遮罩淡入 `--duration-base`。面板 opacity 0→1、`scale(.98)`→1、`translateY(4px)`→0，時長 `--duration-slow`、`--ease-enter`；退場 `--duration-fast`、`--ease-exit`。

**確認對話框**（`confirm()`，Radix AlertDialog）

- 寬 420px；標題 16px／600；內文 14px `--fg-secondary`，必須寫出影響範圍，例如 `Deletes 12 tasks and 3 dependencies. This can't be undone.`
- 按鈕：`Cancel` 加破壞性主按鈕（`--danger`／`--danger-fg`）。破壞性操作的初始焦點放在 `Cancel`。

### 5.9 Command／Search overlay（cmdk 1.1.1）

- `⌘/Ctrl+K` 或 top bar 的 Search 按鈕開啟。寬 640px、距頂 15vh；外觀為 `--bg-elevated`、`--border-default`、`--radius-xl`、`--shadow-modal`；遮罩為 `--bg-overlay`。
- 輸入列 48px：16px 搜尋 icon（`--fg-tertiary`）、16px 輸入字級、placeholder `Search projects and tasks…`。輸入列下方 1px `--border-subtle`。
- 結果分組為 `Projects`、`Tasks`：
  - 組標題 28px、12px／600 `--fg-tertiary`。
  - 每項 36px：glyph（專案 icon 或狀態 glyph）、標題（13px，命中字 600 `--fg-primary`，其餘 `--fg-secondary`）、右側 meta（所屬專案或到期日，12px `--fg-tertiary`）。
  - 目前項（cmdk `[data-selected=true]`）：`--bg-hover`，文字改為 `--fg-primary`。
- 空查詢時顯示 `Recent`；沒有結果時顯示 `No results for "…"`，加一行提示。
- Footer 32px：kbd 提示 `↑↓ Navigate · ↵ Open · Esc Close`。kbd 樣式為 11px mono、高 18px、`--radius-sm`、`--bg-muted`、`--border-default`。
- V1 只搜尋（符合 PRD），不加入命令執行。

### 5.10 Toasts 與儲存回饋（sonner）

- 位置：右下，距邊 16px；同時最多 3 則。
- 外觀：寬約 360px；`--bg-elevated`、`--border-default`、`--radius-lg`、`--shadow-popover`；padding 10px 12px；13px 文字；16px 語意色 icon。
- 時長：
  - 成功：4 秒。
  - 錯誤：8 秒（同 `notify.ts`），附 `Retry`。
  - 可復原的刪除：6 秒，附 `Undo`。
- 播報：一般訊息用 `aria-live="polite"`，錯誤用 `assertive`。
- **不得**在寫入成功前顯示「Saved」。樂觀更新失敗時，要回滾畫面並顯示錯誤（PRD §5.4、`docs/decisions.md`）。

### 5.11 空狀態、載入、錯誤

**空狀態**

- 版面：內容區置中，寬度最多 360px，距頂 12vh。
- 內容：24px 線性 icon（`--fg-tertiary`）、標題 16px／600、說明 13px `--fg-secondary`（最多 2 行）、一個主要動作，可再加一個文字連結。
- 不使用插畫、彩色圖片或大圖示。
- 文案範例：

  | 情境 | 標題 | 動作 |
  |---|---|---|
  | 第一次使用 | `No projects yet` | `Create your first project` |
  | 空專案 | `No tasks yet` | `New task` |
  | 篩選後沒有結果 | `No tasks match these filters` | `Clear filters` |
  | Gantt 沒有已排程任務 | 保留格線，中央浮出 `Set dates or drag tasks from Unscheduled` | |

- 專案進度在沒有任務時顯示 `No tasks`，不顯示 100%（PRD §5.2）。

**載入**

- 用 skeleton 列（36px，內有 `--bg-active` 色塊、`--radius-sm`），可加 1.2s 的淡入淡出呼吸效果，reduced-motion 時關閉。
- 不使用整頁 spinner；按鈕內可用 14px spinner。

**錯誤**

- 行內橫幅：`--danger-subtle` 底、`--danger` 文字、13px，附 `Retry`。不可 silent failure。

**Overview 指標**

- 三個指標以「數字 20px／600 tabular ＋ 標籤 12px `--fg-tertiary`」排成一列，可放在中性小卡（`--bg-surface`、`--border-default`、`--radius-lg`、padding 12px 16px）中。
- 不使用彩色大 KPI 卡（PRD §7.3）。

### 5.12 狀態、優先度與里程碑 glyph（原創）

Cairn 的狀態 glyph 以**圓角方形**為基礎，與 Linear 的圓形系統區隔。優先度 glyph 取自產品名「cairn（登山路標石堆）」：用堆疊的石塊數量表示等級，與 Linear 的直立長條區隔。全部採 `viewBox="0 0 16 16"`、顏色用 `currentColor`、尺寸 14 或 16px。

```html
<!-- Status · To Do：空心圓角方形（color: var(--status-todo)） -->
<svg viewBox="0 0 16 16" fill="none"><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="3" stroke="currentColor" stroke-width="1.5"/></svg>

<!-- Status · In Progress：外框＋下半部「水位」（color: var(--status-in-progress)） -->
<svg viewBox="0 0 16 16" fill="none"><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="3" stroke="currentColor" stroke-width="1.5"/><rect x="5" y="8" width="6" height="3" rx="1" fill="currentColor"/></svg>

<!-- Status · Done：實心方形＋挖空勾（color: var(--status-done)；勾用 --fg-inverse） -->
<svg viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="3.5" fill="currentColor"/><path d="M5.25 8.25 7.1 10.1 10.75 6.25" stroke="var(--fg-inverse)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>

<!-- Priority · Cairn stones：未達等級的石塊 opacity .28
     Low = 只有底石實心；Medium = 底＋中；High = 三塊全實心；Urgent = 三塊＋頂端 capstone 圓點
     None = 三塊皆 .28（或在列表中顯示 "—"） -->
<svg viewBox="0 0 16 16" fill="currentColor">
  <rect x="2"   y="11.5" width="12" height="2.5" rx="1.25"/>               <!-- 底石 -->
  <rect x="3.5" y="8"    width="9"  height="2.5" rx="1.25" opacity=".28"/> <!-- 中石 -->
  <rect x="5"   y="4.5"  width="6"  height="2.5" rx="1.25" opacity=".28"/> <!-- 頂石 -->
  <!-- Urgent 加上：<circle cx="8" cy="2.25" r="1.25"/> -->
</svg>

<!-- Milestone：菱形（未來：fill；已過：fill="none" stroke-width 1.5） -->
<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" transform="rotate(45 8 8)" fill="currentColor"/></svg>

<!-- Phase（彙總括號） -->
<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.75 5.5v5M13.25 5.5v5M2.75 8h10.5"/></svg>
```

- 優先度的顏色：Low 與 Medium 用中性 token，High 與 Urgent 才上色。等級靠「實心石塊數」與 Urgent 的 capstone 編碼，即使是灰階也分得出來。
- 選單與 tooltip 都要附文字，例如 `Priority: High`、`Status: In Progress`。glyph 本身也加 `aria-label`，或與可見文字一起出現。
- App Logo 另外設計，例如錯位堆疊的不規則石塊，避免與優先度 glyph 混淆，也不要與任何既有品牌相似。

### 5.13 鍵盤與焦點

**focus 樣式**

- 只用 `:focus-visible`：2px `--focus-ring`、offset 2px，對比 ≥ 4.23:1。
- 在會裁切溢出的捲動容器內（列表列、看板卡、Gantt 長條），改用內縮的 `outline-offset: -2px`。
- Radix 選單的 `[data-highlighted]` 用 `--bg-hover`；已勾選的項目以勾 icon 表示。

**層級與導覽**

- Esc 只關閉最上層：popover 先於 Modal。
- 提供 `Skip to content` 跳轉連結。
- Modal 有 focus trap，關閉後焦點回到原處。

**快捷鍵**（與 `docs/architecture.md` 一致）

- `⌘/Ctrl+K` 搜尋、`C` 新任務、`[` 收合側邊欄、`G` 再按 `O/M/P/T` 導覽、`?` 快捷鍵說明。
- 專案內 `1/2/3` 切換視圖；Gantt 中 `T` 回到今天。
- 輸入中不觸發；tooltip 中以 kbd 顯示對應快捷鍵。

**WCAG 2.2**

- 互動目標至少 24×24px（SC 2.5.8），或符合間距例外。Gantt 長條高 20px，但列高 32px 提供了間距。
- 所有拖曳操作都要有單一指標或鍵盤的替代方式（SC 2.5.7）：
  - 改日期：日期欄位。
  - 改狀態：選單。
  - 改排序：鍵盤或選單。
  - 建依賴：Modal 欄位。

### 5.14 Icons（lucide-react 1.66.0）

- 尺寸：預設 16px、`strokeWidth={1.75}`；在密集的 meta 位置用 14px、`1.5`。顏色繼承 `currentColor`，非作用中用 `--fg-tertiary`，不加彩色底框。
- 建議對應（皆已確認存在於專案安裝的版本）：

  | 用途 | Icon |
  |---|---|
  | Overview | `LayoutDashboard` |
  | My Tasks | `ListTodo` |
  | Projects | `FolderKanban` |
  | Timeline／Gantt | `ChartGantt` |
  | Settings | `Settings` |
  | Search | `Search` |
  | 主題 | `Sun`／`Moon`／`Monitor` |
  | 側邊欄 | `PanelLeftClose`／`PanelLeftOpen` |
  | 依賴 | `Workflow` |
  | 拖曳 | `GripVertical` |
  | 更多 | `Ellipsis` |
  | 警示 | `TriangleAlert` |
  | 同步 | `Cloud`／`CloudOff`／`RefreshCw` |
  | 復原 | `Undo2` |

- 狀態、優先度、里程碑 glyph 用 §5.12 的自訂 SVG，不用 lucide 的圓形 icon 替代。

---

## 6. 不可做（Anti-patterns）

**PRD §7.3 的設計底線：**

1. 籠統的管理系統模板、巨大彩色 KPI 卡、過多陰影、飽和漸層。
2. 為了展示技術，在首頁加入不需要的 widget。
3. 每頁拼出不同的 UI 風格。全部使用同一套元件與 token，元件內禁止 raw hex。
4. 「漂亮但不能編輯資料」不算完成。所有按鈕都要接上真實資料流。

**由研究推導的禁忌：**

5. 不要用線條切割每個區塊或每一列；分隔線只留給功能性分界。
6. 不要讓側邊欄搶戲：彩色底、亮色 icon、彩色 icon 底框、粗字重都不要。非作用中的項目就該是淡的。
7. 不要沿用 Linear 的專屬元素：Logo、品牌與 UI 色票（`#5E6AD2`、`#08090a` 系列…）、圓形狀態 icon、直立長條優先度 icon、510／590 字重、文案與插圖。
8. 不要只靠顏色傳達狀態。逾期要有文字或 icon；衝突線同時是紅色與虛線，並加 ⚠；選取狀態加 2px 指示。
9. 不要讓 tertiary 或 meta 文字低於 4.5:1（Linear 行銷站最弱的文字只有 3.45:1）；暗色 accent 上不要放白字（2.79:1）。
10. 中文不要用負字距，不要用 501–599 的字重，不要用小於 11px 的字。
11. Gantt 長條不要每個任務隨機一個顏色，也不要飽和實色或漸層。顏色只由狀態語意決定。
12. 不要為缺少開始日的任務畫出推測工期的長條，也不要像 Asana Gantt 那樣替新任務自動排出連續日期。
13. 自動排程在使用者確認前不得寫入；不要 silent failure，也不要假的「Saved」。
14. 動畫不要超過 200ms，不要彈跳或過衝，拖曳時不要旋轉，不要大面積使用 `backdrop-filter: blur`。
15. Task Modal 不要做成右側抽屜或獨立頁（PRD §4.9）；除了確認對話框，不要 Modal 疊 Modal。
16. 不要只能靠拖曳完成的操作（SC 2.5.7）；不要讓關鍵資訊（逾期、衝突）只在 hover 時出現。
17. 跨專案 Timeline 不要預設展開所有任務。
18. 不要用整頁 spinner 或閃爍的 shimmer；用安靜的 skeleton。
19. 暗色主題不要用純黑 `#000` 背景，也不要用純白 `#FFF` 大段文字；淺色主題的層次靠邊框與陰影，不要靠一層層加深的灰底。

---

## 7. Asana 對個人 Gantt 的啟示

**採用：**

- **左清單、右時間軸，並與 List 同結構。** 左欄的階段分組與 List 視圖相同，切換視圖時心智模型一致。
- **用 handle 拖曳建立依賴。** hover 才出現 connector，拖到目標即建立（Asana 與 Linear 都這樣做）。Cairn 只有 FS，所以**不顯示**類型下拉選單。
- **依賴線用兩態回饋。** Asana 是「灰線正常、紅線衝突」；Cairn 再加上虛線與 ⚠，色盲也能分辨。衝突的定義：後續任務的開始日不晚於前置任務的結束日。日期含頭含尾，所以同一天也算重疊。只有單一日期的任務如何處理，以 `src/domain/scheduling.ts` 的 `findConflicts` 為準：同樣是「≤ 即衝突、需移到 finish＋1」。
- **Auto 模式等於 Asana 的 Consume buffer（slack shifting）。** 只把違反依賴的後續任務往後推到「前置結束日＋1」，保留工期，從不往前拉，沿依賴鏈傳遞。Manual 模式則類似 Asana 的 None，但仍持續顯示衝突。差別在於 Cairn 一定先預覽再確認，然後原子寫入，比 Asana 保守（PRD §4.7）。
- **未排程任務有集中區。** Asana 把它放在時間軸右側；Cairn 放在左欄底部的 `Unscheduled (n)` 群組，可以拖到時間軸上排程。只有 due 的任務畫 due marker，不畫長條。
- **里程碑是單日菱形**，與任務在同一時間軸上。Cairn 的資料模型把里程碑獨立成一張表，不計入進度（PRD §5.2）。
- **子任務只顯示第一層**，與 PRD 的 V1 限制一致。
- **Baseline 的「斜線或虛線＝另一版本」語言**，Cairn 用在自動排程的預覽框（ghost bar）。

**V1 不採用（列為之後再評估）：**

- 新任務自動排程：與 PRD 的「不推測工期」衝突。
- 依自訂欄位上色：V1 依狀態上色。
- Maintain buffer（lag shifting）、critical path、work schedules：V1 使用連續日曆日，週末只做視覺遮罩。
- 指派人與通知：單人使用，不需要。
- 多選批次拖移、Chain dependencies 批次串接：可列為之後的功能。
- Linear 用修飾鍵控制連帶推移（⌘ 保持、Shift 全部移動）：V1 由 Manual／Auto 模式與預覽對話框取代，不用修飾鍵。

---

## 8. 未驗證與待確認

- Linear App 內的淺色主題配色、清單列高度、⌘K 外觀，以及 2026 refresh 之後的建立 Modal：需要登入，或只有可能較舊的文件截圖（§1.1）。
- Windows 上 13px `Microsoft JhengHei` 的清晰度，以及 `Noto Sans TC` 的實際渲染：本機沒有安裝，未驗證（§4.5）。
- 對比數字以 sRGB hex 計算；半透明 token 疊在非指定的層上時，實際值會有小幅差異。實作完成後，建議用瀏覽器 DevTools 或 axe 抽查。
- Gantt 的幾何數值（每日寬、列高、表頭）是起點，需要用真實資料與 `docs/gantt-evaluation.md` 的實作結果驗證（PRD §11）。
- Tailwind 對接已經編譯驗證（§4.4）。sonner 的 `--normal-*` 變數只在 `sonner/dist/styles.css` 中確認存在，實際覆寫效果需要在 `<Toaster/>` 上目視確認。
