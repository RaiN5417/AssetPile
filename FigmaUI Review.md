# Asset Pile Figma 设计评审

当前稿已经从“页面概念”推进到“统一桌面外壳 + 核心页面 + 部分交互状态”的阶段。信息架构和组件化基础都比表面看起来更成熟，但距离开发可低歧义交付，仍缺三块关键内容：窗口自适应规则、完整状态与恢复流程、设计系统规范化。

上一轮可读取的对话只留下了“再看一下现在的设计稿怎么样”，没有具体的前版评审结论。因此以下不会臆造历史意见；能够确认的演进方向，是页面覆盖正在扩大，并开始加入统一外壳、Gallery/List 模式、变量驱动详情和创建弹窗。

## Design Health Score

| # | 启发式 | 分数 | 关键问题 |
|---|---|---:|---|
| 1 | 系统状态可见性 | 2/4 | 有业务状态标签，缺加载、扫描进度和操作完成反馈 |
| 2 | 系统与现实世界匹配 | 3/4 | 路径、格式、尺寸、Inbox、Group、Tag 符合资产管理模型 |
| 3 | 用户控制与自由 | 2/4 | 有关闭详情和 Cancel，Undo、删除恢复、清空筛选未证明 |
| 4 | 一致性与标准 | 2/4 | 外壳统一，但语言、字体、命名和命令层级仍不稳定 |
| 5 | 错误预防 | 2/4 | Scan Import 有禁用项和选中计数，重名、权限、路径冲突未覆盖 |
| 6 | 识别优于回忆 | 3/4 | 导航有图标与文字，表格列清楚；Inbox 卡片墙增加查找负担 |
| 7 | 灵活性与效率 | 2/4 | 有 Gallery/List 和 Select All，缺快捷键、右键及完整批处理 |
| 8 | 美观与极简 | 3/4 | 克制、清晰，但页面密度和重点层级不够稳定 |
| 9 | 错误识别与恢复 | 1/4 | 只有 error/Failed 标签，未见 Retry、Offline 和恢复路径 |
| 10 | 帮助与文档 | 1/4 | 未见首次使用或上下文帮助 |
| **总分** |  | **21/40** | **可接受，交付规格仍有明显缺口** |

## 设计特异性

产品结构已经具有 Asset Pile 的特征：

- Home、Inbox、Temporary 对应资产进入、处理和回收。
- Group 与 Tag 提供目录式和语义式组织。
- Gallery/List 分别服务视觉识别和元数据比较。
- 本地路径、格式、尺寸、缩略图和详情栏符合桌面资产管理场景。

视觉语言仍偏通用：白色背景、浅灰分隔、蓝色按钮、侧栏和数据表可以直接移植到文档管理器或后台系统。产品名里的“Pile”还没有转化为独特的收集、批处理、拖放、扫描反馈或整理体验。

自动检测不适用于外部 Figma URL。证据路线改用 Figma 的只读结构、截图、组件、Variables、Libraries 和 Prototype 数据。由于子任务浏览器不支持可见标签和脚本注入，本次没有可靠的用户可见检测覆盖层。

## 做得好的地方

1. **主要信息架构是成立的。** Locations、Groups、Tags、Inbox、Temporary、History 的关系已经能支撑一个完整资产管理产品。

2. **Gallery/List 是正确的双模式。** Gallery 适合视觉筛选，List 适合查看文件格式、尺寸和标签。Gallery 选中卡片后还会通过 Variables 更新详情和选中边框。

3. **并非“只有静态稿”。** 文件已有 10 个 Component Set、35 个 Component、55 个本地 Variables，约 870 个节点存在变量绑定。Menu Item、Asset List Row、Scrollbar 等组件已经覆盖部分状态。

## 修改优先级

### P1 — 先完成 Windows 可变窗口规则

当前所有完整活动画板均为 1440×960。应用外壳采用：

- 264 px 固定 Sidebar
- Fill Main Content
- 可选的 320 px 固定 Details Sidebar

