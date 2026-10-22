// Chat models users may pick from. They must exist on the configured gateway and support
// tool calling. Override with YARA_MODELS="id:Label,id:Label" (first entry is the default
// unless LIARA_AI_MODEL is set).
const LIARA_AI_DEFAULTS = [
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5" },
  { id: "openai/gpt-5.4-mini", label: "GPT-5.4 mini" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
];

export type ModelOption = { id: string; label: string };

function parse(raw: string | undefined): ModelOption[] | null {
  if (!raw?.trim()) return null;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, ...rest] = entry.split(":");
      return { id: id.trim(), label: rest.join(":").trim() || id.trim() };
    });
  return list.length ? list : null;
}

export const MODELS: ModelOption[] = parse(process.env.YARA_MODELS) ?? LIARA_AI_DEFAULTS;
export const DEFAULT_MODEL = process.env.LIARA_AI_MODEL || MODELS[0].id;
