# 本地 thesis 候選與假設追蹤

這是內部候選功能。它保存使用者或 caller AI 提出的 thesis、證據引用、假設變化與人工決定，不自行搜尋、評分金融結論或下單。
SQLite 是正本，私有論點不會傳到正式網站。公開黑客松 checkout 尚未帶入這個模組。

## 研究範圍

第一階段使用 `ai_compute` watch，`research_topic` 可為 `ai_compute` 或 `pcb_ccl`。
PCB／CCL 在這裡是研究子題，還不是新 dashboard theme 或已核定公司池。
每個候選保留選定範圍內的公司角色，至少有美國與亞洲角色。市場及公司角色是 caller 的明確標記，不代表程式核實交易所或供貨關係。

每個 claim 有固定 ID、型別、狀態、經濟階段、期間／單位／分母、支持或反證引用、所需證據、falsifier及不可推論事項。
不知道期間或分母時使用 null，不能用總營收自動填高階產品收入。
型別驗證不會判定「營收成長證明毛利改善」等推論是否正確，這仍需要研究評測。

來源引用使用 document_id、local_source_id、source_event_id 與 event／artifact hashes，另保留 locator 和 relation。
不同文件的S01不會因短ID相同而當成同一引用。Hash檢查證明內容一致，不證明來源真實或重分發權利。

## 給使用者 agent 的本地入口

先用既有 local init 建立 private workspace及watch。輸入JSON須為使用者所有、單一連結、0600權限的普通檔案。
完整人工候選格式可查`tests/fixtures/thesis-proposal.mjs`；那是合成測試範例，不能作真實研究證據。

```sh
node client/local-cli.mjs thesis-propose --workspace /absolute/private/workspace --input /absolute/private/proposal.json
node client/local-cli.mjs thesis-list --workspace /absolute/private/workspace --after 0 --limit 20
node client/local-cli.mjs thesis-status --workspace /absolute/private/workspace --thesis-id YOUR_THESIS_ID --after 0 --limit 20
```

List回傳next_after；status的proposal歷史用next_revision，review歷史用next_review_after。
Status可加`--review-after`和`--review-limit`。Page大小為1–100，不刪歷史。
回覆是私有JSON，請勿貼到公開log或投稿材料。

人工候選的origin.kind是human，run_id為null。Caller-agent候選須綁定已完成的非method-trial research run、同一scope、method及run內sources。
這能檢查引用範圍，但不認證作者，也不證明模型真的產生了候選。自動caller接入尚未完成。

## 採納不等於收到

Proposal只能新增候選。Review是獨立請求，須提供review_id、thesis_id、revision、proposal_sha256、expected_review_revision、action、note與human actor。

```sh
node client/local-cli.mjs thesis-review --workspace /absolute/private/workspace --input /absolute/private/review.json --confirm-human-review
```

這個flag宣告本地擁有者的人工決定，不是身分驗證。模型回覆不能夾帶flag或accepted欄位取得採納權限。
先accept_evidence，再對同一revision執行accept_interpretation。兩項動作各增加review_revision。
Received、revisit和reject不改基準；接受B的證據也不會自動把原先A的投資判斷換成B。
它們只操作thesis基準，不會默默改existing watch的delivery基準。

新採納需使用最新thesis／watch版本。完全沒有來源引用、內部衝突、未查反證、來源HOLD／UNKNOWN、schema變化、過期或被更正都會阻擋。
這不是逐claim完整證據覆蓋的驗收：其他claim已有來源時，部分claim可以保持unknown或沒有引用。
人工接受這種條件式基準不代表全部假設已證實；status仍標示structural_only。
更正須先通過既有source intake的lineage驗證，單純retain raw correction不能繞過。
這些gate不授予商用資料、模型支出、方法發布、付款或交易權限。

## 改變了什麼

後續revision須pin上一版hash，不能覆寫歷史，也不能刪舊claim ID；不再適用的claim要明示retired。
Status回傳逐claim差異及前後狀態。Delta檢查結構，不判斷經濟重要性，回覆保留significance_verified:false。
重複提交同一版不重複通知，只有改標題的版本不新增研究通知。
不同thesis之間的語意重複、新穎性和重要性校準仍未實作，不能把此處的去重當成完整curation。

本地workspace的Inbox現在包含研究結果與thesis，可按類型、公司、theme及watch篩選。
選取候選可讀claim、經濟階段、缺口、反證、來源與版本差異，再選Received、Accept evidence、Adopt thesis、Revisit或Reject。
採納動作分開，開啟、篩選及重新整理都不會採納。來源超過20筆時，先載入剩餘來源metadata才能送採納請求。
理由使用單行可列印文字。程式先處理前後空白，再固定請求；回覆不明時保留同一ID及版本，只能明確重試原請求。
重新整理遇到gate會保留原本選的動作和理由，停用送出，不自動改成Received。

保護的HTTP介面包括`GET /api/theses`、`GET /api/theses/<proposal_sha256>`、`GET /api/thesis-sources`、`GET /api/thesis-reviews`及`POST /api/thesis-reviews`。
來源及review歷史以proposal_sha256和sequence cursor分頁，不把可變thesis標題當路由ID。
Bearer、loopback、Origin與write header限制維持不變。這是本地擁有者的宣告，不是身分認證。
HTTP與非渲染DOM已驗證；視覺、實體鍵盤／裝置、caller AI完整操作仍未驗收。

## 儲存與恢復

Ledger升到schema9。升級前先保存0600 backup，watch、來源、delivery和既有採納紀錄不变。
Thesis寫入使用SQLite transaction、review compare-and-swap與manifest；回覆遺失後可重送同一request ID。
每次操作核對實際source bytes、method內容和retained snapshot，不只相信資料庫中的hash標籤。
Manifest保護sequence、timestamp和採納指標，刪掉候選或改metadata會失敗。
本地hash不能防止有完整寫入權的人同步偽造所有內容及hash，也不能取代來源／作者認證。

## 尚未完成

這一段沒有自動搜尋新thesis，沒有接真實模型，也沒有完成高階CCL的語意評測或商用權利審核。
後續還要接curated方法、允許來源、caller AI、實際介面操作、方法改善與乾淨安裝驗收。
工程測試不支持金融準確性、產品9/10或公開版可提交的更廣宣稱。

- [ ] 接入主題方法及caller回程，補實際操作與研究評測。
- [ ] 完成公開版、production與安裝驗收。
- [ ] Run quality control checkpoint
