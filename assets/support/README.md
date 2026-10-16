# 帮助与反馈静态资源

画布界面里的「帮助与反馈」弹窗（工具栏按钮 / 设置面板一行入口）会加载这里的文件。

## 微信二维码

- 当前文件：`wechat.jpg`（**个人微信二维码**——永久有效；群二维码 7 天过期，难维护，所以用个人码 + 手动拉群）
- 换图：直接替换本目录的 `wechat.jpg`（同名同扩展名即可；若换成 PNG，请同步改 `client.js` 里的 `SUPPORT_QR_URL`）
- 建议正方形、400×400 以上
- **改完需重启 DSH**（静态资源路由在插件启动时注册）
- 文件缺失时弹窗显示占位提示，不会报错

访问方式（插件自身路由，白名单 `assets/` 目录 + 拒绝路径穿越）：

```
/infinite-canvas/api/plugin-asset?rel=assets/support/wechat.jpg
```

## GitHub 地址

仓库与 Issue 地址写在 `client.js` 顶部的 `SUPPORT_GITHUB` / `SUPPORT_ISSUES` 常量里，改地址只需改这两行。
