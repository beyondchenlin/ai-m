// src/lib/ai/bailian-agent.ts

// ── 百炼 Agent API 调用 ─────────────────────────────────────────────

interface BailianAgentConfig {
  appId: string;
  apiKey: string;
}

interface BailianResponse {
  status_code?: number;
  output?: { text?: string; finish_reason?: string };
  code?: string;
  message?: string;
}

export async function callBailianAgent(
  config: BailianAgentConfig,
  prompt: string,
): Promise<string> {
  const url = `https://dashscope.aliyuncs.com/api/v1/apps/${config.appId}/completion`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      input: { prompt },
      parameters: {},
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`百炼智能体请求失败: ${res.status} ${errText.slice(0, 300)}`);
  }

  const json = (await res.json()) as BailianResponse;

  if (json.code) {
    throw new Error(`百炼智能体错误 [${json.code}]: ${json.message ?? "unknown"}`);
  }

  const text = json.output?.text;
  if (!text) {
    throw new Error("百炼智能体返回为空");
  }

  return text;
}

// ── JSON 提取 ───────────────────────────────────────────────────────

function extractJSON(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  const jsonMatch = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (jsonMatch) return jsonMatch[1].trim();

  return text.trim();
}

// ── Schema 校验 ─────────────────────────────────────────────────────

export type AgentCategory = "script_outline" | "script_parse" | "character_extract" | "shot_split";

export function validateAgentOutput(category: AgentCategory, rawText: string): unknown {
  const jsonStr = extractJSON(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `智能体返回的内容不是有效 JSON。请在百炼平台修改智能体的输出格式。\n原始返回: ${rawText.slice(0, 500)}`,
    );
  }

  switch (category) {
    case "script_outline":
      return validateScriptOutline(parsed);
    case "script_parse":
      return validateScriptParse(parsed);
    case "character_extract":
      return validateCharacterExtract(parsed);
    case "shot_split":
      return validateShotSplit(parsed);
  }
}

function assertField(obj: Record<string, unknown>, field: string, type: string, context: string) {
  if (!(field in obj) || obj[field] === undefined || obj[field] === null) {
    throw new Error(`智能体输出缺少必填字段 "${field}"（${context}）`);
  }
  if (type === "string" && typeof obj[field] !== "string") {
    throw new Error(`智能体输出字段 "${field}" 应为字符串类型（${context}）`);
  }
  if (type === "number" && typeof obj[field] !== "number") {
    throw new Error(`智能体输出字段 "${field}" 应为数字类型（${context}）`);
  }
  if (type === "array" && !Array.isArray(obj[field])) {
    throw new Error(`智能体输出字段 "${field}" 应为数组类型（${context}）`);
  }
}

function validateScriptOutline(parsed: unknown): { outline: string } {
  if (typeof parsed === "string") {
    return { outline: parsed };
  }
  const obj = parsed as Record<string, unknown>;
  assertField(obj, "outline", "string", "script_outline");
  return { outline: obj.outline as string };
}

function validateScriptParse(parsed: unknown): unknown {
  const obj = parsed as Record<string, unknown>;
  assertField(obj, "title", "string", "script_parse");
  assertField(obj, "synopsis", "string", "script_parse");
  assertField(obj, "scenes", "array", "script_parse");
  const scenes = obj.scenes as Array<Record<string, unknown>>;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    assertField(s, "sceneNumber", "number", `script_parse.scenes[${i}]`);
    assertField(s, "setting", "string", `script_parse.scenes[${i}]`);
    assertField(s, "description", "string", `script_parse.scenes[${i}]`);
  }
  return parsed;
}

function validateCharacterExtract(parsed: unknown): unknown {
  if (Array.isArray(parsed)) {
    for (let i = 0; i < parsed.length; i++) {
      const c = parsed[i] as Record<string, unknown>;
      assertField(c, "name", "string", `character[${i}]`);
      assertField(c, "description", "string", `character[${i}]`);
    }
    return { characters: parsed };
  }

  const obj = parsed as Record<string, unknown>;
  assertField(obj, "characters", "array", "character_extract");
  const chars = obj.characters as Array<Record<string, unknown>>;
  for (let i = 0; i < chars.length; i++) {
    assertField(chars[i], "name", "string", `characters[${i}]`);
    assertField(chars[i], "description", "string", `characters[${i}]`);
  }
  return parsed;
}

function validateShotSplit(parsed: unknown): unknown {
  if (!Array.isArray(parsed)) {
    throw new Error("智能体输出 shot_split 应为数组类型");
  }
  for (let i = 0; i < parsed.length; i++) {
    const scene = parsed[i] as Record<string, unknown>;
    assertField(scene, "sceneTitle", "string", `scene[${i}]`);
    assertField(scene, "shots", "array", `scene[${i}]`);
    const shots = scene.shots as Array<Record<string, unknown>>;
    for (let j = 0; j < shots.length; j++) {
      assertField(shots[j], "sequence", "number", `scene[${i}].shots[${j}]`);
      assertField(shots[j], "prompt", "string", `scene[${i}].shots[${j}]`);
    }
  }
  return parsed;
}