Gallery 在 788 px 内容区显示两列 289 px 卡片；Inbox 在 1108 px 内容区显示五列约 208 px 卡片。虽然两者使用 Auto Layout、Fill 和 Wrap，但没有同一页面在窄窗中的实例，无法确认换列、最小卡宽、侧栏折叠和搜索框碰撞。

建议补齐：

- 1440 px：展开 Sidebar + Main + Details。
- 1024 px：Sidebar 降为 Navigation Rail；Details 使用 Overlay/Drawer。
- 720 px：单主列，次要命令收入菜单，详情进入独立层级。
- Windows 50/50 分屏：Inbox 降为一至两列，Gallery 卡片重新排布。
- 125%/150% DPI 和 200% 文字缩放验证。

Gallery/List 是浏览模式，不能代替响应式断点。

建议命令：`$impeccable adapt`

### P1 — 补完整状态、恢复机制与可运行原型

当前有 61 个带 Reaction 的节点、Gallery/List 切换、Variables 驱动详情、三个 Modal 和单/多文件浮卡，但：

- 没有 Flow Starting Point。
- 36 个 Reaction 有触发器但没有 Action。
- 没有独立 Empty、Loading、Skeleton、Offline、Retry 状态。
- 没有证明删除后的 Undo 或 Temporary 恢复规则。
- 没有覆盖重名、权限不足、路径失效和部分导入失败。

建议先做一条完整的“导入 → 扫描 → 选择 → 整理 → 完成/失败恢复”原型；为删除标明对象数、去向和保留期限，并提供 Undo Toast；清理所有空 Action。

建议命令：`$impeccable harden`

### P1 — 把已有组件资产收敛成可交付设计系统

当前设计系统成熟度约为 **3/5**。基础已存在，问题是规范还没有闭合：

- Button 只有 Primary、Secondary、Link、Link Danger，没有 Hover、Pressed、Focus、Disabled、Loading。
- Switch 只有 On/Off；Pic Item 没有 Hover、Loading、Error。
- 存在 `Component 1`、`Statu1–4`、`Frame 7`、`setbar-main` 等不可交付命名。
- `Number / Number 2 / Number 3` 被用于行高，语义不清。
- `state/worning` 疑似拼写错误。
- 两个 Variable Collection 都只有 `Mode 1`。
- Foundations 页面只有字体样本，没有颜色、间距、圆角、边框、阴影、图标、焦点和 Motion。
- 本地没有 Paint、Effect 或 Grid Styles；Variables scopes 大多仍是 `ALL_SCOPES`。

建议补齐核心组件状态矩阵，建立 Light、Dark、High Contrast modes，并把 token 命名、scope、代码映射和外部库依赖整理到 Foundations。

建议命令：`$impeccable document`

### P2 — Windows 一致性需要从外壳深入到控件行为

做得对的部分包括 32 px Windows Titlebar、拖拽区和三个 46×32 窗口控制区域。问题包括：

- 当前字体定义显示为 Inter，没有说明是否有意偏离 Segoe UI Variable。
- Windows 文件订阅了 `macOS 27` 库，需要说明使用边界。
- EN Screens 中仍有中文状态和素材名，CN Screens 为空。
- Command Bar、Context Menu、Focus Visual、快捷键和高对比模式未形成规范。
- `Setting`、`Settings`，以及 Group/Groups、Tag/Tags 的命名需要统一。
- 危险操作目前更像孤立的红色文字，没有完整的命令、确认和撤销体系。

建议以 Fluent 2/WinUI 的 NavigationView、CommandBar、ContentDialog、InfoBar、TeachingTip 和 Focus Visual 为基础，保留现有品牌颜色。

建议命令：`$impeccable polish`

### P2 — 统一页面密度和视觉层级

Group Detail 的表格偏小，下方留白较多；文字与次级元数据偏轻。Inbox 则一次显示 20 张近似卡片，形成同权重的内容墙。

