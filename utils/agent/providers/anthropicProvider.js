const Anthropic = require('@anthropic-ai/sdk');

async function consumeAnthropicStream(stream, { onTextDelta, aborted }) {
  const contentBlocks = [];
  let stopReason = null;
  let inputTokens = 0;
  let outputTokens = 0;

  let currentBlockType = null;
  let currentBlockText = '';
  let currentToolInput = '';
  let currentToolId = '';
  let currentToolName = '';
  let hasToolUse = false;

  for await (const event of stream) {
    if (aborted()) break;

    switch (event.type) {
      case 'message_start':
        inputTokens = event.message?.usage?.input_tokens || 0;
        break;
      case 'content_block_start':
        currentBlockType = event.content_block.type;
        currentBlockText = '';
        currentToolInput = '';
        if (currentBlockType === 'tool_use') {
          hasToolUse = true;
          currentToolId = event.content_block.id;
          currentToolName = event.content_block.name;
        }
        break;
      case 'content_block_delta':
        if (event.delta.type === 'text_delta') {
          currentBlockText += event.delta.text;
          if (!hasToolUse && !aborted()) onTextDelta(event.delta.text);
        } else if (event.delta.type === 'input_json_delta') {
          currentToolInput += event.delta.partial_json;
        }
        break;
      case 'content_block_stop':
        if (currentBlockType === 'text') {
          contentBlocks.push({ type: 'text', text: currentBlockText });
        } else if (currentBlockType === 'tool_use') {
          let parsedInput = {};
          try { parsedInput = JSON.parse(currentToolInput); } catch {}
          contentBlocks.push({
            type: 'tool_use',
            id: currentToolId,
            name: currentToolName,
            input: parsedInput,
          });
        }
        currentBlockType = null;
        break;
      case 'message_delta':
        stopReason = event.delta?.stop_reason || stopReason;
        outputTokens = event.usage?.output_tokens || outputTokens;
        break;
    }
  }

  return {
    content: contentBlocks,
    stop_reason: stopReason,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

class AnthropicProvider {
  constructor() {
    this.client = new Anthropic();
    this._validated = null;
  }

  async validate() {
    if (this._validated !== null) return this._validated;
    try {
      const resp = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
        },
      });
      this._validated = resp.ok;
    } catch {
      this._validated = false;
    }
    return this._validated;
  }

  async createResponse({ model, maxTokens, system, messages, tools, toolChoice, onTextDelta, aborted }) {
    const params = {
      model,
      max_tokens: maxTokens,
      system,
      messages,
      tools,
      stream: true,
    };

    // See docs/AGENT_SYNTHESIS_PASS.md. Claude's tool_choice is the object
    // form ({ type: 'none' | 'auto' | 'any' | { type: 'tool', name } }), not
    // the OpenAI string form. Map the cross-provider 'none' signal here.
    if (toolChoice === 'none') {
      params.tool_choice = { type: 'none' };
    }

    const stream = await this.client.messages.create(params);
    return consumeAnthropicStream(stream, { onTextDelta, aborted });
  }
}

module.exports = AnthropicProvider;
