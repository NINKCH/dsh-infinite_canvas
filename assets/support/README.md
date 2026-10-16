# 帮助与反馈静态资源

画布界面里的「帮助与反馈」弹窗（工具栏按钮 / 设置面板卡片）会加载这里的文件：

## 微信群二维码

- **文件名必须为** `wechat-group.png`（放在本目录下）
- 建议尺寸 400×400 以上、正方形 PNG（微信导出的群二维码即可）
- 保存后重启 DSH 生效（静态资源路由在插件启动时注册）
- 文件不存在时，弹窗会显示占位提示「二维码待放置：把图片保存为 assets/support/wechat-group.png」，不会报错

访问方式（插件自身路由，白名单 `assets/` 目录，拒绝路径穿越）：

```
/infinite-canvas/api/plugin-asset?rel=assets/support/wechat-group.png
```

## GitHub 地址

仓库与 Issue 地址写在 `client.js` 顶部的 `SUPPORT_GITHUB` / `SUPPORT_ISSUES` 常量里，改地址只需改这两行。
