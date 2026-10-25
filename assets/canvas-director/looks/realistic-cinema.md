---
look_id: realistic-cinema
title: 写实电影
kind: look
---
<!-- slice:story shot prompt -->
## 成像底层
- 数字高动态采集为主，可换灯光型 500T 负片扫描；同镜不得混用两种载体
- 颗粒强度区间：`[低, 中]`，颗粒均匀，禁色噪块
- 高光滚降：肩部圆滑，`[1.5档, 2.0档]` 过曝只掉饱和不掉结构
- 暗部：`[-2档, -3档]` 保留纹理，**不死黑**；0 值裁剪像素 `[≤3%]`

<!-- slice:story shot prompt -->
## 形体与骨相
- 头身比区间：`[7.0, 7.8]`
- 写实真人骨相，颧骨与下颌线可辨，鼻梁有软骨转折
- 皮肤保留毛孔、色素不均、痘印与眼袋，**不磨皮**
- 衣料按克重分：`[180g, 220g]` 棉布起硬褶，`[300g, 400g]` 羊毛垂坠贴体，褶裥受重力竖直下落

<!-- slice:shot prompt assets -->
## 影调与光比
- 光比区间：`[1:4, 1:7]`，面部主辅光差 `[2档, 3档]`
- 色温区间：`[3200K, 5600K]`，同镜冷暖分离，整体不偏色
- 光源动机：窗、台灯、街灯、天光，每个光源在画面内可见或可推断
- 光位侧逆 45° 起手，轮廓光过曝 `[1/4档, 1/2档]`
- 禁止平光满铺、无动机补光、影楼柔光罩正面平打

<!-- slice:shot prompt assets -->
## 色彩命题
- 主调中性灰底 + 环境实色，白平衡以人脸为准
- 辅调皮肤暖、阴影冷，冷暖交界落在颧骨到下颌
- 饱和度区间：`[低, 中]`，只有肤色与光源色饱和
- 色值：`#8C7A66` 肤中调 · `#2E3742` 阴影蓝灰 · `#C9B79C` 高光暖 · `#5A6350` 环境绿灰 · `#14161A` 近黑
- 禁止青橙调溢出、品红阴影、整体偏绿

<!-- slice:shot prompt assets -->
## 空气与介质
- 介质层数：`[2, 3]` 层——近景尘、中层薄雾、远景大气透视
- 尘：光柱内可见悬浮颗粒，直径观感 `[0.5mm, 2mm]`
- 雾：远景消光，对比度按距离 `[每10米 -8%, -12%]`
- 湿气只在水汽合理处出现（浴室、雨夜），不无故加雾
- 光柱必须有遮挡物切边，边缘软化 `[3px, 8px]`

<!-- slice:shot prompt assets -->
## 光学与镜头
- 焦段区间：`[24mm, 135mm]`，叙事主力 `[35mm, 85mm]`
- 景深：`[f/1.8, f/4]`，人脸对焦允许 `<5cm` 呼吸位移
- 桶形畸变：`[24mm, 28mm]` 允许 `[0.5%, 1.5%]`，`35mm` 以上禁止
- 滤镜：柔光扩散 `[1/8档, 1/4档]`，可加偏振压反光；禁星芒镜
- 纵向色散 `[1px, 2px]` 允许，明显紫边禁止

<!-- slice:prompt assets -->
## 材质响应
- 金属：拉丝面呈带状高光，镜面只反射可解释环境（窗、灯、天空），反射值 `[0.6, 0.9]`
- 织物：棉麻漫反射为主，绒面 `[15°, 30°]` 掠射角亮度抬升；丝绸有方向性高光带
- 皮肤：次表面散射半径 `[2mm, 4mm]`，鼻翼与耳廓透光偏红，油光只在鼻尖额头
- 玉石：半透，背光内部渗光 `[8mm, 20mm]`，表面油脂光泽不成镜面

<!-- slice:shot prompt -->
## 特效语言
- 允许：烟尘、雨丝、火花、玻璃碎屑、蒸汽、血雾，粒子须有重力与阻力
- 允许：镜头内光晕、轻微 halation，强度 `[低, 中]`
- 禁止：发光法阵、剑气拖尾、悬浮符文、能量对波、卡通爆闪
- 禁止：粒子覆盖画面超过 `15%`

<!-- slice:prompt -->
## 针对性禁项
1. 磨皮脸：毛孔全消失、鼻梁高光糊成一片
2. 三点光全亮：脸上无阴影过渡的商业人像光
3. 无动机光：夜里主角脸均匀照亮却找不到灯
4. 塑料金属：刀剑反光纯白色块，不反射环境
5. 过度锐化：发丝与衣边出现白色描边
6. 青橙溢出：阴影整体发青、肤色橙到失真
7. 假景深：背景虚但前景发丝也虚，或抠像光晕
8. 液化脸：下巴过度收窄、眼距拉宽的网红比例
9. 悬浮动作：人物离地、衣摆无重力上扬
10. 粒子滥用：满屏火星盖住人脸
11. 死黑暗部：阴影一片 0 值，看不出材质
12. 全画面无颗粒、边缘生硬如游戏截图

<!-- slice:prompt -->
## 负向词块
`plastic skin, airbrushed face, beauty filter, even flat lighting, unmotivated light, three point studio light, over sharpened, hdr halo, white clipping, crushed blacks, teal and orange grade, magenta shadows, fake bokeh, matte painting background, floating pose, zero gravity cloth, cartoon particles, glowing runes, energy beam, star lens flare, plastic metal, waxy texture, doll face, over saturated skin, low poly, game render look, watermark, text, logo, extra fingers, deformed hands`
