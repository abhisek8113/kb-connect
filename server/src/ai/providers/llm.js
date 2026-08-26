// ============================================================================
// LlmProvider — pluggable slot for a real LLM (kept OFF by default so the system
// stays 100% free/open-source out of the box). Implements the same interface as
// HeuristicProvider. Point it at any OpenAI-compatible endpoint — including free
// self-hosted ones like Ollama (llama3), LM Studio, or vLLM — via env vars.
//
//   AI_PROVIDER=llm
//   LLM_BASE_URL=http://localhost:11434/v1     (Ollama example)
//   LLM_MODEL=llama3
//   LLM_API_KEY=                               (blank for local)
//
// The heuristic engine is always used as the numeric backbone; the LLM only
// rewrites the human-readable summary/plan so scores stay deterministic and
// explainable. This keeps "the human in charge" and avoids hallucinated numbers.
// ============================================================================
import { HeuristicProvider } from './heuristic.js';

export const LlmProvider = {
  name: 'llm',

  async analyzeStudent(data) {
    // Deterministic scores from the heuristic engine (never let the LLM invent numbers).
    const base = HeuristicProvider.analyzeStudent(data);
    const base_provider = base.provider; base.provider = this.name;

    const baseUrl = process.env.LLM_BASE_URL;
    if (!baseUrl) return base; // no endpoint configured → graceful fallback

    try {
      const prompt = buildPrompt(base, data);
      const res = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json',
          ...(process.env.LLM_API_KEY ? { authorization: 'Bearer ' + process.env.LLM_API_KEY } : {}) },
        body: JSON.stringify({
          model: process.env.LLM_MODEL || 'llama3',
          temperature: 0.3,
          messages: [
            { role: 'system', content: 'You are a supportive tutor assistant. Rewrite the given analysis as a warm, specific summary for a student. Do NOT change any numbers. 3-4 sentences.' },
            { role: 'user', content: prompt },
          ],
        }),
      });
      const j = await res.json();
      const text = j.choices?.[0]?.message?.content?.trim();
      if (text) base.summary = text;
    } catch (e) {
      // Any LLM failure falls back to the deterministic summary — system never breaks.
      console.warn('LLM summary failed, using heuristic summary:', e.message);
      base.provider = base_provider;
    }
    return base;
  },

  weeklyHeadline(insight, data) { return HeuristicProvider.weeklyHeadline(insight, data); },
};

function buildPrompt(base, data) {
  return [
    `Student class: ${data.student.std || 'n/a'}, board: ${data.student.board || 'n/a'}.`,
    `Readiness: ${base.readiness_score}% (${base.risk_level} risk).`,
    `Weak topics: ${base.weak_topics.map(w => `${w.subject}/${w.topic} ${w.accuracy}%`).join(', ') || 'none'}.`,
    `Silly-mistake share: ${Math.round(base.silly_rate * 100)}%.`,
    `Keep every number identical. Encourage without inflating.`,
  ].join('\n');
}
