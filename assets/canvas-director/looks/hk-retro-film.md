---
look_id: hk-retro-film
title: 复古港风胶片
kind: look
---
<!-- slice:story shot prompt -->
## 成像底层
- 灯光型 500T 负片，扫描至数字中间片；保留胶片肩部与趾部
- 颗粒强度区间：`[中, 高]`，颗粒可见且随曝光变化（暗部更粗）
- 高光滚降：溢出柔化成光团，halation 明显，`[0.5档, 1.5档]` 内不丢结构
- 暗部：**不死黑**，暗部偏暖棕并保留颗粒；0 值裁剪 `[≤5%]`

<!-- slice:story shot prompt -->
## 形体与骨相
- 头身比区间：`[6.5, 7.5]`
- 真人骨相但有结构柔化，非高清锐利；发丝带轻微运动拖影
- 面部允许汗光、油光、暗部腮影，不磨皮
- 衣料：垫肩西装、丝质衬衫、港式窄裙；薄丝垂坠贴身，肩线硬挺

<!-- slice:shot prompt assets -->
## 影调与光比
- 光比区间：`[1:4, 1:7]`
- 色温区间：`[2800K, 4300K]`，钨丝暖黄与霓虹青绿同框并存
- 光源动机：霓虹招牌、钨丝吊灯、荧光管、车灯扫过
- 大面积暗部 + 局部强光斑，禁止全画面平均亮度
- 禁止冷白 LED 均匀补光、影棚白墙反弹

<!-- slice:shot prompt assets -->
## 色彩命题
- 主调暖黄底（钨丝、灯箱、奶茶色墙）
- 辅调霓虹青绿与洋红，仅出现在光源与反射面
- 饱和度区间：`[高, 高]`，绿调突出但不脏
- 色值：`#E8B23A` 钨丝暖 · `#1FA08A` 霓虹青 · `#D2436B` 洋红 · `#2A1F1A` 暗褐 · `#F2E3C2` 灯箱白
- 禁止数码冷调、灰蓝阴影、整体低饱和

<!-- slice:shot prompt assets -->
## 空气与介质
- 介质层数：`[2, 3]` 层——烟饼薄雾、水汽、光晕渗化
- 烟：密度低但持续，切光后可见光柱 `[1, 2]` 道
- 水汽：雨夜路面蒸腾，墙面返潮有水痕
- 光晕：高光周围 `[8px, 24px]` 渗光，不糊掉五官结构

<!-- slice:shot prompt assets -->
## 光学与镜头
- 焦段区间：`[24mm, 85mm]`，贴身近距多用 `[28mm, 35mm]`
- 景深：`[f/1.4, f/2.8]`，浅景深，前景遮挡（门框、栏杆、玻璃）占画面 `[10%, 30%]`
- 桶形畸变：`[24mm, 28mm]` 允许 `[1%, 2%]`；人脸禁用畸变
- 滤镜：雾镜 `[1/4档, 1/2档]`，可加柔光；禁星芒、禁清晰锐利
- 快门：`[1/8秒, 1/30秒]` 慢门拖影

<!-- slice:prompt assets -->
## 材质响应
- 金属：旧铁闸与不锈钢管只反霓虹与车灯，高光拉成彩条，反射值 `[0.5, 0.8]`
- 织物：丝质衬衫有方向性高光带，垫肩西装哑光；湿衣贴身显褶皱
- 皮肤：潮润高光在颧骨与鼻梁，`[2mm, 3mm]` 次表面渗光，汗珠独立可辨
- 玉石：翡翠与玉镯半透，背光内部渗绿 `[5mm, 12mm]`，表面油脂光

<!-- slice:shot prompt -->
## 特效语言
- 允许：霓虹闪烁与灯管频闪、雨丝、烟、湿地面倒影、车灯扫光
- 允许：halation 光晕、轻微抽帧残影
- 禁止：法术粒子、发光法阵、能量对波、漂浮光点
- 禁止：粒子覆盖超过 `10%`，禁止 3D 烟雾模拟感

<!-- slice:prompt -->
## 针对性禁项
1. 干净锐利数码影像：全画面无颗粒、边缘生硬
2. 均匀布光：无暗部、脸上无阴影落点
3. 冷白 LED 与办公白光：把暖调洗成灰白
4. 现代物件：玻璃幕墙、碳纤维、智能手机、LED 屏
5. 高帧率流畅运动：无抽帧顿挫的顺滑动作
6. 大场面全景：开阔航拍与干净天际线
7. 韩式平光美颜：磨皮、亮到发白的人脸
8. 塑料质感：衣物反光如涤纶新手套
9. 霓虹铺满：整个画面染成洋红看不清人
10. 现代调色：青橙分离、HDR 阴影提亮
11. 抽帧做成卡顿：全片掉帧而非局部顿挫

<!-- slice:prompt -->
## 负向词块
`clean digital, sharp modern footage, even lighting, flat fill light, cool white led, hdr grade, teal orange grade, lifted shadows, no grain, plastic texture, modern glass facade, smartphone, led screen, smooth high frame rate, drone wide shot, clear skyline, airbrushed face, korean beauty light, neon flooding frame, magenta wash, static pose, sharp focus everywhere, crisp edges, 4k commercial look, stock photo, watermark, text, logo, extra fingers, deformed hands, cgi smoke`
