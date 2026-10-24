; ============================================================================
; minipi · NSIS 安装器自定义脚本
;
; 由 `electron-builder.yml` 的 `nsis.include` 引入（打包时用 `!include` 拼进安装器脚本）。
;
; 唯一职责：**让目录页里显示的安装目录永远是 `<用户选的目录>\minipi`**。
;
; 用户原话（2026-10）：『安装时选择了目录，比如 E:/，应该自动给一个 minipi 的目录，
; 比如 E:/minipi，选择任何目录都会增加 minipi 的文件夹。』
; 不给反馈的话，用户在目录页选 `E:\` 之后，盒子里的路径还是 `E:\`，
; 他没法确认文件到底铺在哪儿 —— 这种"猜安装位置"的体验在发布版里不能留。
;
; ---------------------------------------------------------------------------
; ⚠ 编码：本文件**必须存成 UTF-8 with BOM**。
;   electron-builder 调 makensis 时带 `-INPUTCHARSET UTF8`，但它对 `!include`
;   进来的文件只在**有 BOM** 时才按 UTF-8 解析；没有 BOM 而文件里又有中文，
;   会直接报 `Bad text encoding: installer.nsh:4` 让打包失败（本机实测）。
;   用编辑器另存时别把 BOM 去掉。
;
; ---------------------------------------------------------------------------
; ⚠⚠ 为什么不能无条件 `StrCpy $INSTDIR "$INSTDIR\minipi"`（别"简化"成那样）
;
; `.onVerifyInstDir` 是 MUI 目录页的回调，**用户在地址框里每敲一个字符都会触发一次**。
; 如果无条件追加，事件序列是：
;     敲 `E`   → $INSTDIR = "E"          → 追加 → "E\minipi"
;     敲 `:`   → $INSTDIR = "E\minipi:"   → 追加 → "E\minipi:\minipi"
;     …
; 也就是用户连打几个字符，输入框会变成 `E:\minipi\minipi\minipi\minipi…`，
; **输入框彻底不可用**（连退格都救不回来：删一个字符，下一次回调又补回去）。
;
; 所以只在下面这些"用户确实选定了某个卷"的形态里追加：
;   ① 盘符根：`E:` —— 长度 2、第二个字符是冒号。
;      （NSIS 的 $INSTDIR 是**特殊变量**：赋值/读取时会做规范化，
;        末尾的反斜杠会被吃掉 —— `E:\` 读出来就是 `E:`，见下面的实测记录。
;        所以"选了个盘符根"最终就落在这一条上，这也是用户报的那个场景。）
;   ② 以路径分隔符结尾：`E:\work\`、`E:/work/`。
;      规范化之后这条基本不会再命中，**保留它是给"别的代码路径塞进来的值"兜底**。
;   ③ 兜底：最后一段已经是 `minipi`（不区分大小写，`StrCmp` 默认忽略大小写）
;      → **不追加**。否则默认目录 `%LOCALAPPDATA%\Programs\minipi`
;      会变成 `…\minipi\minipi`。
;
; 另外用 `$MINIPI_LAST_DIR` 记住"我们自己刚写进去的值"，同一个值再进来直接返回 ——
; 万一将来有哪条路径让 ①/② 对同一个字符串反复成立，这层保险能挡住无限追加。
;
; ---------------------------------------------------------------------------
; 实测记录（2026-10，makensis 3.0.4.1）：$INSTDIR 的规范化行为
;   StrCpy $INSTDIR "E:\work\"  → 读出来 "E:\work"   （末尾反斜杠被吃掉）
;   StrCpy $INSTDIR "E:\"       → 读出来 "E:"        （同上）
;   StrCpy $INSTDIR "E:/work/"  → 读出来 "E:work"    （正斜杠会被**删掉**，不转换！）
;   → 结论：永远不要指望 $INSTDIR 末尾带分隔符；也**不要**把正斜杠路径写进 $INSTDIR
;     （会丢字符）。安装向导自己的浏览按钮给的是反斜杠路径，所以真实使用没问题。
;
; ---------------------------------------------------------------------------
; 与 electron-builder 自带逻辑的关系（**别删掉这段说明，否则后人会以为重复了**）：
;   `templates/nsis/assistedInstaller.nsh` 里有个 `instFilesPre`，在进入安装页之前做：
;       ${StrContains} $0 "minipi" $INSTDIR
;       ${If} $0 == "" → StrCpy $INSTDIR "$INSTDIR\minipi"
;   也就是"路径里**没出现过** minipi 子串就补一层"。它保证装到 <目录>\minipi，
;   但有两个缺陷，正是本脚本要补的：
;     · 它只看子串：`E:\minipi-backup` 会被判成"已经补过"而不补（子串误命中）；
;     · 它发生在用户点"下一步"之后，用户看不到最终路径。
;   本脚本在目录页就把路径改对（用户看得见），并且按"最后一段"判断而不是子串；
;   两边对同一个路径的判断一致（已经补过 → 本脚本不追加 → instFilesPre 里含 "minipi"
;   → 也不追加），所以**不会叠加成 \minipi\minipi**。
;
; 副作用备忘（可以接受）：用户**手打** `E:\work` 时，敲到 `E:` 的瞬间会被补成
; `E:\minipi`，接着敲的字落到后面变成 `E:\minipi\w`。手打长路径在安装器里很少见
; （默认值已经是对的、浏览按钮选目录也不会经过这个中间态），而"选盘符根"是高频操作，
; 所以取舍放在"选盘符根立刻补"这一侧。
; ============================================================================

; 上一次由本脚本追加出来的目录（防止同一路径被反复追加）。
Var /GLOBAL MINIPI_LAST_DIR

; ---------------------------------------------------------------------------
; `minipiAppendSubdir` 独立成函数（而不是全写在 .onVerifyInstDir 里），
; 这样可以用一个一次性的小 .nsi 直接 `Call` 它来验字符串逻辑，不必真去点安装向导。
; ---------------------------------------------------------------------------
Function minipiAppendSubdir
  ; (0) 同一个值不重复处理：这条能挡住"追加之后回调再次触发"的循环。
  StrCmp $INSTDIR $MINIPI_LAST_DIR 0 minipi_ai_check
  Return

  minipi_ai_check:
  StrLen $0 $INSTDIR
  StrCmp $0 0 minipi_ai_done          ; 用户把地址框清空了 → 什么都不做
  StrCpy $1 $INSTDIR 1 -1             ; $1 = 最后一个字符

  ; ---- ① 盘符根 "E:"（长度 2 且第二个字符是冒号）----
  StrCmp $0 2 0 minipi_ai_trailing
  StrCpy $1 $INSTDIR 1 1
  StrCmp $1 ":" minipi_ai_append
  Goto minipi_ai_done

  ; ---- ② 以分隔符结尾（规范化之后基本不会命中，留作兜底）----
  minipi_ai_trailing:
  StrCmp $1 "\" minipi_ai_append
  StrCmp $1 "/" minipi_ai_append
  Goto minipi_ai_done

  ; ---- 将要追加，但先看最后一段是不是已经叫 minipi ----
  minipi_ai_append:
  StrCpy $2 $INSTDIR                  ; $2 = 去掉结尾分隔符后的"目录本体"
  minipi_ai_strip:
  StrLen $3 $2
  StrCmp $3 0 minipi_ai_do_append     ; 剥光了（"/" 这种）→ 直接追加
  StrCpy $4 $2 1 -1
  StrCmp $4 "\" 0 minipi_ai_strip_slash
  StrCpy $2 $2 -1                     ; maxlen 为负 = 从尾部砍掉这么多字符
  Goto minipi_ai_strip
  minipi_ai_strip_slash:
  StrCmp $4 "/" 0 minipi_ai_have_base
  StrCpy $2 $2 -1
  Goto minipi_ai_strip

  minipi_ai_have_base:
  StrLen $3 $2
  StrCmp $3 6 minipi_ai_exact
  Goto minipi_ai_suffix
  minipi_ai_exact:
  StrCmp $2 "minipi" minipi_ai_done   ; 相对路径 "minipi" / "minipi\"：已经是了
  Goto minipi_ai_do_append

  minipi_ai_suffix:
  StrCpy $4 $2 6 -6                   ; 最后 6 个字符（负偏移 = 从末尾数）
  StrCmp $4 "minipi" 0 minipi_ai_do_append
  StrCpy $4 $2 1 -7                   ; 再往前一个字符：必须是分隔符，
  StrCmp $4 "\" minipi_ai_done        ; 否则 "E:\foominipi" 会被误判成"已经是 minipi"
  StrCmp $4 "/" minipi_ai_done
  Goto minipi_ai_do_append

  minipi_ai_do_append:
  StrCpy $4 $INSTDIR 1 -1
  StrCmp $4 "/" minipi_ai_append_fwd
  StrCpy $INSTDIR "$INSTDIR\minipi"
  Goto minipi_ai_append_end
  minipi_ai_append_fwd:               ; 用户写的是正斜杠就保持正斜杠，别混成 "E:/\minipi"
  StrCpy $INSTDIR "$INSTDIR minipi"
  minipi_ai_append_end:
  StrCpy $MINIPI_LAST_DIR $INSTDIR
  Return

  minipi_ai_done:
  Return
FunctionEnd

; MUI 目录页回调：每敲一个字符 / 每次浏览选目录都会进来（见文件头"别无条件追加"）。
Function .onVerifyInstDir
  Call minipiAppendSubdir
FunctionEnd
