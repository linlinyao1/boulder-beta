import { ClimberAnatomy, ClimberProfile } from './types';

export const CLIMBER_PRESETS: ClimberProfile[] = [
  {
    name: '灵巧小个子',
    heightCm: 156,
    apeIndexCm: 0,
    gripStrength: 96,
    flexibility: 112,
  },
  {
    name: '标准均衡型',
    heightCm: 172,
    apeIndexCm: 2,
    gripStrength: 92,
    flexibility: 92,
  },
  {
    name: '长臂猿选手',
    heightCm: 188,
    apeIndexCm: 10,
    gripStrength: 90,
    flexibility: 80,
  },
  {
    name: '指力力量型',
    heightCm: 176,
    apeIndexCm: 4,
    gripStrength: 114,
    flexibility: 78,
  },
  {
    name: '小学生小岩羊',
    heightCm: 142,
    apeIndexCm: 0,
    gripStrength: 86,
    flexibility: 118,
  },
];

export function computeAnatomy(profile: ClimberProfile): ClimberAnatomy {
  const h = profile.heightCm;
  const wingspan = Math.max(h - 14, h + profile.apeIndexCm);

  const torsoLen = h * 0.305;
  const shoulderHalfW = h * 0.112;
  const hipHalfW = h * 0.082;
  const headRadius = h * 0.062;

  // Wingspan = 2 * shoulderHalfW + 2 * (upperArm + forearm)
  const singleArm = Math.max(40, (wingspan - 2 * shoulderHalfW) / 2);
  const upperArmLen = singleArm * 0.47;
  const forearmLen = singleArm * 0.53;

  const thighLen = h * 0.245;
  const shinLen = h * 0.248;

  // Taller climbers have higher mass (~h^2.05) relative to 172cm baseline,
  // creating a genuine strength-to-weight vs. reach trade-off!
  const weightFactor = Math.pow(h / 172, 2.0);

  return {
    heightCm: h,
    wingspanCm: wingspan,
    torsoLen,
    shoulderHalfW,
    hipHalfW,
    headRadius,
    upperArmLen,
    forearmLen,
    thighLen,
    shinLen,
    maxArmReach: upperArmLen + forearmLen,
    maxLegReach: thighLen + shinLen,
    weightFactor,
  };
}