建议：

- 每页只突出一个一级动作，并放入统一 Command Bar。
- 拉开标题、路径、表头、正文和次级元数据的字号与色阶。
- 表格使用更多可用高度，加入排序、选中态和批量命令栏。
- Inbox 按日期、来源或处理状态分段，强化“待处理”的优先级。
- 用内容规则控制密度，而不是让所有页面套用相同间距。

建议命令：`$impeccable layout`

## Gallery / Inbox 自适应结论

文件已经证明“布局具有响应意图”：Gallery 和 Inbox 都使用横向 Wrap、宽度 Fill；详情栏隐藏后主区会从 854 px 扩展到 1174 px。

文件尚未证明“响应式已经完成”。缺少：

- Gallery 宽态与窄态对照。
- Inbox 窄态。
- Sidebar 的 Rail/Drawer 状态。
- Details Sidebar 的 Overlay/独立页规则。
- 最小卡片宽度和换列断点。
- 表格列在窄窗下的优先级。
- 窗口最小宽度、DPI 与文字缩放规范。

## 从原型到可交付 UI 的完成度

- **页面覆盖：约 65–75%。** Gallery、List、Inbox、Groups、Group Detail、Tags、Temporary、History、Settings 和三个 Modal 均已有画板。
- **交付可信度：约 45–55%。** Auto Layout、Variables 和局部 Prototype 已提高可实现性，但缺少断点、完整状态矩阵、启动 Flow、Annotations、Export Settings、键盘、无障碍、暗色/高对比和错误恢复。

当前适合进入“规范化和补状态”阶段，不建议继续平铺更多 1440×960 页面。

## Persona 风险

**Alex，效率型高级用户**

Gallery/List 是好的起点，但尚未证明快捷键、右键菜单、批量加标签/移动、列配置或保存视图。若主要整理动作仍需逐项完成，效率可能低于资源管理器。

**Jordan，首次使用者**

不容易判断 Inbox 是待处理队列还是存储位置，也不清楚 Group 和 Tag 分别该在何时使用。缺少空状态、首次导入指引和真实示例，用户可能停在“下一步应该做什么”。

**Sam，键盘与无障碍用户**

没有可验证的焦点环、Tab 顺序、屏幕阅读器名称、状态播报、200% 文字缩放和高对比状态。Inbox 的近似卡片如果依赖图片和颜色表达状态，会进一步增加识别困难。

## 次要问题

- `03 EN Screens` 中英混用，而 `04 CN Screens` 为空。
- `00 Cover` 为空，没有文件入口、状态或版本说明。
- Text Styles 命名混用空格与 `/`，Descriptions 为空。
- `Body Large` 和 `Title` 的异常行高比例需要复核。
- Gallery 已覆盖较长文件名和尾部截断，这项应保留。
- Scan Import 已覆盖 Checked、Unchecked、Disabled、Select All 和选中计数，可作为批处理状态模板。
- 归档 Mac Gallery 使用手工 Row Frame，不应作为 Windows 响应实现依据。

## 建议执行顺序

1. 补 Gallery/Inbox 的四档 Windows 窗口和明确布局规则。
2. 建立核心组件状态矩阵及 Light/Dark/High Contrast Variables。
3. 完成导入、扫描、删除、恢复、创建 Group/Tag 的异常状态。
4. 清理 Prototype 入口和空 Action，形成一条可运行主流程。
5. 统一 Fluent 2 命令层级、语言、键盘、焦点和 DPI 规则。
6. 最后用空 Inbox、1000 项、长路径、缩略图失败、重复 Tag、离线磁盘和权限不足做压力检查。

- **首次评审，当前趋势为 21/40，暂无历史趋势。**


1. **第一优先级**：状态、错误恢复和完整原型。
2. **Inbox 定义**：待处理队列, 长期存储位置, 两者兼有，但需要明确生命周期。
3. **窄窗详情行为**： 覆盖式右侧抽屉

