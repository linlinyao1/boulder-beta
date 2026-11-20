export interface ReleaseNote {
  version: string;
  date: string;
  title: string;
  highlights: string[];
}

export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.4.0';
export const GIT_COMMIT: string = typeof __GIT_COMMIT__ !== 'undefined' ? __GIT_COMMIT__ : 'dev';
export const BUILD_TIME: string = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '1.4.0',
    date: '2026-11-20',
    title: '真实岩点雕塑体系 & 版本管理',
    highlights: [
      '25 种真实岩点雕塑轮廓（8 大类型 × 3–4 种造型变体），支持拟岩砂岩 / 比赛流线 / 几何切面三大流派',
      '新增「口袋点 (Pocket)」，接入「双纹理 Dual-Tex（光滑禁区严格锁角）」与「拇指扣（+7%抓力/+10°容错）」物理联动',
      '升级 4 种立体大造型（斜棱锥 / 梯形脊 / 菱形台 / 玻璃钢圆弧 Macro）与真实螺栓/双木螺丝细节',
      '建立 SemVer 版本管理体系、Git Tag 里程碑与应用内版本日志弹窗',
    ],
  },
  {
    version: '1.3.1',
    date: '2026-11-20',
    title: 'V1–V11 难度重校准（修复 V4/V5 偏软）',
    highlights: [
      '修复求解器双飞跳点导致的评分虚高，V4/V5 彻底移除大把手并进入真实 15°–25° 仰角与高体能门槛',
      '收紧双飞滞空冲击抓停阈值与开门失衡/发力偏角容错，杜绝低指力双飞逃课 V8',
      '重塑 V4 飞跃峡谷、V5 身高分水岭与 V6 圆弧平衡台预设线路',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-11-20',
    title: 'V1–V11 真实难度体系 & 3D Kilter 倾角墙',
    highlights: [
      '升级真实 Hueco V1–V11 难度体系、微抠点（Micro-crimp）及 V9/V11 高阶攀岩者预设',
      '支持 -10° 平衡板至 +55° 极陡屋檐实时调角与动态定级（Kilter 模式）',
      '实现 3D 透视梯形墙面、电动液压撑杆、侧面倾角剖面仪与屋檐立体投影',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-11-19',
    title: '移动端适配、缩放平移 & 物理拟真优化',
    highlights: [
      '全新移动端底部拇指操作栏、抽屉面板与双指缩放/拖拽平移',
      '校准 Dyno 真人抛物线起跳包络、脚点微抠条件与无重叠随机定线',
      '接入 GitHub Pages 自动构建与持续部署',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-11-19',
    title: '2.5D 逆向运动学 & 完整动态动作系统',
    highlights: [
      '实现 2.5D 透视缩短 IK 与人体肢体防穿模/防过度交叉约束',
      '新增无点踩墙（Smear）、悬空配重（Flag）、单手动态与双手齐飞（Double Dyno）切脚摆荡动画',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-11-19',
    title: 'BETA 抱石台首发版本',
    highlights: [
      '上线定线设置、Beta 规划、物理模拟演练三大模式与 AI Beam-Search 自动解题',
      '支持身高、猿猴指数、指力与柔韧度自定义及经典抱石预设线路',
    ],
  },
];
