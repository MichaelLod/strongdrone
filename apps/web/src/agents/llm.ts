import Anthropic from '@anthropic-ai/sdk';
import type { ByokySession } from '@byoky/sdk';
import type { Action, Agent, AgentContext } from '../types';

const SYSTEM_PROMPT = `You are an autonomous quadcopter pilot in a simulated 3D world.

Coordinates: +X east, +Z south, +Y up. Gravity points -Y.
Each turn you receive the drone's current state and the next gate to fly through.
Issue ONE tool call per turn. The action runs for 0.5 s of sim time, then you'll get a fresh observation.

Strategy:
- Use \`goto\` to fly directly toward the target gate.
- Use \`velocity\` for fine corrections near a gate.
- Stay above y=0.3 — touching the ground crashes you.
- Autopilot top speed is 5 m/s.
- Do not narrate. Tool call only.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'velocity',
    description: 'Fly at a constant velocity vector in the world frame (m/s).',
    input_schema: {
      type: 'object',
      properties: {
        vx: { type: 'number', description: 'east velocity' },
        vy: { type: 'number', description: 'up velocity' },
        vz: { type: 'number', description: 'south velocity' },
      },
      required: ['vx', 'vy', 'vz'],
    },
  },
  {
    name: 'goto',
    description: 'Fly toward an absolute world position. Autopilot caps speed at 5 m/s.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
      },
      required: ['x', 'y', 'z'],
    },
  },
  {
    name: 'hover',
    description: 'Maintain current position.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'land',
    description: 'Slowly descend.',
    input_schema: { type: 'object', properties: {} },
  },
];

export type LlmAgentOptions = {
  session: ByokySession;
  model?: string;
};

export function createLlmAgent({ session, model = 'claude-sonnet-4-6' }: LlmAgentOptions): Agent {
  const client = new Anthropic({
    apiKey: session.sessionKey,
    fetch: session.createFetch('anthropic'),
    dangerouslyAllowBrowser: true,
  });

  return {
    async decide(ctx: AgentContext): Promise<Action> {
      try {
        const response = await client.messages.create({
          model,
          max_tokens: 256,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          tool_choice: { type: 'any' },
          messages: [{ role: 'user', content: buildUserMessage(ctx) }],
        });

        const toolUse = response.content.find(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
        );
        if (!toolUse) {
          console.warn('LLM returned no tool use; hovering. content:', response.content);
          return { type: 'hover' };
        }
        return parseAction(toolUse);
      } catch (err) {
        console.error('LLM decide failed:', err);
        return { type: 'hover' };
      }
    },
  };
}

function buildUserMessage(ctx: AgentContext): string {
  const { observation: obs, scenarioState: sc, gates } = ctx;
  const f = (n: number) => n.toFixed(2);
  const target = gates[sc.currentGate];
  const upcoming = gates.slice(sc.currentGate + 1);

  return [
    `Drone state:`,
    `  position  x=${f(obs.position.x)} y=${f(obs.position.y)} z=${f(obs.position.z)}`,
    `  velocity  vx=${f(obs.velocity.x)} vy=${f(obs.velocity.y)} vz=${f(obs.velocity.z)}`,
    ``,
    `Mission:`,
    target
      ? `  next gate ${sc.currentGate + 1}/${sc.totalGates}: x=${f(target.x)} y=${f(target.y)} z=${f(target.z)} (touch within 0.8 m)`
      : `  all gates cleared`,
    upcoming.length
      ? `  upcoming: ${upcoming.map((g) => `(${f(g.x)},${f(g.y)},${f(g.z)})`).join(' ')}`
      : `  upcoming: (none)`,
    `  elapsed   ${f(sc.elapsedSimTime)} s`,
    ``,
    `Pick one action.`,
  ].join('\n');
}

function parseAction(toolUse: Anthropic.ToolUseBlock): Action {
  const input = toolUse.input as Record<string, unknown>;
  const num = (k: string) => (typeof input[k] === 'number' ? (input[k] as number) : 0);

  switch (toolUse.name) {
    case 'velocity':
      return { type: 'velocity', v: { x: num('vx'), y: num('vy'), z: num('vz') } };
    case 'goto':
      return { type: 'goto', target: { x: num('x'), y: num('y'), z: num('z') } };
    case 'hover':
      return { type: 'hover' };
    case 'land':
      return { type: 'land' };
    default:
      console.warn('Unknown tool:', toolUse.name);
      return { type: 'hover' };
  }
}
