import { FreeContact, FreeLimbMap, LimbAssignment, LimbId, LimbTarget, Vec2 } from './types';

export function emptyFreeMap(): FreeLimbMap {
  return { lh: null, rh: null, lf: null, rf: null };
}

export function cloneFreeMap(free: FreeLimbMap): FreeLimbMap {
  return {
    lh: free.lh ? { ...free.lh } : null,
    rh: free.rh ? { ...free.rh } : null,
    lf: free.lf ? { ...free.lf } : null,
    rf: free.rf ? { ...free.rf } : null,
  };
}

export function holdTarget(holdId: string): LimbTarget {
  return { kind: 'hold', holdId };
}

export function smearTarget(x: number, y: number): LimbTarget {
  return { kind: 'smear', x, y };
}

export function flagTarget(x: number, y: number): LimbTarget {
  return { kind: 'flag', x, y };
}

export function freeFromTarget(target: LimbTarget): FreeContact | null {
  if (target.kind === 'hold') return null;
  return { mode: target.kind, x: target.x!, y: target.y! };
}

export function targetLabel(target: LimbTarget, holdLabel?: number): string {
  if (target.kind === 'hold') return holdLabel != null ? `#${holdLabel}` : '岩点';
  if (target.kind === 'smear') return '踩墙/蹭墙';
  return '悬空配重';
}

/**
 * Apply a planned limb target onto assignment + free-contact maps.
 */
export function applyLimbTarget(
  assignment: LimbAssignment,
  free: FreeLimbMap,
  limb: LimbId,
  target: LimbTarget
): { assignment: LimbAssignment; free: FreeLimbMap } {
  const nextAssign = { ...assignment };
  const nextFree = cloneFreeMap(free);

  if (target.kind === 'hold') {
    nextAssign[limb] = target.holdId!;
    nextFree[limb] = null;
  } else {
    nextAssign[limb] = null;
    nextFree[limb] = { mode: target.kind, x: target.x!, y: target.y! };
  }

  return { assignment: nextAssign, free: nextFree };
}

/**
 * Detach a limb (for transition support pose) while keeping other contacts.
 */
export function detachLimb(
  assignment: LimbAssignment,
  free: FreeLimbMap,
  limb: LimbId
): { assignment: LimbAssignment; free: FreeLimbMap } {
  return {
    assignment: { ...assignment, [limb]: null },
    free: { ...cloneFreeMap(free), [limb]: null },
  };
}

/**
 * Build overrideLimbPos for IK from smear/flag free contacts (and optional moving limb).
 */
export function freeOverrides(
  free: FreeLimbMap,
  extra?: Partial<Record<LimbId, Vec2>>
): Partial<Record<LimbId, Vec2>> {
  const out: Partial<Record<LimbId, Vec2>> = {};
  for (const limb of ['lh', 'rh', 'lf', 'rf'] as LimbId[]) {
    if (extra && extra[limb]) {
      out[limb] = extra[limb];
    } else if (free[limb]) {
      out[limb] = { x: free[limb]!.x, y: free[limb]!.y };
    }
  }
  return out;
}

export function getLimbWorldPos(
  limb: LimbId,
  assignment: LimbAssignment,
  free: FreeLimbMap,
  holdMap: Map<string, { x: number; y: number }>
): Vec2 | null {
  const hid = assignment[limb];
  if (hid) {
    const h = holdMap.get(hid);
    return h ? { x: h.x, y: h.y } : null;
  }
  if (free[limb]) return { x: free[limb]!.x, y: free[limb]!.y };
  return null;
}

/** True if limb is providing wall contact (hold or smear). Flag does not count. */
export function isSupportingLimb(assignment: LimbAssignment, free: FreeLimbMap, limb: LimbId): boolean {
  if (assignment[limb]) return true;
  return free[limb]?.mode === 'smear';
}

export function supportingLimbs(
  assignment: LimbAssignment,
  free: FreeLimbMap,
  limbs: LimbId[]
): LimbId[] {
  return limbs.filter((l) => isSupportingLimb(assignment, free, l));
}
