---
look_id: anime-thick-paint
title: 2D厚涂
kind: look
---
<!-- slice:story shot prompt -->
## 成像底层
- 手绘厚涂（不透明颜料逐层覆盖），数字绘制模拟油画笔触堆积
- 颗粒/纸纹强度区间：`[中, 高]`，画布肌理在平涂区可见
- 高光滚降：硬边为主，`[0.5档, 1档]` 内出现第二层提亮笔触
- 暗部：**允许局部死黑**，暗块不超过画面 `[15%, 25%]`，块内不糊成渐变

<!-- slice:story shot prompt -->
## 形体与骨相
- 头身比区间：`[6.5, 7.5]`
- 面部结构清晰：鼻梁用明暗交界线切出，不用线稿凹造型
- 非写实真人，但解剖可信；肌肉起止点与骨点保留
- 衣料：厚重布料用大笔触概括，褶裥以块面明暗表达，不用细线勾边

<!-- slice:shot prompt assets -->
## 影调与光比
- 光比区间：`[1:5, 1:9]`
- 色温区间：`[4000K, 6500K]`，冷光与硬光并存
- 光源动机：单侧强光、逆光切边、霓虹侧打，允许戏剧化超现实光位
- 阴影边缘硬，明暗交界线明确，禁大面积软过渡
- 禁止均匀柔光、禁止无阴影的白模打光

<!-- slice:shot prompt assets -->
## 色彩命题
- 主调高对比冷底（蓝灰、墨绿、暗紫）
- 辅调高亮暖色点睛（橙红、琥珀），只占画面 `[10%, 20%]`
- 饱和度区间：`[中, 高]`，暗部降饱和，亮部提饱和
- 色值：`#1B2430` 冷暗底 · `#4E6B7A` 中间冷灰 · `#E0562F` 高亮橙红 · `#F0C070` 暖光 · `#0B0D10` 黑
- 禁止糖果色平铺、禁止低对比灰调

<!-- slice:shot prompt assets -->
## 空气与介质
- 介质层数：`[2, 3]` 层——笔触雾块、尘、光柱
- 雾用笔刷块面表达，边缘有笔锋，不做平滑体积雾
- 光柱用叠加笔触，边缘阶梯感可接受 `[2, 3]` 级
- 禁止 3D 粒子云、禁止镜头污渍贴图

<!-- slice:shot prompt assets -->
## 光学与镜头
- 焦段区间：`[24mm, 70mm]`，画面透视可夸张
- 景深：虚拟，仅靠前中后景明度与细节量分离
- 桶形畸变：允许 `[1%, 3%]`，用于战斗与冲击镜头
- 滤镜：无真实镜头滤镜；可叠纸纹与色差 `[1px, 2px]`
- 禁止真实镜头的失焦光斑与呼吸感

<!-- slice:prompt assets -->
## 材质响应
- 金属：用高对比笔触切面表达，高光为不规则亮块，反射不描环境
- 织物：布纹用干笔扫出，褶皱以块面分层，边缘有笔触毛边
- 皮肤：色阶分 `[3, 4]` 层，交界线明确，允许笔触留在脸上
- 玉石：半透感靠亮部提白 + 暗部反光色，不做真实折射

<!-- slice:shot prompt -->
## 特效语言
- 允许：笔触化速度线、冲击白闪、彩色碎块、墨点飞溅、粗糙光斑
- 允许：单帧夸张变形（拉伸、压缩）
- 禁止：写实粒子模拟、体积光、真实爆炸素材
- 禁止：发光描边包裹整个角色

<!-- slice:prompt -->
## 针对性禁项
1. 厚涂画成平涂：色块无笔触、明暗靠渐变
2. 线稿外露：黑色勾边包住整个人物
3. 三渲二冒充：3D 模型加描边，光影均匀
4. 皮肤磨成塑料：无交界线、无笔触
5. 阴影软成雾：大面积高斯过渡
6. 糖果色：亮到发白的粉蓝黄平铺
7. 笔触全部一致：同一笔刷刷满画面
8. 背景比人物细：背景细节抢主体
9. 高光位置乱：多光源却只有一个高光点
10. 特效发光描边：整个人物套一圈白光
11. 写实照片贴图：布料贴照片纹理

<!-- slice:prompt -->
## 负向词块
`flat color, cel shading only, gradient shading, black outline around figure, 3d render with outline, plastic skin, airbrush smooth, soft gaussian shadow, candy color, pastel wash, uniform brush stroke, photo texture, realistic photo, bloom outline, glow rim on whole body, vector flat art, clean vector lines, low contrast, gray muddy, watermark, text, logo, extra fingers, deformed hands, blurry, jpeg artifact`
