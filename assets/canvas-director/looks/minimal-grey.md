---
look_id: minimal-grey
title: 极简冷灰
kind: look
---
<!-- slice:story shot prompt -->
## 成像底层
- 数字采集，中性白平衡，无风格化 LUT
- 颗粒强度区间：`[低, 低]`，画面干净
- 高光滚降：线性，不过曝不溢出
- 暗部：低反差灰，0 值裁剪 `[≤2%]`，全画面无死黑

<!-- slice:story shot prompt -->
## 形体与骨相
- 头身比区间：`[6.5, 7.5]`，写实
- 真人骨相，素颜感；允许倦态、浮肿、 ageing 不修饰
- 衣料：素色棉布、旧毛呢、无 logo 的外套；颜色彼此靠近

<!-- slice:shot prompt assets -->
## 影调与光比
- 光比区间：`[1:2, 1:3]`，全片最低
- 色温区间：`[4500K, 6500K]`，阴天天光、白炽平衡
- 光源动机：窗、阴天、日光管；无戏剧光
- 画面亮度分布平坦，无高光焦点
- 禁止强轮廓光、禁止彩色光源、禁止明暗对撞

<!-- slice:shot prompt assets -->
## 色彩命题
- 主调灰绿与灰褐的近亲色，彼此色相距离小
- 辅调米白（墙面、纸张），占比 `[20%, 35%]`
- 饱和度区间：`[低, 低]`，全画面几乎无彩色事件
- 色值（源自 20 位极简冷构导演的真实聚合）：`#8B958C` 灰绿 · `#697870` 深灰绿 · `#4A5951` 墨灰 · `#C2B8A5` 米灰 · `#9CA7AC` 雾蓝灰 · `#BCC2C5` 铅白
- 禁止任何高饱和点缀、禁止暖橙、禁止色彩叙事

<!-- slice:shot prompt assets -->
## 空气与介质
- 介质层数：`[1, 2]` 层——阴天漫射、潮气
- 空气干净，远景清楚但无空气透视染色
- 禁止雾、烟、光柱、雨丝特写

<!-- slice:shot prompt assets -->
## 光学与镜头
- 焦段区间：`[35mm, 85mm]`，标准视角为主
- 景深：`[f/4, f/8]`，深景深，全部可读
- 畸变：禁止
- 滤镜：禁止一切
- 快门：正常

<!-- slice:prompt assets -->
## 材质响应
- 金属：哑光，无强反射
- 织物：吸光，无高光带
- 皮肤：灰调底，几乎无油光，色相偏中性
- 墙面：乳胶漆细纹，均匀受光

<!-- slice:shot prompt -->
## 特效语言
- 允许：无（这个影调不需要任何特效）
- 禁止：一切粒子、光效、雾、倒影夸张

<!-- slice:prompt -->
## 针对性禁项
1. 电影感调色：任何对比度拉升、色彩分级
2. 戏剧性光：一束硬光、一个亮斑
3. 高饱和事件：一件红衣、一块黄招牌
4. 浅景深奶油背景：人物与背景都该清楚
5. 手持情绪化晃动
6. 暖调滤镜：把冷灰洗成温情
7. 广角畸变：空间被拉伸

<!-- slice:prompt -->
## 负向词块
`cinematic grade, dramatic lighting, hard shadow, high contrast, saturated colors, red accent, warm tone, teal orange, shallow depth of field, bokeh background, film grain, lens flare, volumetric light, haze, dutch angle, handheld shake, golden hour, watermark, text, logo, extra fingers, deformed hands`
