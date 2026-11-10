# Windows Alt+Tab 输入法候选框左上角问题：诊断实验

> 实验分支：`experiment/ime-native-focus-diagnostics`。不是已验证修复，不要直接并入发布主干。

## 已确定的事实

- 复现时中文最终仍能输入目标控件，异常主要集中在候选框 / 组合窗口位置。
- OpenShell 当前使用 Wails v3.1.0 和 WebView2，默认 HWND 托管。
- Wails 在 Windows `WM_ACTIVATE` 和 `WM_SETFOCUS` 路径中同步恢复 WebView2 焦点。
- WebView2 官方报告 [#5675](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5675) 描述了类似的现象：提交的文字正确，但 IME 组合窗口错误地显示在屏幕左上角。
- [#5799](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5799) 涉及同进程多窗口中的焦点恢复时机；OpenShell 是单主窗口，不能直接推定根因相同。

## 此分支修改了什么

1. 在 Windows WebView2 运行环境下，监听 Wails 窗口激活与焦点事件，以及 DOM focus / composition 事件。
2. 将输入目标类别、页面焦点状态、输入框或 contenteditable 选区矩形、窗口位置、DPR 写入现有本地诊断日志。
3. 提供环境变量 `OPENSHELL_IME_VISUAL_HOSTING=1`，**仅用于比较** WebView2 DirectComposition 托管模式。默认值保持原来的 HWND 模式。
4. 不调用 `blur()`、`focus()`、`MoveFocus()`，不更改输入法行为。

诊断日志**不记录**输入文本、选中内容、文件路径、服务器信息或按键。仅存储光标所处控件的几何坐标、粗分类和系统事件。DOM 矩形不等于 Windows TSF 的原生候选窗口矩形。

## 构建

在 Windows PowerShell 中：

```powershell
git fetch origin
git switch experiment/ime-native-focus-diagnostics
task build
```

输出通常为 `build/bin/OpenShell.exe`。若本机缺少 Wails、Node、Go 或 Task，请使用项目已有的 Windows 构建环境。

## 测试 A：默认 HWND 托管

确保没有仍在运行的 OpenShell 实例，然后在项目根目录运行：

```powershell
$env:OPENSHELL_IME_VISUAL_HOSTING = "0"
.\build\bin\OpenShell.exe
```

1. 进入 AI 输入框，点击输入框并切换到中文输入法。
2. 不移动鼠标，连续执行 Alt+Tab 切出、切回、输入中文 20 次。
3. 记录候选框是否跳到左上角，是否仍能正常输入汉字。
4. 对 SFTP 编辑器、普通设置输入框、xterm 终端重复操作。
5. 再单独检查移动窗口、缩放窗口、不同缩放比例的显示器。
6. 进入“设置 → 诊断”，导出 ZIP，保留 `logs/app.jsonl` 与 `summary.json`。

## 测试 B：实验性 Visual Hosting

彻底退出 OpenShell 后：

```powershell
$env:OPENSHELL_IME_VISUAL_HOSTING = "1"
.\build\bin\OpenShell.exe
```

按照测试 A 的相同步骤复测并导出第二份 ZIP。此模式只是对照实验，可能影响窗口拖拽、命中检测或其他非客户端区域交互；任何异常都应视为测试失败，而非推荐启用。

## 如何解读日志

在导出的 `logs/app.jsonl` 中查找 `"module":"ime"`。常见事件：

- `window_active`：Wails 收到原生窗口激活消息。
- `after_activation`：紧接窗口激活后的一个浏览器动画帧。
- `window_set_focus`：Windows 主窗口接收到焦点。
- `dom_focus`：DOM window 触发焦点事件；Alt+Tab 后不一定存在。
- `composition_start` / `composition_end`：页面收到组合输入事件。

`ime.rectX/rectY/rectWidth/rectHeight` 仅代表焦点 DOM 输入控件（或 contenteditable 选区）的 CSS 像素矩形；`screenX/screenY` 与 `dpr` 记录页面屏幕位置及缩放比例。xterm 的隐藏 textarea 矩形可能很小，不能仅凭其 0,0 坐标判定为故障。

### 验收表

| 输入位置 | 默认 HWND 20 轮异常次数 | Visual Hosting 20 轮异常次数 | 是否出现输入失效 | 是否出现窗口交互回归 |
| --- | ---: | ---: | --- | --- |
| AI 输入框 | 待实测 | 待实测 | 待实测 | 待实测 |
| SFTP 编辑器 | 待实测 | 待实测 | 待实测 | 待实测 |
| 设置输入框 | 待实测 | 待实测 | 待实测 | 待实测 |
| xterm | 待实测 | 待实测 | 待实测 | 待实测 |

## 后续判定

- **若页面输入框 rect 正确但候选框在 (0,0)：** 优先检查 WebView2/TSF 原生 caret 同步，继续验证原生焦点时机，不再叠加前端 blur/focus。
- **若仅默认 HWND 失败而 Visual Hosting 不失败：** 值得进一步研究 WebView2 托管路径；还必须确保输入、鼠标、拖拽和窗口调整无回归。
- **若两种模式都失败：** 暂不更换托管模式，收集具体 Windows 版本、WebView2 Runtime 版本以及同屏幕/跨屏幕测试数据。

这个分支只完成无侵入诊断和托管模式 A/B，**尚未修改 Wails 内部同步 MoveFocus 的执行时机，也没有 Windows 实机验收结果。**
