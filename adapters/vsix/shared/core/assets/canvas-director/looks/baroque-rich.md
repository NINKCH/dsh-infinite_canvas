---
look_id: baroque-rich
title: 巴洛克浓彩
kind: look
---
<!-- slice:story shot prompt -->
## 成像底层
- 数字模拟大幅面胶片 + 绘画感后期；暗部如油画堆叠
- 颗粒强度区间：`[中, 中]`，细但有画布感
- 高光滚降：柔中有形，金器高光保留形状
- 暗部：油彩式深棕黑，层次靠笔触般的色阶变化，0 值裁剪 `[≤10%]`

<!-- slice:story shot prompt -->
## 形体与骨相
- 头身比区间：`[6.5, 8]`，可略拉长（绘画感）
- 真人骨相但光影做雕刻感：颧骨、眉弓、鼻梁有明确的明暗交界
- 衣料：丝绒、锦缎、皮草、金线刺绣；厚重垂坠，高光呈缎面带

<!-- slice:shot prompt assets -->
## 影调与光比
- 光比区间：`[1:5, 1:10]`，伦勃朗式单侧主光
- 色温区间：`[2700K, 3800K]`，烛光、油灯、暖金吊灯
- 光源动机：烛、火、金器反光、彩窗
- 暗部占画面 `[40%, 60%]`，亮部集中在脸与金器
- 禁止平光、禁止冷白主光、禁止现代均匀照明

<!-- slice:shot prompt assets -->
## 色彩命题
- 主调深棕黑打底，金与深红承担视觉焦点
- 辅调深绿与赭石，占 `[15%, 25%]`
- 饱和度区间：`[中, 高]`，但饱和集中在织物与金器，皮肤不过饱和
- 色值（源自 20 位巴洛克浓彩导演的真实聚合）：`#1C1C1C` 油画黑 · `#8B4513` 赭褐 · `#DAA520` 老金 · `#8B0000` 深红 · `#2F4F4F` 墨绿 · `#FFD700` 亮金
- 禁止冷调打底、禁止糖果色、禁止荧光

<!-- slice:shot prompt assets -->
## 空气与介质
- 介质层数：`[2, 3]` 层——烛烟、尘埃、暖雾
- 尘埃在光路里可见，密度低
- 允许画框式暗角，边缘压暗 `[10%, 20%]`
- 禁止冷雾、禁止现代烟机效果

<!-- slice:shot prompt assets -->
## 光学与镜头
- 焦段区间：`[35mm, 85mm]`，肖像用 `[50mm, 85mm]`
- 景深：`[f/1.8, f/4]`，人物清晰、暗部融进油画底
- 畸变：禁止
- 滤镜：柔焦 `[1/4档]` 可用（只用于远景）
- 快门：正常

<!-- slice:prompt assets -->
## 材质响应
- 金属：金器高光呈形状色斑（不是白点），反射值 `[0.6, 0.9]`
- 织物：丝绒近黑处仍有绒面反光带，锦缎高光成流动水纹
- 皮肤：暖棕底 + 颊侧深红过渡，高光呈蜡质
- 玉石与宝石：内部色深，一点锐高光

<!-- slice:shot prompt -->
## 特效语言
- 允许：烛光摇曳、火光映脸、尘埃光路、金器闪光
- 禁止：法术粒子、现代光效、冷色光斑

<!-- slice:prompt -->
## 针对性禁项
1. 现代冷白光：破坏烛光世界
2. 高饱和糖果色：把这个调子拍成游乐园
3. 死黑无层次：暗部没有油画感
4. 蓝调夜色：夜间也是暖黑
5. 干净锐利：全画面高清锐利像数码样片
6. 极简构图留白：画面应该是满的、重的
7. 现代服装与物件：拉链、塑料、印刷体

<!-- slice:prompt -->
## 负向词块
`cool white light, modern interior, clean minimal, high key, flat lighting, candy colors, pastel, neon, plastic texture, sharp digital, hdr, teal shadows, cold blue, empty negative space, contemporary clothing, zipper, plastic, printed text on props, watermark, text overlay, logo, extra fingers, deformed hands`
