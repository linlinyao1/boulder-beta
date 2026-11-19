import { renumberHolds } from './holds';
import { Hold, RouteProblem } from './types';

function makeHold(
  id: string,
  x: number,
  y: number,
  type: Hold['type'],
  role: Hold['role'],
  angle: number,
  scale: number,
  color: string
): Hold {
  return { id, label: 0, x, y, type, role, angle, scale, color };
}

export const PRESET_ROUTES: RouteProblem[] = [
  {
    id: 'preset-v1-ladder',
    name: '阶梯热身线',
    grade: 'V1',
    description: '宽大把手与清晰脚点，适合熟悉四肢交替与重心转移的基础 Beta。',
    holdColor: '#238C6B',
    holds: renumberHolds([
      makeHold('v1-f1', 155, 42, 'foothold', 'normal', 0, 1.15, '#238C6B'),
      makeHold('v1-f2', 235, 48, 'foothold', 'normal', 0, 1.15, '#238C6B'),
      makeHold('v1-s1', 160, 128, 'jug', 'start', 0, 1.15, '#238C6B'),
      makeHold('v1-s2', 228, 134, 'jug', 'start', 0, 1.15, '#238C6B'),
      makeHold('v1-f3', 180, 102, 'foothold', 'normal', 0, 1.1, '#238C6B'),
      makeHold('v1-h1', 142, 200, 'jug', 'normal', -15, 1.1, '#238C6B'),
      makeHold('v1-f4', 220, 168, 'foothold', 'normal', 0, 1.05, '#238C6B'),
      makeHold('v1-h2', 238, 245, 'jug', 'normal', 15, 1.1, '#238C6B'),
      makeHold('v1-f5', 166, 232, 'foothold', 'normal', 0, 1.05, '#238C6B'),
      makeHold('v1-h3', 175, 312, 'pinch', 'normal', -10, 1.1, '#238C6B'),
      makeHold('v1-f6', 226, 285, 'foothold', 'normal', 0, 1.05, '#238C6B'),
      makeHold('v1-top', 206, 384, 'jug', 'top', 0, 1.25, '#238C6B'),
    ]),
  },
  {
    id: 'preset-v3-sidepull',
    name: '侧拉横移之舞',
    grade: 'V3',
    description: '包含左右侧拉点与大造型踩脚，考验防开门（Barn-door）的对侧脚法。',
    holdColor: '#2B6CB0',
    holds: renumberHolds([
      makeHold('v3-f1', 96, 46, 'foothold', 'normal', 0, 1.05, '#2B6CB0'),
      makeHold('v3-f2', 162, 56, 'foothold', 'normal', 0, 1.05, '#2B6CB0'),
      makeHold('v3-s1', 118, 138, 'jug', 'start', -25, 1.1, '#2B6CB0'),
      makeHold('v3-s2', 178, 148, 'pinch', 'start', 20, 1.05, '#2B6CB0'),
      makeHold('v3-vol', 154, 194, 'volume', 'normal', -10, 1.0, '#3D434C'),
      makeHold('v3-h1', 236, 214, 'pinch', 'normal', 65, 1.05, '#2B6CB0'),
      makeHold('v3-f3', 214, 136, 'foothold', 'normal', 0, 1.0, '#2B6CB0'),
      makeHold('v3-h2', 298, 258, 'crimp', 'normal', 55, 1.0, '#2B6CB0'),
      makeHold('v3-f4', 274, 178, 'foothold', 'normal', 0, 1.0, '#2B6CB0'),
      makeHold('v3-h3', 222, 316, 'jug', 'normal', -45, 1.08, '#2B6CB0'),
      makeHold('v3-f5', 292, 224, 'foothold', 'normal', 0, 0.95, '#2B6CB0'),
      makeHold('v3-f6', 230, 266, 'foothold', 'normal', 0, 1.0, '#2B6CB0'),
      makeHold('v3-top', 176, 392, 'jug', 'top', 0, 1.2, '#2B6CB0'),
    ]),
  },
  {
    id: 'preset-v4-dyno',
    name: '飞跃峡谷 Dyno',
    grade: 'V4',
    description: '专为动态飞跃设计：底部大把手双脚深蹲蓄力，用「单手飞跃 (D)」或「双飞 (G)」飞抓中段大把手，切脚摆荡后再上脚直冲完攀点！',
    holdColor: '#6B4E9B',
    holds: renumberHolds([
      makeHold('vd-f1', 124, 52, 'foothold', 'normal', 0, 1.15, '#6B4E9B'),
      makeHold('vd-f2', 194, 62, 'foothold', 'normal', 0, 1.15, '#6B4E9B'),
      makeHold('vd-s1', 128, 134, 'jug', 'start', -12, 1.2, '#6B4E9B'),
      makeHold('vd-s2', 186, 138, 'jug', 'start', 12, 1.2, '#6B4E9B'),
      // Mid-wall catch jug after a dramatic diagonal Dyno gap!
      makeHold('vd-catch', 262, 266, 'jug', 'normal', 10, 1.32, '#6B4E9B'),
      // Recovery footholds below the catch jug after cutting feet
      makeHold('vd-f3', 214, 152, 'foothold', 'normal', 0, 1.1, '#6B4E9B'),
      makeHold('vd-f4', 286, 168, 'foothold', 'normal', 0, 1.1, '#6B4E9B'),
      makeHold('vd-f5', 246, 224, 'foothold', 'normal', 0, 1.05, '#6B4E9B'),
      makeHold('vd-vol', 184, 304, 'volume', 'normal', -10, 1.05, '#3D434C'),
      // Final dynamic or static reach to TOP
      makeHold('vd-top', 214, 398, 'jug', 'top', 0, 1.28, '#6B4E9B'),
    ]),
  },
  {
    id: 'preset-v5-morpho',
    name: '身高分水岭',
    grade: 'V5',
    description: '长臂选手可以直接大跨距跨点直上；小个子则需要利用高脚踩中间抠点与动态飞跃破解。切换体型体验截然不同的 Beta！',
    holdColor: '#D6453A',
    holds: renumberHolds([
      makeHold('v5-f1', 142, 42, 'foothold', 'normal', 0, 1.0, '#D6453A'),
      makeHold('v5-f2', 228, 48, 'foothold', 'normal', 0, 1.0, '#D6453A'),
      makeHold('v5-s1', 184, 130, 'pinch', 'start', 0, 1.1, '#D6453A'),
      makeHold('v5-f3', 132, 114, 'foothold', 'normal', 0, 0.95, '#D6453A'),
      makeHold('v5-f4', 248, 128, 'foothold', 'normal', 0, 0.95, '#D6453A'),
      // Intermediate crimp especially helpful for shorter climbers
      makeHold('v5-mid1', 142, 198, 'crimp', 'normal', -20, 0.95, '#D6453A'),
      // Big reach target right-high (tall climbers can reach straight from start + high foot!)
      makeHold('v5-big1', 252, 244, 'jug', 'normal', 25, 1.08, '#D6453A'),
      makeHold('v5-f5', 186, 174, 'foothold', 'normal', 0, 0.92, '#D6453A'),
      makeHold('v5-f6', 258, 192, 'foothold', 'normal', 0, 0.92, '#D6453A'),
      // Upper crux: small crimp left-mid + high sloper/top
      makeHold('v5-mid2', 164, 294, 'crimp', 'normal', -30, 0.95, '#D6453A'),
      makeHold('v5-f7', 214, 258, 'foothold', 'normal', 0, 0.9, '#D6453A'),
      makeHold('v5-h3', 238, 336, 'pinch', 'normal', 20, 1.0, '#D6453A'),
      makeHold('v5-f8', 158, 280, 'foothold', 'normal', 0, 0.9, '#D6453A'),
      makeHold('v5-top', 194, 404, 'jug', 'top', 0, 1.15, '#D6453A'),
    ]),
  },
  {
    id: 'preset-v6-sloper',
    name: '圆弧平衡台',
    grade: 'V6',
    description: '连环圆弧点与大造型，必须精准把重心压在圆弧点正下方，并巧用反提与换脚。',
    holdColor: '#D99B26',
    holds: renumberHolds([
      makeHold('v6-f1', 138, 44, 'foothold', 'normal', 0, 1.0, '#D99B26'),
      makeHold('v6-f2', 242, 52, 'foothold', 'normal', 0, 1.0, '#D99B26'),
      makeHold('v6-s1', 158, 134, 'sloper', 'start', -12, 1.08, '#D99B26'),
      makeHold('v6-s2', 226, 140, 'pinch', 'start', 18, 1.0, '#D99B26'),
      makeHold('v6-f3', 192, 118, 'foothold', 'normal', 0, 0.95, '#D99B26'),
      makeHold('v6-h1', 132, 214, 'sloper', 'normal', -15, 1.08, '#D99B26'),
      makeHold('v6-vol1', 218, 198, 'volume', 'normal', 10, 1.05, '#3D434C'),
      makeHold('v6-h2', 256, 266, 'sloper', 'normal', 15, 1.08, '#D99B26'),
      makeHold('v6-f4', 154, 186, 'foothold', 'normal', 0, 0.92, '#D99B26'),
      makeHold('v6-f5', 268, 206, 'foothold', 'normal', 0, 0.92, '#D99B26'),
      makeHold('v6-h3', 176, 326, 'crimp', 'normal', -15, 0.96, '#D99B26'),
      makeHold('v6-f6', 206, 272, 'foothold', 'normal', 0, 0.92, '#D99B26'),
      makeHold('v6-h4', 248, 354, 'sloper', 'normal', 12, 1.05, '#D99B26'),
      makeHold('v6-top', 202, 412, 'jug', 'top', 0, 1.15, '#D99B26'),
    ]),
  },
];
