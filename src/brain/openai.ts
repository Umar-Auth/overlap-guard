import { config } from '../config';

function extractResponseText(payload: any) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const parts = payload?.output
    ?.flatMap((item: any) => item?.content ?? [])
    ?.filter((item: any) => item?.type === 'output_text')
    ?.map((item: any) => item.text?.trim())
    ?.filter(Boolean);

  return parts?.join('\n\n') || '';
}

function extractJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}$/);
    if (!match) {
      throw new Error('No JSON object found in model output');
    }

    return JSON.parse(match[0]);
  }
}

async function requestOpenAI(model: string, messages: Array<{ role: 'system' | 'user'; text: string }>) {
  if (!config.openAiApiKey) {
    throw new Error('OPENAI_API_KEY missing');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openAiApiKey}`,
    },
    body: JSON.stringify({
      model,
      input: messages.map(message => ({
        role: message.role,
        content: [{ type: 'input_text', text: message.text }],
      })),
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with ${response.status}`);
  }

  return response.json();
}

export async function generateText(model: string, systemPrompt: string, userPrompt: string) {
  const payload = await requestOpenAI(model, [
    { role: 'system', text: systemPrompt },
    { role: 'user', text: userPrompt },
  ]);

  return extractResponseText(payload);
}

export async function generateJson<T>(model: string, systemPrompt: string, userPrompt: string) {
  const text = await generateText(model, systemPrompt, userPrompt);
  return extractJson(text) as T;
}
