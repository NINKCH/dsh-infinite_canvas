---
look_id: saturated-epic
title: 高饱和史诗
kind: look
---
<!-- slice:story shot prompt -->
## 成像底层
- 数字高清采集 + 强风格化分级；对比全开
- 颗粒强度区间：`[低, 中]`
- 高光滚降：允许大面积过曝（太阳、火、天空白掉）
- 暗部：可以近黑，但主体轮廓始终可读，0 值裁剪 `[≤12%]`

<!-- slice:story shot prompt -->
## 形体与骨相
- 头身比区间：`[6.5, 7.5]`，写实偏雕塑
- 真人骨相 + 强光影塑形：汗、尘、伤都要可见
- 衣料：磨损皮革、战损布甲、油污工装；新旧混搭但都有故事

<!-- slice:shot prompt assets -->
## 影调与光比
- 光比区间：`[1:5, 1:9]`
- 色温区间：`[3200K, 5600K]` 两极并存：低角太阳的橙与机械灯的青
- 光源动机：低角度太阳、火、车灯、信号弹
- 太阳方向过曝白掉是允许且常见的状态
- 禁止柔光箱、禁止均匀补光、禁止阴天灰调

<!-- slice:shot prompt assets -->
## 色彩命题
- 主调血红与橙黄对撞钴蓝，互补色直接开火
- 辅调烟黑与土黄
- 饱和度区间：`[高, 高]`，红要近血、黄要烫
- 色值（源自 20 位高饱和史诗导演的真实聚合）：`#BA1E1E` 血红 · `#FFD54F` 烈日黄 · `#0D47A1` 钴蓝 · `#232122` 烟黑 · `#FF8F00` 火橙 · `#2E7D32` 战术绿
- 禁止低饱和、禁止灰调、禁止柔和过渡

<!-- slice:shot prompt assets -->
## 空气与介质
- 介质层数：`[3, 5]` 层——沙暴、烟、尘、火星、热浪
- 沙与尘在光路中必须可见（速度参照物）
- 禁止干净空气、禁止无尘环境

<!-- slice:shot prompt assets -->
## 光学与镜头
- 焦段区间：`[21mm, 50mm]`，广角贴身为主
- 景深：`[f/4, f/8]`，深景深（动作要全场可读）
- 畸变：`[21mm, 24mm]` 允许 `[1%, 2%]`，竖线保持直
- 滤镜：禁柔光；允许偏振加深天空
- 快门：正常；升格仅用于看清物理事件

<!-- slice:prompt assets -->
## 材质响应
- 金属：战损、油污、焊接痕，高光硬而亮，反射值 `[0.5, 0.85]`
- 织物：粗帆布、皮革，边缘起毛，沾泥与血
- 皮肤：晒红 + 汗高光 + 尘覆盖，一道汗痕要能看清
- 火：火舌有形状，火星是实体颗粒

<!-- slice:shot prompt -->
## 特效语言
- 允许：火、爆炸、碎片、沙暴、轮胎扬尘、火花
- 禁止：魔法粒子、发光法阵、全息 UI、柔光滤镜

<!-- slice:prompt -->
## 针对性禁项
1. 慢镜美学化：把暴力拍成舞蹈
2. 低饱和灰调：把史诗拍成文艺
3. 干净人物：脸上无尘无汗
4. 霓虹紫青：电子游戏配色
5. 优雅构图：中心对称与留白不属于这里
6. 柔焦浪漫：全部东西都该硬
7. 无重量 CG：碎片飘浮、火团像棉花

<!-- slice:prompt -->
## 负向词块
`muted desaturated grade, elegant composition, soft light, pastel colors, neon cyberpunk purple, floating weightless debris, slow motion beauty, clean clothes, smooth skin, minimal set, symmetry, negative space, shallow depth of field close-up, film grain beautification, watermark, text, logo, extra fingers, deformed hands`
