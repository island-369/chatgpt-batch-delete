# Clear Chats

在 ChatGPT、Claude、Grok、Gemini、Kimi、Qwen、DeepSeek、智谱清言、腾讯元宝和豆包中搜索、筛选并批量删除聊天。删除任务可在面板收起后继续运行。

ChatGPT 还支持 AI 标题建议和资料库辅助管理。资料库面板可搜索、筛选和批量下载；批量删除使用 ChatGPT 自带功能。

## 截图

| 会话管理 | 删除确认 |
| --- | --- |
| ![浅色界面的会话列表](docs/screenshot-list.png) | ![删除范围确认](docs/screenshot-confirm.png) |

| 后台进度 | 资料库辅助管理 |
| --- | --- |
| ![收起面板后的删除进度](docs/screenshot-background.png) | ![资料库搜索和批量下载](docs/screenshot-library.png) |

截图使用本地模拟数据，不含真实会话或文件。

## 安装

适用于 Chrome 和 Edge：

1. 打开 `chrome://extensions/`（Edge：`edge://extensions/`），启用「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本项目文件夹。
3. 打开或刷新支持的 AI 网站，点击右下角出现的悬浮按钮。

## 使用

- 搜索标题，按更新时间筛选（24 小时、7 天、30 天、90 天或 1 年），勾选会话后点击「删除所选」。
- 删除前会显示确认范围。开始后可收起面板，悬浮按钮旁会显示进度；关闭或刷新网页会中断任务。
- 在 ChatGPT 可对选中的会话生成标题建议，检查后再更新原标题。
- 在 ChatGPT `/library` 页面打开资料库面板，搜索、筛选或批量下载文件。批量删除请用 ChatGPT 原生功能。

Gemini 和 Kimi 只能管理侧边栏已加载的会话；如列表不全，先滚动侧边栏加载更多。各网站接口可能随页面改版而变化。

## 隐私

扩展没有自建服务器或统计。会话和资料库操作直接使用当前网站的登录态。AI 标题功能需用户主动配置并确认；届时所选会话最近最多 8 条文字消息会发送给配置的 AI 服务。API Key 保存在浏览器本地。

## 本地测试

需要 Node.js；浏览器流程还需要本机安装 Chrome：

```bash
cd test
npm install
npm test
```
