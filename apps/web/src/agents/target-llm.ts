import { generateText, tool, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import type { ByokySession } from '@byoky/sdk';
import type { Vec3 } from '../types';

// Hostile target drone agent. Each target picks its own velocity per decision
// turn — a thinner contract than the player agent (no goto / land), since
// targets only need to dodge.

const SYSTEM_PROMPT = `You are a hostile reconnaissance drone trying to evade an incoming hunter drone.

Coordinates: +X east, +Z south, +Y up. Gravity points -Y.
Goal: stay alive. The hunter wins by closing within 1.0 m of you.

Constraints:
- Top speed 1.6 m/s in any axis.
- Stay between y=1.0 and y=4.0. Below 1.0 m = ground crash.
- Stay within 6 m of your home position.

Strategy:
- Watch the hunter's velocity vector. Dodge perpendicular to their approach, not straight away.
- Vary altitude to make their dive harder.
- Don't sit still; constant movement is harder to intercept.

Output ONE velocity tool call (vx, vy, vz) per turn. No narration.`;

const TOOLS = {
  velocity: tool({
    description: 'Fly at this constant velocity (m/s) in world frame until your next decision.',
    inputSchema: z.object({
      vx: z.number().describe('east velocity'),
      vy: z.number().describe('up velocity'),
      vz: z.number().describe('south velocity'),
    }),
  }),
};

export type TargetObs = {
  myPos: Vec3;
  myVel: Vec3;
  threatPos: Vec3;
  threatVel: Vec3;
  homePos: Vec3;
  elapsedTime: number;
};

export type TargetAction = { vx: number; vy: number; vz: number };

export type TargetAgent = {
  decide(obs: TargetObs): Promise<TargetAction>;
};

export type TargetLlmAgentOptions = {
  session: ByokySession;
  providerId: string;
  modelId: string;
};

export function createTargetLlmAgent({ session, providerId, modelId }: TargetLlmAgentOptions): TargetAgent {
  const model = buildModel(session, providerId, modelId);
  return {
    async decide(obs: TargetObs): Promise<TargetAction> {
      try {
        const result = await generateText({
          model,
          system: SYSTEM_PROMPT,
          prompt: buildUserMessage(obs),
          tools: TOOLS,
          toolChoice: 'required',
          maxOutputTokens: 96,
        });
        const call = result.toolCalls[0];
        if (!call) return { vx: 0, vy: 0, vz: 0 };
        const args = call.input as Record<string, unknown>;
        const num = (k: string) => (typeof args[k] === 'number' ? (args[k] as number) : 0);
        return { vx: num('vx'), vy: num('vy'), vz: num('vz') };
      } catch (err) {
        console.warn('Target LLM decide failed:', err);
        return { vx: 0, vy: 0, vz: 0 };
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
      throw new Error(`Provider "${providerId}" is not supported by the target AI adapter.`);
  }
}

function buildUserMessage(obs: TargetObs): string {
  const f = (n: number) => n.toFixed(2);
  const dx = obs.threatPos.x - obs.myPos.x;
  const dy = obs.threatPos.y - obs.myPos.y;
  const dz = obs.threatPos.z - obs.myPos.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return [
    `Your state:`,
    `  position  x=${f(obs.myPos.x)} y=${f(obs.myPos.y)} z=${f(obs.myPos.z)}`,
    `  velocity  vx=${f(obs.myVel.x)} vy=${f(obs.myVel.y)} vz=${f(obs.myVel.z)}`,
    `  home base x=${f(obs.homePos.x)} y=${f(obs.homePos.y)} z=${f(obs.homePos.z)}`,
    ``,
    `Hunter drone:`,
    `  position  x=${f(obs.threatPos.x)} y=${f(obs.threatPos.y)} z=${f(obs.threatPos.z)}`,
    `  velocity  vx=${f(obs.threatVel.x)} vy=${f(obs.threatVel.y)} vz=${f(obs.threatVel.z)}`,
    `  distance  ${f(dist)} m`,
    ``,
    `Pick one velocity. Stay alive.`,
  ].join('\n');
}
