import { generateText, tool, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
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

const TOOLS = {
  velocity: tool({
    description: 'Fly at a constant velocity vector in the world frame (m/s).',
    inputSchema: z.object({
      vx: z.number().describe('east velocity'),
      vy: z.number().describe('up velocity'),
      vz: z.number().describe('south velocity'),
    }),
  }),
  goto: tool({
    description: 'Fly toward an absolute world position. Autopilot caps speed at 5 m/s.',
    inputSchema: z.object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
    }),
  }),
  hover: tool({
    description: 'Maintain current position.',
    inputSchema: z.object({}),
  }),
  land: tool({
    description: 'Slowly descend.',
    inputSchema: z.object({}),
  }),
};

export type LlmAgentOptions = {
  session: ByokySession;
  providerId: string;
  modelId: string;
};

export function createLlmAgent({ session, providerId, modelId }: LlmAgentOptions): Agent {
  const model = buildModel(session, providerId, modelId);

  return {
    async decide(ctx: AgentContext): Promise<Action> {
      try {
        const result = await generateText({
          model,
          system: SYSTEM_PROMPT,
          prompt: buildUserMessage(ctx),
          tools: TOOLS,
          toolChoice: 'required',
          maxOutputTokens: 256,
        });

        const call = result.toolCalls[0];
        if (!call) {
          console.warn('LLM returned no tool call; hovering. text:', result.text);
          return { type: 'hover' };
        }
        return parseAction(call.toolName, call.input as Record<string, unknown>);
      } catch (err) {
        console.error('LLM decide failed:', err);
        return { type: 'hover' };
      }
    },
  };
}

function buildModel(session: ByokySession, providerId: string, modelId: string): LanguageModel {
  const fetch = session.createFetch(providerId);
  switch (providerId) {
    case 'anthropic':
      return createAnthropic({ apiKey: session.sessionKey, fetch })(modelId);
    case 'openai':
    case 'groq':
    case 'perplexity':
    case 'together':
    case 'fireworks':
    case 'deepseek':
    case 'xai':
    case 'openrouter':
    case 'mistral':
    case 'azure_openai':
    case 'ollama':
    case 'lm_studio':
      return createOpenAI({ apiKey: session.sessionKey, fetch })(modelId);
    case 'gemini':
      return createGoogleGenerativeAI({ apiKey: session.sessionKey, fetch })(modelId);
    default:
      throw new Error(`Provider "${providerId}" is not supported by the AI SDK adapter yet.`);
  }
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

function parseAction(toolName: string, args: Record<string, unknown>): Action {
  const num = (k: string) => (typeof args[k] === 'number' ? (args[k] as number) : 0);
  switch (toolName) {
    case 'velocity':
      return { type: 'velocity', v: { x: num('vx'), y: num('vy'), z: num('vz') } };
    case 'goto':
      return { type: 'goto', target: { x: num('x'), y: num('y'), z: num('z') } };
    case 'hover':
      return { type: 'hover' };
    case 'land':
      return { type: 'land' };
    default:
      console.warn('Unknown tool:', toolName);
      return { type: 'hover' };
  }
}
