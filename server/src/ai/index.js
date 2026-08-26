import { HeuristicProvider } from './providers/heuristic.js';
import { LlmProvider } from './providers/llm.js';

// Modular provider selection. Default = free heuristic engine.
// Set AI_PROVIDER=llm (+ LLM_* env) to layer an LLM over the same numbers.
const providers = { heuristic: HeuristicProvider, llm: LlmProvider };
export const provider = providers[process.env.AI_PROVIDER] || HeuristicProvider;
