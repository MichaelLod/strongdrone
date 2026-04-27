import type { Action, Agent, AgentContext } from '../types';

export function createKeyboardAgent(): Agent {
  const keys = new Set<string>();

  window.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  return {
    decide(_ctx: AgentContext): Action {
      const SPEED = 4;
      let vx = 0;
      let vy = 0;
      let vz = 0;

      if (keys.has('w') || keys.has('arrowup')) vz -= SPEED;
      if (keys.has('s') || keys.has('arrowdown')) vz += SPEED;
      if (keys.has('a') || keys.has('arrowleft')) vx -= SPEED;
      if (keys.has('d') || keys.has('arrowright')) vx += SPEED;
      if (keys.has(' ')) vy += SPEED;
      if (keys.has('shift')) vy -= SPEED;

      if (vx === 0 && vy === 0 && vz === 0) {
        return { type: 'hover' };
      }
      return { type: 'velocity', v: { x: vx, y: vy, z: vz } };
    },
  };
}
