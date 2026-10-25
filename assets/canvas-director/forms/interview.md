---
form_id: interview
title: 访谈
kind: form
spec:
  durations: [60, 300, 900]
  asl_floor_s: 4.0
  asl_target_s: "8.0-20.0"
  platforms: ["bilibili", "youtube", "broadcast"]
---
<!-- slice:story shot prompt -->
## 交付规格

- **画幅不在本规格里决定。** 横屏双机位访谈是主流，竖屏单人访谈同样成立；**画幅与分辨率在视频节点生成时选**。
- **质量基线：脸必须干净、稳定、光是成立的。** 访谈片的全部资产就是那张脸和那句话——脸上有一处脏光、背景有一个乱物件，观众的注意力就跑了。
- 片长 5 / 15 / 30 分钟，容差 ±10%。
- ASL 下限 4.0 秒（这是全套规格里最长的下限）；目标 8–20 秒。**允许 40 秒以上不切**，只要受访者在说话。
- 平台默认 bilibili / youtube / 广播（广播按 -23 LUFS）。
- 帧率 25 拍为主。

- **生成次数换算**：单次 3–8 秒。访谈的镜头很长（ASL 8–20 秒），所以**必须靠尾帧续接**把多段接成一个连续镜头：同机位、同光向、同景别、人物姿态在中途接上。接点务必落在说话中间，不要落在换气口，否则会被看出来。
<!-- slice:story -->
## 结构块

| 段位 | 时长占比 | 能量 | 职责 | 画面策略 |
|---|---|---|---|---|
| 立传 | 10–15% | 中 | 让观众知道这个人是谁、凭什么 | 环境建立 + 第一段自述 |
| 第一层 | 35–40% | 低 | 主要经历的叙述，建立信任 | 双机位交替，长镜不切 |
| 转折 | 20–25% | 中高 | 追问：出现矛盾、代价、或者他不愿说的部分 | 贴近、缩短景别、机位略微偏移 |
| 现在 | 20–25% | 低 | 回到当下：他现在怎么看这件事 | 更松的构图、更慢的节奏 |

**提问的顺序就是结构**：从「发生了什么」到「为什么」再到「现在怎么想」。不要在开头就问「为什么」，那样观众还没有足够的背景去理解答案。

<!-- slice:story shot -->
## 这个类型的观众契约

- 观众来看的是**这个人怎么说**，不是他说的内容有多劲爆。所以**停顿、犹豫、改口、沉默都要留着**——那是访谈片最贵的部分。
- **必须有一次追问**。一路顺下来的访谈是宣传，不是访谈。
- **不要替受访者总结**。旁白把他说的话概括一遍，是最常见的败笔。
- 关掉的原因：**全是套话**（没有一次追问）、**剪辑剪掉了所有犹豫**（人变成念稿机）、**画面单调且没有变化**（两小时一个机位不动）。

<!-- slice:story shot -->
## 与导演透镜冲突时的改写

访谈片是所有类型里**最不该挂强风格透镜**的——观众的全部注意力在听人说话，任何视觉上的主张都会分心。

- **可借的**：机位高度与距离（伯格曼的正面近距离访谈非常成立）、光比与色温（芬奇式的低照度侧光很成立）、背景的景深处理。
- **慎借**：柏格曼之外的「作者性」透镜。库布里克式对称会让受访者变成标本；张艺谋式色块会让背景抢戏。
- **基本不要借**：王家卫式手持与前景遮挡（挡住嘴和眼睛等于毁掉访谈）、雷弗恩式仪式构图、毕赣式长镜游走（观众会以为摄影机要跑掉）。
- **必须放弃的透镜参数**：任何要求「手持晃动」或「主体偏心到画幅边缘」的设定。访谈的第一原则是**脸在可读位置且稳定**。
- **唯一的例外**：如果这部访谈片本身就是「风格化的肖像纪录片」，可以挂一个强透镜——但那时它更接近**电影**或**纪实**规格，应该换类型规格，而不是在访谈规格里硬套。

<!-- slice:prompt -->
## 类型级负向词

teleprompter eyes, reading script, actor looking off camera to producer, over-lit interview, beauty lighting on subject, artificial rim light, flat fill, hot spot on forehead, shiny skin, background clutter, busy background behind head, plant growing out of head, watermark, subtitle burned in, jump cut without reason, cut mid-sentence, awkward silence removed, fake laugh, stiff posture, staring at camera lens, mic visible in frame, boom shadow, color cast on face, mixed color temperature on face
