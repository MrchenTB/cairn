# 歷史文件（Archive）

這裡的文件是**寫作當時的快照**，保留下來是為了追溯「為什麼會變成現在這樣」。內容不再更新，可能與目前的程式碼不同。

- 文中的「尚未 commit」「未驗證」「待你操作」等狀態，描述的是寫作當天，不是現在。
- 行號與分支名稱以當時為準；分支大多已合併並刪除，還原點 tag（`pre-ux-iteration-1` 等）仍在。
- 目前的規則以 [`../architecture.md`](../architecture.md) 為準，取捨理由見 [`../decisions.md`](../decisions.md)，已知問題見 [`../production-readiness.md`](../production-readiness.md) 第 8 節。

| 文件                                                                 | 日期       | 內容                                                                 |
| -------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- |
| [`platform-notes.md`](platform-notes.md)                             | 2026-11-02 | Supabase 與 Cloudflare 免費方案的查核（網站後來改用 Vercel）         |
| [`progress.md`](progress.md)                                         | 2026-11-06 | 1.0.0 的 PRD 驗收狀態，寫於真實雲端驗收之前                          |
| [`ux-audit.md`](ux-audit.md)                                         | 2026-11-06 | UI/UX 審查，後續三輪修改的問題清單（X-、G- 編號來自這裡）            |
| [`gantt-iteration-2.md`](gantt-iteration-2.md)                       | 2026-11-06 | 甘特圖第二輪優化報告                                                 |
| [`ui-ux-iteration-3.md`](ui-ux-iteration-3.md)                       | 2026-11-06 | UI/UX 第三輪精修報告                                                 |
| [`task-autosave-design.md`](task-autosave-design.md)                 | 2026-11-06 | Task Modal 自動儲存的設計評估（決策 D26–D32 的依據）                 |
| [`task-autosave-implementation.md`](task-autosave-implementation.md) | 2026-11-06 | 自動儲存的實作與驗收報告；互動規則現已寫入 `architecture.md` 第 6 節 |

## 截圖

| 資料夾                      | 狀態                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `ux-iteration-1-assets/`    | 在 Git 中。第一輪 UX 修改（甘特圖外觀）的前後對照，這一輪沒有獨立報告                       |
| `gantt-iteration-2-assets/` | 在 Git 中，對應 `gantt-iteration-2.md`                                                      |
| `ux-audit-assets/`          | 不在 Git（`.gitignore`），只留在當時的電腦，所以 `ux-audit.md` 的圖片連結在 GitHub 上會失效 |
| `ui-ux-iteration-3-assets/` | 同上，對應 `ui-ux-iteration-3.md`                                                           |
| `ui-ux-iteration-4-assets/` | 同上，第四輪沒有獨立報告                                                                    |

新的截圖不要放進 Git；需要時放在本機並寫明位置。
